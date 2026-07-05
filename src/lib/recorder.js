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
          // 尝试找到视频元素并播放（不静音，以捕获音频）
          const videos = document.querySelectorAll('video');
          for (const video of videos) {
            video.muted = false;
            video.volume = 1.0; // 最大音量
            if (video.paused) {
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
      logger.info('[Recorder] 已尝试启动视频播放（最大音量）');
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

    // 多次重试，确保页面完全加载后能设置画质
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const result = await this.captureWindow.webContents.executeJavaScript(`
          (function() {
            // ===== 方法1: 查找画质/清晰度按钮（通过文本内容匹配） =====
            const allElements = document.querySelectorAll('span, div, button, a, p');
            let qualityBtn = null;
            const btnKeywords = ['画质', '清晰度', '蓝光', '原画', '超清', '1080P', '1080p', '720P'];
            
            for (const el of allElements) {
              const text = (el.textContent || '').trim();
              // 匹配短文本（按钮文字通常很短）
              if (text.length <= 10 && text.length >= 2) {
                for (const kw of btnKeywords) {
                  if (text.includes(kw)) {
                    qualityBtn = el;
                    break;
                  }
                }
              }
              if (qualityBtn) break;
            }
            
            // 方法1b: 通过 class 属性匹配
            if (!qualityBtn) {
              const classSelectors = [
                '[class*="quality"]', '[class*="Quality"]',
                '[class*="definition"]', '[class*="Definition"]',
                '[class*="clarity"]', '[class*="Clarity"]',
                '[data-e2e="quality"]', '[class*="resolution"]',
                '[class*="xgplayer-quality"]', '[class*="xg-player-quality"]'
              ];
              for (const sel of classSelectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                  qualityBtn = els[0];
                  break;
                }
              }
            }
            
            if (!qualityBtn) {
              return { success: false, reason: '未找到画质按钮, attempt=' + ${attempt} };
            }
            
            // 点击画质按钮打开菜单
            qualityBtn.click();
            
            // 等待菜单弹出后选择最高画质
            return new Promise((resolve) => {
              setTimeout(() => {
                // 查找画质选项列表
                const optionSelectors = [
                  '[class*="quality-item"]', '[class*="QualityItem"]',
                  '[class*="quality_item"]', '[class*="definition-item"]',
                  '[class*="DefinitionItem"]', '[class*="definition_item"]',
                  '[class*="quality-option"]', '[class*="QualityOption"]',
                  '[class*="xgplayer-quality"] li',
                  '[class*="menu-item"]', '[class*="MenuItem"]',
                  'li[class*="item"]', '[class*="option"]',
                  '[data-quality]', '[data-definition]'
                ];
                
                let options = [];
                for (const sel of optionSelectors) {
                  const found = document.querySelectorAll(sel);
                  if (found.length >= 2) {
                    options = found;
                    break;
                  }
                }
                
                // 如果通过选择器找不到，尝试查找所有包含画质关键词的 li/div/span
                if (options.length === 0) {
                  const allItems = document.querySelectorAll('li, div[class*="item"], span[class*="item"]');
                  const qualityItems = [];
                  const qualityKws = ['蓝光', '原画', '超清', '高清', '标清', '1080', '720', '480', '4K', 'HDR', '流畅'];
                  for (const item of allItems) {
                    const t = (item.textContent || '').trim();
                    if (t.length <= 20 && qualityKws.some(kw => t.includes(kw))) {
                      qualityItems.push(item);
                    }
                  }
                  if (qualityItems.length >= 2) {
                    options = qualityItems;
                  }
                }
                
                if (options.length === 0) {
                  resolve({ success: false, reason: '未找到画质选项列表' });
                  return;
                }
                
                // 按优先级选择最高画质
                const priorityKeywords = ['蓝光', '原画', '4K', 'HDR', '1080P', '1080p', '1080', '超清', '720P', '720p', '720'];
                let bestOption = null;
                
                for (const kw of priorityKeywords) {
                  for (const opt of options) {
                    const text = (opt.textContent || '').trim();
                    if (text.includes(kw)) {
                      bestOption = opt;
                      break;
                    }
                  }
                  if (bestOption) break;
                }
                
                // 如果没找到关键词匹配的，选第一个（通常是最高画质）
                if (!bestOption) bestOption = options[0];
                
                const selectedText = (bestOption.textContent || '').trim();
                bestOption.click();
                resolve({ success: true, quality: selectedText });
              }, 1000);
            });
          })();
        `);
        
        if (result && result.success) {
          logger.info(`[Recorder] 已设置最高画质: ${result.quality}`);
          return;
        } else {
          logger.warn(`[Recorder] 设置画质未成功 (尝试 ${attempt}/5): ${result ? result.reason : 'unknown'}`);
        }
      } catch (e) {
        logger.warn(`[Recorder] 设置画质时出错 (尝试 ${attempt}/5): ${e.message}`);
      }
      
      // 等待后重试
      if (attempt < 5) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    logger.warn('[Recorder] 5次尝试后仍未成功设置画质');
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
    const resolvedPath = getFFmpegPath();
    const { spawn } = require('child_process');

    // 先尝试检测可用的音频设备
    this._detectAudioDevice().then(audioDevice => {
      const args = [
        // 视频输入（从管道读取原始帧）
        '-f', 'rawvideo',
        '-pix_fmt', 'bgra',
        '-s', '1920x1080',
        '-r', String(fps),
        '-i', 'pipe:0',
      ];

      // 如果检测到音频设备，添加音频输入
      if (audioDevice) {
        args.push('-f', 'dshow', '-i', `audio=${audioDevice}`);
        args.push('-c:a', 'aac', '-b:a', '192k');
        logger.info(`[Recorder] 音频设备: ${audioDevice}`);
      } else {
        logger.warn('[Recorder] 未检测到音频设备，仅录制视频（无声音）');
      }

      args.push(
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '15',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-y',
        this.outputFile
      );

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
    });
  }

  /**
   * 检测可用的音频捕获设备
   */
  _detectAudioDevice() {
    return new Promise((resolve) => {
      const resolvedPath = getFFmpegPath();
      const { execSync } = require('child_process');
      try {
        const output = execSync(`"${resolvedPath}" -f dshow -list_devices true -i dummy 2>&1`, {
          timeout: 5000,
          encoding: 'utf-8'
        });
        // 解析输出，找到第一个音频设备
        const lines = output.split('\n');
        let inAudioSection = false;
        let audioDevice = null;
        for (const line of lines) {
          if (line.includes('DirectShow audio devices')) {
            inAudioSection = true;
            continue;
          }
          if (inAudioSection) {
            // 匹配形如 "Stereo Mix (Realtek Audio)" 的设备名
            const match = line.match(/"([^"]+)"/);
            if (match) {
              audioDevice = match[1];
              break;
            }
          }
        }
        resolve(audioDevice);
      } catch (e) {
        logger.warn('[Recorder] 检测音频设备失败:', e.message);
        resolve(null);
      }
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
