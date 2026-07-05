/**
 * 录制引擎模块
 * 使用 Electron 离屏渲染 + FFmpeg 编码实现直播录制
 * 捕获完整的浏览器渲染输出（视频画面 + 弹幕 + 礼物特效）
 */
const { BrowserWindow } = require('electron');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');
const fs = require('fs');
const { generateFileName } = require('./douyin-utils');
const { getConfig } = require('./config');
const { getLogger } = require('./logger');

const logger = getLogger();

// 获取 FFmpeg 可执行文件路径（处理 asar 打包情况）
function getFFmpegPath() {
  let ffmpegPath = ffmpegInstaller.path;
  
  // 在 asar 打包后，二进制文件在 app.asar.unpacked 目录
  if (ffmpegPath.includes('app.asar') && !ffmpegPath.includes('app.asar.unpacked')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
  
  // 验证路径是否存在
  if (!fs.existsSync(ffmpegPath)) {
    logger.error(`FFmpeg 路径不存在: ${ffmpegPath}`);
    // 尝试在应用目录查找
    const appDir = path.dirname(process.execPath);
    const possiblePaths = [
      path.join(appDir, 'resources', 'app.asar.unpacked', 'node_modules', '@ffmpeg-installer', 'ffmpeg'),
      path.join(appDir, 'resources', 'app', 'node_modules', '@ffmpeg-installer', 'ffmpeg')
    ];
    
    for (const p of possiblePaths) {
      try {
        const altPath = require(path.join(p, 'package.json'));
        if (altPath && altPath.path) {
          const resolved = path.resolve(p, altPath.path);
          if (fs.existsSync(resolved)) {
            logger.info(`找到备用 FFmpeg 路径: ${resolved}`);
            return resolved;
          }
        }
      } catch (e) { /* ignore */ }
    }
  }
  
  logger.info(`FFmpeg 路径: ${ffmpegPath}`);
  return ffmpegPath;
}

const ffmpegPath = getFFmpegPath();
ffmpeg.setFfmpegPath(ffmpegPath);

class Recorder {
  constructor(options) {
    this.roomId = options.roomId;
    this.streamerName = options.streamerName || '未知主播';
    this.liveUrl = options.liveUrl;
    this.outputFolder = options.outputFolder;
    this.session = options.session; // Electron session (用于共享登录态)

    this.recording = false;
    this.ffmpegProcess = null;
    this.captureWindow = null;
    this.outputFile = '';
    this.startTime = null;
    this.frameCount = 0;
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || (() => {});
  }

  /**
   * 创建用于捕获的离屏浏览器窗口
   */
  async createCaptureWindow() {
    const config = getConfig();

    // 固定捕获分辨率为 1920x1080 (16:9)
    const CAPTURE_WIDTH = 1920;
    const CAPTURE_HEIGHT = 1080;

    this.captureWindow = new BrowserWindow({
      width: CAPTURE_WIDTH,
      height: CAPTURE_HEIGHT,
      show: false,            // 不显示窗口
      enableLargerThanScreen: true,
      frame: false,           // 无边框
      webPreferences: {
        offscreen: true,      // 启用离屏渲染
        javascript: true,
        plugins: true,
        nodeIntegration: false,
        contextIsolation: true,
        partition: this.session || 'persist:douyin', // 共享登录态
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        // 自动播放视频
        additionalArguments: ['--autoplay-policy=no-user-gesture-required']
      }
    });

    // 设置窗口始终置顶以避免渲染暂停
    this.captureWindow.setAlwaysOnTop(false);

    // 加载直播间页面
    await this.captureWindow.loadURL(this.liveUrl, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });

    // 等待页面完全加载
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 尝试启动视频播放
    await this.tryStartVideoPlayback();

    // 设置最高画质
    await this.setMaxQuality();

    // 关闭弹幕显示
    await this.hideDanmaku();

    // 注入 CSS 防止页面滚动，确保捕获区域固定
    await this.injectNoScrollCSS();

    // 等待 CSS 生效和视频开始播放
    await new Promise(resolve => setTimeout(resolve, 2000));

    return this.captureWindow;
  }

  /**
   * 尝试启动视频播放
   */
  async tryStartVideoPlayback() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 尝试找到视频元素并播放
          const videos = document.querySelectorAll('video');
          for (const video of videos) {
            if (video.paused) {
              video.muted = true; // 静音以允许自动播放
              video.play().catch(() => {});
            }
          }
          
          // 尝试点击播放按钮
          const playBtns = document.querySelectorAll('[class*="play"], [class*="Play"], button[aria-label*="播放"], button[aria-label*="play"]');
          for (const btn of playBtns) {
            btn.click();
          }
        })();
      `);
      logger.info('[Recorder] 已尝试启动视频播放');
    } catch (e) {
      logger.warn('[Recorder] 启动视频播放失败:', e.message);
    }
  }

  /**
   * 关闭直播画面区域的弹幕
   */
  async hideDanmaku() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 方法1: 尝试点击弹幕开关按钮（关闭弹幕）
          const toggleBtns = document.querySelectorAll(
            '[class*="danmu-toggle"], [class*="barrage-toggle"], ' +
            '[class*="danmaku-switch"], [class*="dm-toggle"], ' +
            '[data-e2e="danmaku-switch"], [class*="DanmakuSwitch"]'
          );
          for (const btn of toggleBtns) {
            // 如果弹幕开关是开启状态，点击关闭
            if (btn.checked || btn.classList.contains('active') || btn.classList.contains('on')) {
              btn.click();
            }
          }

          // 方法2: 直接隐藏弹幕相关元素
          const danmakuSelectors = [
            '[class*="danmu"]', '[class*="barrage"]',
            '[class*="Danmu"]', '[class*="Barrage"]',
            '[class*="danmaku"]', '[class*="Danmaku"]',
            'canvas[class*="dm"]', '[class*="dm-container"]'
          ];
          for (const selector of danmakuSelectors) {
            document.querySelectorAll(selector).forEach(el => {
              // 只隐藏视频画面区域内的弹幕，不影响其他功能
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                el.style.display = 'none';
                el.style.visibility = 'hidden';
              }
            });
          }

          // 方法3: 通过 MutationObserver 持续移除动态创建的弹幕元素
          if (window._danmakuObserver) {
            window._danmakuObserver.disconnect();
          }
          window._danmakuObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node.nodeType === 1) {
                  const cls = (node.className || '').toString().toLowerCase();
                  if (cls.includes('danmu') || cls.includes('barrage') || cls.includes('danmaku')) {
                    node.style.display = 'none';
                    node.style.visibility = 'hidden';
                  }
                }
              }
            }
          });
          window._danmakuObserver.observe(document.body, { childList: true, subtree: true });
        })();
      `);
      logger.info('[Recorder] 已关闭弹幕显示');
    } catch (e) {
      logger.warn('[Recorder] 关闭弹幕失败:', e.message);
    }
  }

  /**
   * 注入 CSS 防止页面滚动，确保捕获区域固定
   * 使用 clip 方式确保捕获区域严格限制在视口范围
   */
  async injectNoScrollCSS() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 移除旧样式
          document.querySelectorAll('style[data-recorder]').forEach(s => s.remove());
          
          const style = document.createElement('style');
          style.setAttribute('data-recorder', 'true');
          style.textContent = \`
            /* 严格限制页面尺寸，禁止溢出 */
            html {
              width: 100vw !important;
              height: 100vh !important;
              overflow: hidden !important;
              margin: 0 !important;
              padding: 0 !important;
              border: none !important;
            }
            body {
              width: 100vw !important;
              height: 100vh !important;
              max-height: 100vh !important;
              overflow: hidden !important;
              margin: 0 !important;
              padding: 0 !important;
            }
            /* 隐藏滚动条 */
            ::-webkit-scrollbar { display: none !important; }
            * { scrollbar-width: none !important; }
            /* 关闭直播画面区域的弹幕滚动 */
            [class*="danmu"], [class*="barrage"], [class*="Danmu"], [class*="Barrage"] {
              display: none !important;
              visibility: hidden !important;
              opacity: 0 !important;
              pointer-events: none !important;
            }
            canvas[class*="danmu"], canvas[class*="barrage"] {
              display: none !important;
            }
            /* 隐藏抖音直播弹幕容器 */
            .webcast-chatroom___inner,
            [class*="chat-room"], [class*="chatRoom"],
            [class*="danmaku"], [class*="DanmakuContainer"],
            [data-e2e="danmaku"], [data-e2e="barrage"] {
              display: none !important;
            }
          \`;
          document.head.appendChild(style);
          
          // 强制滚动到顶部
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
          
          // 持续阻止滚动
          if (window._recorderScrollHandler) {
            window.removeEventListener('scroll', window._recorderScrollHandler);
            window.removeEventListener('wheel', window._recorderScrollHandler);
            window.removeEventListener('touchmove', window._recorderScrollHandler);
          }
          
          window._recorderScrollHandler = (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.scrollTo(0, 0);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
            return false;
          };
          
          window.addEventListener('scroll', window._recorderScrollHandler, { passive: false, capture: true });
          window.addEventListener('wheel', window._recorderScrollHandler, { passive: false, capture: true });
          window.addEventListener('touchmove', window._recorderScrollHandler, { passive: false, capture: true });
          
          // 定时重置滚动位置
          if (window._recorderScrollInterval) clearInterval(window._recorderScrollInterval);
          window._recorderScrollInterval = setInterval(() => {
            if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) {
              window.scrollTo(0, 0);
            }
          }, 200);
        })();
      `);
      logger.info('[Recorder] 已注入防滚动 CSS');
    } catch (e) {
      logger.warn('[Recorder] 注入防滚动 CSS 失败:', e.message);
    }
  }

  /**
   * 尝试设置直播间为最高画质
   */
  async setMaxQuality() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 抖音直播画质选择：尝试多种方式切换到最高画质
          
          // 方法1: 通过画质按钮和菜单
          const qualitySelectors = [
            '[class*="quality"]', '[class*="definition"]',
            '[class*="Quality"]', '[class*="Definition"]',
            '[data-e2e="quality"]', '[class*="clarity"]',
            '[class*="resolution"]'
          ];
          
          for (const selector of qualitySelectors) {
            const btns = document.querySelectorAll(selector);
            if (btns.length > 0) {
              btns[0].click();
              break;
            }
          }
          
          // 等待菜单弹出后选择最高画质
          setTimeout(() => {
            const optionSelectors = [
              '[class*="quality-item"]', '[class*="definition-item"]',
              '[class*="QualityItem"]', '[class*="option"]',
              'li[class*="item"]', '[data-quality]'
            ];
            
            for (const selector of optionSelectors) {
              const options = document.querySelectorAll(selector);
              if (options.length > 0) {
                // 通常第一个或最后一个选项是最高画质
                // 尝试找到包含"蓝光"、"原画"、"超清"、"1080p"等关键词的选项
                let bestOption = null;
                const keywords = ['蓝光', '原画', '超清', '1080', '4K', 'HDR', '最高'];
                for (const opt of options) {
                  const text = (opt.textContent || '').trim();
                  for (const kw of keywords) {
                    if (text.includes(kw)) {
                      bestOption = opt;
                      break;
                    }
                  }
                  if (bestOption) break;
                }
                // 如果没找到关键词匹配的，选第一个（通常是最高画质）
                if (!bestOption) bestOption = options[0];
                bestOption.click();
                break;
              }
            }
          }, 800);
          
          // 方法2: 尝试通过播放器设置面板
          setTimeout(() => {
            const settingsBtns = document.querySelectorAll(
              '[class*="setting"], [class*="Setting"], ' +
              '[aria-label*="设置"], [title*="设置"], ' +
              '[class*="gear"], [class*="config"]'
            );
            for (const btn of settingsBtns) {
              const rect = btn.getBoundingClientRect();
              // 只点击视频播放器区域内的设置按钮
              if (rect.top < window.innerHeight * 0.7) {
                btn.click();
                break;
              }
            }
          }, 1500);
        })();
      `);
      logger.info('[Recorder] 已尝试设置最高画质');
    } catch (e) {
      logger.warn('[Recorder] 设置画质时出错:', e.message);
    }
  }

  /**
   * 开始录制
   */
  async startRecording() {
    if (this.recording) {
      const errMsg = `录制引擎已在运行中 (room: ${this.roomId})，请先停止再重试`;
      logger.warn(errMsg);
      throw new Error(errMsg);
    }

    logger.info(`[Recorder] 准备开始录制 - 房间: ${this.roomId}, 主播: ${this.streamerName}, URL: ${this.liveUrl}`);

    try {
      const config = getConfig();
      const baseOutputFolder = this.outputFolder || config.outputFolder || this.getDefaultOutputFolder();

      // 按主播名称创建子文件夹
      const streamerFolder = path.join(baseOutputFolder, this.streamerName);

      // 确保输出目录存在（包括主播子文件夹）
      if (!fs.existsSync(streamerFolder)) {
        fs.mkdirSync(streamerFolder, { recursive: true });
      }

      // 生成文件名
      const fileName = generateFileName(this.streamerName);
      this.outputFile = path.join(streamerFolder, `${fileName}.${config.fileFormat || 'mp4'}`);
      this.startTime = new Date();
      this.frameCount = 0;

      logger.info(`[Recorder] 输出文件: ${this.outputFile}`);

      // 创建捕获窗口（如果还没创建）
      if (!this.captureWindow || this.captureWindow.isDestroyed()) {
        logger.info('[Recorder] 正在创建捕获窗口...');
        await this.createCaptureWindow();
        logger.info('[Recorder] 捕获窗口创建成功');
      }

      // 启动 FFmpeg 编码进程
      logger.info(`[Recorder] 启动 FFmpeg 进程, FPS: ${config.fps || 30}`);
      this.startFFmpegProcess(config.fps || 30);

      // 开始捕获帧
      this.recording = true;
      this.startCapture();

      logger.info(`[Recorder] 录制已开始: ${this.streamerName} -> ${this.outputFile}`);

      this.onStatusChange('recording', {
        roomId: this.roomId,
        streamerName: this.streamerName,
        outputFile: this.outputFile,
        startTime: this.startTime
      });
    } catch (err) {
      logger.error(`[Recorder] 启动录制失败: ${err.message}`, err);
      // 彻底清理状态
      this.recording = false;
      if (this._captureInterval) {
        clearInterval(this._captureInterval);
        this._captureInterval = null;
      }
      if (this.ffmpegProcess) {
        try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
        this.ffmpegProcess = null;
      }
      if (this.captureWindow && !this.captureWindow.isDestroyed()) {
        try { this.captureWindow.destroy(); } catch (e) { /* ignore */ }
        this.captureWindow = null;
      }
      this.onStatusChange('error', {
        roomId: this.roomId,
        error: err.message
      });
      throw err;
    }
  }

  /**
   * 启动 FFmpeg 编码进程
   */
  startFFmpegProcess(fps) {
    // Electron 的 capturePage().getBitmap() 在 Windows 上返回 BGRA 格式
    // 需要指定正确的输入像素格式
    const args = [
      '-f', 'rawvideo',
      '-pix_fmt', 'bgra',      // BGRA 格式 (Windows 上 Electron 返回的格式)
      '-s', '1920x1080',
      '-r', String(fps),
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'medium',     // 使用 medium 预设，画质与速度平衡更好
      '-crf', '15',            // CRF 15，接近无损画质
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      this.outputFile
    ];

    const resolvedPath = getFFmpegPath();
    const { spawn } = require('child_process');
    logger.info(`[Recorder] 启动 FFmpeg: ${resolvedPath}, 输入格式: bgra`);
    this.ffmpegProcess = spawn(resolvedPath, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.ffmpegProcess.stdout.on('data', (data) => {
      console.log(`[FFmpeg] ${data.toString().trim()}`);
    });

    this.ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.log(`[FFmpeg] ${msg}`);
    });

    this.ffmpegProcess.on('close', (code) => {
      console.log(`[FFmpeg] 进程退出, code: ${code}`);
      this.ffmpegProcess = null;
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error(`[FFmpeg] 进程错误:`, err);
      this.onError(this.roomId, err);
    });
  }

  /**
   * 开始帧捕获循环
   */
  startCapture() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    const config = getConfig();
    const fps = config.fps || 30;
    const interval = Math.floor(1000 / fps);
    const CAPTURE_WIDTH = 1920;
    const CAPTURE_HEIGHT = 1080;

    this._captureInterval = setInterval(async () => {
      if (!this.recording || !this.captureWindow || this.captureWindow.isDestroyed()) {
        return;
      }

      try {
        // 使用 capturePage 的 rect 参数，严格只捕获视口区域 (0,0,1920,1080)
        const image = await this.captureWindow.webContents.capturePage({
          x: 0,
          y: 0,
          width: CAPTURE_WIDTH,
          height: CAPTURE_HEIGHT
        });
        
        // 获取图像实际尺寸并验证
        const imgSize = image.getSize();
        let bitmap;
        
        if (imgSize.width !== CAPTURE_WIDTH || imgSize.height !== CAPTURE_HEIGHT) {
          // 如果尺寸不匹配，裁剪到正确大小
          const croppedImage = image.crop({
            x: 0,
            y: 0,
            width: Math.min(imgSize.width, CAPTURE_WIDTH),
            height: Math.min(imgSize.height, CAPTURE_HEIGHT)
          });
          bitmap = croppedImage.getBitmap();
          
          // 如果裁剪后仍然小于预期，用黑色填充
          const expectedSize = CAPTURE_WIDTH * CAPTURE_HEIGHT * 4;
          if (bitmap.length < expectedSize) {
            const paddedBuffer = Buffer.alloc(expectedSize, 0);
            for (let row = 0; row < Math.min(imgSize.height, CAPTURE_HEIGHT); row++) {
              const srcOffset = row * imgSize.width * 4;
              const dstOffset = row * CAPTURE_WIDTH * 4;
              const rowBytes = Math.min(imgSize.width, CAPTURE_WIDTH) * 4;
              bitmap.copy(paddedBuffer, dstOffset, srcOffset, srcOffset + rowBytes);
            }
            bitmap = paddedBuffer;
          }
        } else {
          bitmap = image.getBitmap();
        }

        // 检查 FFmpeg 进程是否仍在运行且 stdin 可写
        if (this.ffmpegProcess && this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
          try {
            // 检查 stdin 是否可写（防止 write after end 错误）
            if (this.ffmpegProcess.stdin.writable) {
              this.ffmpegProcess.stdin.write(bitmap);
              this.frameCount++;
            }
          } catch (writeErr) {
            // 忽略写入错误，可能是进程正在关闭
            if (writeErr.code !== 'ERR_STREAM_WRITE_AFTER_END' && 
                writeErr.code !== 'ERR_STREAM_DESTROYED') {
              logger.warn('[Recorder] 写入帧数据出错:', writeErr.message);
            }
          }
        }
      } catch (err) {
        if (err.message && !err.message.includes('destroyed')) {
          logger.error('Frame capture error:', err.message);
        }
      }
    }, interval);
  }

  /**
   * 停止录制
   */
  async stopRecording() {
    if (!this.recording) return;

    this.recording = false;
    logger.info(`Stopping recording: ${this.streamerName}, total frames: ${this.frameCount}`);

    // 停止捕获
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = null;
    }

    // 关闭 FFmpeg
    if (this.ffmpegProcess && this.ffmpegProcess.stdin) {
      return new Promise((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          
          // 获取文件大小
          let fileSize = 0;
          try {
            if (this.outputFile && fs.existsSync(this.outputFile)) {
              const stats = fs.statSync(this.outputFile);
              fileSize = stats.size;
            }
          } catch (e) {
            logger.warn('Failed to get file size:', e.message);
          }
          
          this.onStatusChange('stopped', {
            roomId: this.roomId,
            streamerName: this.streamerName,
            outputFile: this.outputFile,
            fileSize: fileSize,
            duration: Date.now() - (this.startTime ? this.startTime.getTime() : Date.now()),
            frameCount: this.frameCount
          });
          resolve();
        };
        
        this.ffmpegProcess.stdin.end();
        this.ffmpegProcess.on('close', done);

        // 超时强制结束
        setTimeout(() => {
          if (this.ffmpegProcess) {
            try { this.ffmpegProcess.kill('SIGKILL'); } catch (e) { /* ignore */ }
          }
          done();
        }, 10000);
      });
    }

    this.onStatusChange('stopped', {
      roomId: this.roomId,
      streamerName: this.streamerName,
      outputFile: this.outputFile,
      fileSize: 0
    });
  }

  /**
   * 销毁捕获窗口
   */
  destroy() {
    this.stopRecording();
    if (this.captureWindow && !this.captureWindow.isDestroyed()) {
      this.captureWindow.destroy();
      this.captureWindow = null;
    }
  }

  /**
   * 获取默认输出文件夹
   */
  getDefaultOutputFolder() {
    const { app } = require('electron');
    return path.join(app.getPath('videos'), '抖音直播录制');
  }

  /**
   * 获取录制状态
   */
  getStatus() {
    return {
      recording: this.recording,
      streamerName: this.streamerName,
      roomId: this.roomId,
      outputFile: this.outputFile,
      frameCount: this.frameCount,
      startTime: this.startTime,
      duration: this.startTime ? Date.now() - this.startTime.getTime() : 0
    };
  }
}

module.exports = { Recorder };
