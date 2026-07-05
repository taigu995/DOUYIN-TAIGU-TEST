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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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

    this.captureWindow = new BrowserWindow({
      width: 1920,
      height: 1080,
      show: false,            // 不显示窗口
      enableLargerThanScreen: true,
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

    // 尝试设置最高画质
    await this.setMaxQuality();

    return this.captureWindow;
  }

  /**
   * 尝试设置直播间为最高画质
   */
  async setMaxQuality() {
    if (!this.captureWindow || this.captureWindow.isDestroyed()) return;

    try {
      // 尝试点击画质选择按钮切换到最高画质
      await this.captureWindow.webContents.executeJavaScript(`
        (function() {
          // 尝试找到并点击画质设置
          const qualityBtns = document.querySelectorAll('[class*="quality"], [class*="definition"]');
          if (qualityBtns.length > 0) {
            qualityBtns[0].click();
          }
          // 尝试选择最高画质选项
          setTimeout(() => {
            const options = document.querySelectorAll('[class*="quality-item"], [class*="definition-item"]');
            if (options.length > 0) {
              // 通常第一个是最高画质
              options[0].click();
            }
          }, 500);
        })();
      `);
    } catch (e) {
      console.log('[Recorder] 设置画质时出错:', e.message);
    }
  }

  /**
   * 开始录制
   */
  async startRecording() {
    if (this.recording) return;

    const config = getConfig();
    const outputFolder = this.outputFolder || config.outputFolder || this.getDefaultOutputFolder();

    // 确保输出目录存在
    if (!fs.existsSync(outputFolder)) {
      fs.mkdirSync(outputFolder, { recursive: true });
    }

    // 生成文件名
    const fileName = generateFileName(this.streamerName);
    this.outputFile = path.join(outputFolder, `${fileName}.${config.fileFormat || 'mp4'}`);
    this.startTime = new Date();
    this.frameCount = 0;

    // 创建捕获窗口（如果还没创建）
    if (!this.captureWindow || this.captureWindow.isDestroyed()) {
      await this.createCaptureWindow();
    }

    // 启动 FFmpeg 编码进程
    this.startFFmpegProcess(config.fps || 30);

    // 开始捕获帧
    this.recording = true;
    this.startCapture();

    this.onStatusChange('recording', {
      roomId: this.roomId,
      streamerName: this.streamerName,
      outputFile: this.outputFile,
      startTime: this.startTime
    });

    console.log(`[Recorder] 开始录制: ${this.streamerName} -> ${this.outputFile}`);
  }

  /**
   * 启动 FFmpeg 编码进程
   */
  startFFmpegProcess(fps) {
    const args = [
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', '1920x1080',
      '-r', String(fps),
      '-i', 'pipe:0',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y',
      this.outputFile
    ];

    const ffmpegPath = ffmpegInstaller.path;
    const { spawn } = require('child_process');
    this.ffmpegProcess = spawn(ffmpegPath, args, {
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

    this._captureInterval = setInterval(async () => {
      if (!this.recording || !this.captureWindow || this.captureWindow.isDestroyed()) {
        return;
      }

      try {
        const image = await this.captureWindow.webContents.capturePage();
        const bitmap = image.getBitmap();

        if (this.ffmpegProcess && this.ffmpegProcess.stdin && !this.ffmpegProcess.stdin.destroyed) {
          this.ffmpegProcess.stdin.write(bitmap);
          this.frameCount++;
        }
      } catch (err) {
        if (err.message && !err.message.includes('destroyed')) {
          console.error('[Recorder] 捕获帧错误:', err.message);
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
    console.log(`[Recorder] 停止录制: ${this.streamerName}, 共 ${this.frameCount} 帧`);

    // 停止捕获
    if (this._captureInterval) {
      clearInterval(this._captureInterval);
      this._captureInterval = null;
    }

    // 关闭 FFmpeg
    if (this.ffmpegProcess && this.ffmpegProcess.stdin) {
      return new Promise((resolve) => {
        this.ffmpegProcess.stdin.end();
        this.ffmpegProcess.on('close', () => {
          this.onStatusChange('stopped', {
            roomId: this.roomId,
            streamerName: this.streamerName,
            outputFile: this.outputFile,
            duration: Date.now() - (this.startTime ? this.startTime.getTime() : Date.now()),
            frameCount: this.frameCount
          });
          resolve();
        });

        // 超时强制结束
        setTimeout(() => {
          if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGKILL');
          }
          resolve();
        }, 10000);
      });
    }

    this.onStatusChange('stopped', {
      roomId: this.roomId,
      streamerName: this.streamerName,
      outputFile: this.outputFile
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
