/**
 * 直播间管理模块
 * 管理直播间的添加、删除、状态监听和录制控制
 */
const { BrowserWindow } = require('electron');
const { Recorder } = require('./recorder');
const { extractUrl, extractNameFromText, resolveShortUrl, buildLiveUrl } = require('./douyin-utils');
const { getConfig, addStream, removeStream, updateStream, getStreams } = require('./config');

class StreamManager {
  constructor() {
    // roomId -> { info, recorder, monitorWindow, status, timer }
    this.streams = new Map();
    this.onUpdate = null; // UI 更新回调
  }

  /**
   * 设置 UI 更新回调
   */
  setUpdateCallback(callback) {
    this.onUpdate = callback;
  }

  /**
   * 通知 UI 更新
   */
  notifyUpdate() {
    if (this.onUpdate) {
      this.onUpdate(this.getAllStatus());
    }
  }

  /**
   * 添加直播间
   * @param {string} inputText - 用户粘贴的文本（可能包含分享文案）
   */
  async addStreamByInput(inputText) {
    // 1. 提取URL
    const url = extractUrl(inputText);
    if (!url) {
      throw new Error('未能识别有效的抖音直播间链接');
    }

    // 2. 尝试从文本中提取主播名称
    let streamerName = extractNameFromText(inputText);

    // 3. 解析链接获取 roomId
    let roomId, realUrl;
    if (url.includes('v.douyin.com')) {
      const resolved = await resolveShortUrl(url);
      roomId = resolved.roomId;
      realUrl = resolved.realUrl;
    } else if (url.includes('live.douyin.com')) {
      const match = url.match(/live\.douyin\.com\/(\d+)/);
      roomId = match ? match[1] : null;
      realUrl = url;
    }

    if (!roomId) {
      throw new Error('无法解析直播间ID，请检查链接是否正确');
    }

    // 检查是否已添加
    if (this.streams.has(roomId)) {
      throw new Error(`直播间 ${roomId} 已在列表中`);
    }

    // 4. 构建直播间URL
    const liveUrl = buildLiveUrl(roomId);

    // 5. 创建监控窗口获取主播名称（如果文本中没有提取到）
    if (!streamerName) {
      streamerName = await this.fetchStreamerName(roomId, liveUrl);
    }

    // 6. 创建流信息
    const streamInfo = {
      roomId,
      liveUrl,
      streamerName: streamerName || `主播${roomId}`,
      originalUrl: url,
      addedAt: Date.now()
    };

    // 7. 保存到配置
    addStream(streamInfo);

    // 8. 创建监控和录制实例
    const streamState = {
      info: streamInfo,
      recorder: null,
      monitorWindow: null,
      status: 'checking',    // checking | live | offline | recording
      isLive: false,
      lastCheck: null
    };

    this.streams.set(roomId, streamState);

    // 9. 创建监控窗口
    await this.createMonitorWindow(streamState);

    // 10. 开始状态监听
    this.startMonitoring(streamState);

    this.notifyUpdate();
    return streamInfo;
  }

  /**
   * 获取主播名称（通过加载页面获取）
   */
  async fetchStreamerName(roomId, liveUrl) {
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: 'persist:douyin',
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }
      });

      const timeout = setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
        resolve(null);
      }, 15000);

      win.loadURL(liveUrl).then(() => {
        setTimeout(async () => {
          try {
            // 从页面标题或DOM获取主播名称
            const name = await win.webContents.executeJavaScript(`
              (function() {
                // 尝试从页面元素获取
                const nameEl = document.querySelector('[class*="nickname"], [class*="author"], [class*="userName"]');
                if (nameEl) return nameEl.textContent.trim();

                // 从title获取
                const title = document.title;
                if (title && title.includes('的直播间')) {
                  return title.split('的直播间')[0].trim();
                }

                // 从meta标签获取
                const meta = document.querySelector('meta[property="og:title"]');
                if (meta) return meta.content.trim();

                return null;
              })();
            `);
            clearTimeout(timeout);
            if (!win.isDestroyed()) win.destroy();
            resolve(name);
          } catch (e) {
            clearTimeout(timeout);
            if (!win.isDestroyed()) win.destroy();
            resolve(null);
          }
        }, 3000);
      }).catch(() => {
        clearTimeout(timeout);
        if (!win.isDestroyed()) win.destroy();
        resolve(null);
      });
    });
  }

  /**
   * 创建监控窗口（用于检测直播状态）
   */
  async createMonitorWindow(streamState) {
    const win = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:douyin',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      }
    });

    streamState.monitorWindow = win;

    try {
      await win.loadURL(streamState.info.liveUrl, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      });
    } catch (e) {
      console.log(`[Monitor] 加载页面出错: ${e.message}`);
    }
  }

  /**
   * 开始定时监控直播状态
   */
  startMonitoring(streamState) {
    const config = getConfig();
    const interval = (config.checkInterval || 30) * 1000;

    // 立即检查一次
    this.checkLiveStatus(streamState);

    // 定时检查
    streamState.timer = setInterval(() => {
      this.checkLiveStatus(streamState);
    }, interval);
  }

  /**
   * 检查直播状态
   */
  async checkLiveStatus(streamState) {
    const { monitorWindow, info } = streamState;

    if (!monitorWindow || monitorWindow.isDestroyed()) {
      // 重新创建监控窗口
      await this.createMonitorWindow(streamState);
      return;
    }

    try {
      // 重新加载页面以获取最新状态
      await monitorWindow.loadURL(info.liveUrl, {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      });

      // 等待页面加载
      await new Promise(resolve => setTimeout(resolve, 3000));

      // 检测是否在直播
      const isLive = await monitorWindow.webContents.executeJavaScript(`
        (function() {
          // 检查是否有视频元素在播放
          const video = document.querySelector('video');
          if (video && !video.paused && video.readyState >= 2) {
            return true;
          }

          // 检查页面是否显示"直播中"标识
          const body = document.body.innerText || '';
          if (body.includes('直播中') || body.includes('正在直播')) {
            return true;
          }

          // 检查是否有直播相关的DOM元素
          const liveBadge = document.querySelector('[class*="living"], [class*="is-live"], [class*="on-live"]');
          if (liveBadge) return true;

          // 检查页面标题
          const title = document.title || '';
          if (title.includes('直播') && !title.includes('未开播') && !title.includes('回放')) {
            return true;
          }

          return false;
        })();
      `);

      // 尝试获取主播名称（如果还没有）
      if (!streamState.info.streamerName || streamState.info.streamerName.startsWith('主播')) {
        try {
          const name = await monitorWindow.webContents.executeJavaScript(`
            (function() {
              const nameEl = document.querySelector('[class*="nickname"], [class*="author"]');
              if (nameEl) return nameEl.textContent.trim();
              const title = document.title;
              if (title && title.includes('的直播间')) {
                return title.split('的直播间')[0].trim();
              }
              return null;
            })();
          `);
          if (name) {
            streamState.info.streamerName = name;
            updateStream(info.roomId, { streamerName: name });
          }
        } catch (e) { /* ignore */ }
      }

      const wasLive = streamState.isLive;
      streamState.isLive = isLive;
      streamState.lastCheck = Date.now();
      streamState.status = isLive ? 'live' : 'offline';

      // 状态变化处理
      if (isLive && !wasLive) {
        console.log(`[Monitor] ${info.streamerName} 开播了!`);
        streamState.status = 'live';

        // 自动开始录制
        const config = getConfig();
        if (config.autoStart) {
          await this.startRecording(info.roomId);
        }
      } else if (!isLive && wasLive) {
        console.log(`[Monitor] ${info.streamerName} 下播了`);
        // 停止录制
        if (streamState.recorder) {
          await streamState.recorder.stopRecording();
          streamState.recorder.destroy();
          streamState.recorder = null;
          streamState.status = 'offline';
        }
      }

      this.notifyUpdate();
    } catch (e) {
      console.error(`[Monitor] 检查状态出错 (${info.streamerName}):`, e.message);
      streamState.status = 'error';
      this.notifyUpdate();
    }
  }

  /**
   * 开始录制指定直播间
   */
  async startRecording(roomId) {
    const streamState = this.streams.get(roomId);
    if (!streamState) throw new Error('直播间不存在');
    if (streamState.recorder && streamState.recorder.recording) {
      throw new Error('正在录制中');
    }

    const config = getConfig();

    const recorder = new Recorder({
      roomId: streamState.info.roomId,
      streamerName: streamState.info.streamerName,
      liveUrl: streamState.info.liveUrl,
      outputFolder: config.outputFolder,
      session: 'persist:douyin',
      onStatusChange: (status, data) => {
        if (status === 'recording') {
          streamState.status = 'recording';
        } else if (status === 'stopped') {
          streamState.status = streamState.isLive ? 'live' : 'offline';
        }
        this.notifyUpdate();
      },
      onError: (id, err) => {
        console.error(`[Recorder] 录制错误 (${streamState.info.streamerName}):`, err);
        streamState.status = 'error';
        this.notifyUpdate();
      }
    });

    streamState.recorder = recorder;
    streamState.status = 'recording';
    this.notifyUpdate();

    await recorder.startRecording();
  }

  /**
   * 停止录制指定直播间
   */
  async stopRecording(roomId) {
    const streamState = this.streams.get(roomId);
    if (!streamState || !streamState.recorder) return;

    await streamState.recorder.stopRecording();
    streamState.recorder.destroy();
    streamState.recorder = null;
    streamState.status = streamState.isLive ? 'live' : 'offline';
    this.notifyUpdate();
  }

  /**
   * 删除直播间
   */
  async removeStreamById(roomId) {
    const streamState = this.streams.get(roomId);
    if (!streamState) return;

    // 停止录制
    if (streamState.recorder) {
      await streamState.recorder.stopRecording();
      streamState.recorder.destroy();
    }

    // 停止监控
    if (streamState.timer) {
      clearInterval(streamState.timer);
    }

    // 销毁监控窗口
    if (streamState.monitorWindow && !streamState.monitorWindow.isDestroyed()) {
      streamState.monitorWindow.destroy();
    }

    this.streams.delete(roomId);
    removeStream(roomId);
    this.notifyUpdate();
  }

  /**
   * 获取所有直播间状态
   */
  getAllStatus() {
    const result = [];
    for (const [roomId, state] of this.streams) {
      result.push({
        roomId: state.info.roomId,
        streamerName: state.info.streamerName,
        liveUrl: state.info.liveUrl,
        status: state.status,
        isLive: state.isLive,
        lastCheck: state.lastCheck,
        recorder: state.recorder ? state.recorder.getStatus() : null
      });
    }
    return result;
  }

  /**
   * 从持久化配置恢复直播间列表
   */
  async restoreStreams() {
    const savedStreams = getStreams();
    for (const streamInfo of savedStreams) {
      try {
        const streamState = {
          info: streamInfo,
          recorder: null,
          monitorWindow: null,
          status: 'checking',
          isLive: false,
          lastCheck: null
        };

        this.streams.set(streamInfo.roomId, streamState);
        await this.createMonitorWindow(streamState);
        this.startMonitoring(streamState);
      } catch (e) {
        console.error(`[StreamManager] 恢复直播间失败 (${streamInfo.roomId}):`, e.message);
      }
    }
    this.notifyUpdate();
  }

  /**
   * 销毁所有资源
   */
  destroyAll() {
    for (const [roomId, state] of this.streams) {
      if (state.recorder) {
        state.recorder.destroy();
      }
      if (state.timer) {
        clearInterval(state.timer);
      }
      if (state.monitorWindow && !state.monitorWindow.isDestroyed()) {
        state.monitorWindow.destroy();
      }
    }
    this.streams.clear();
  }
}

module.exports = { StreamManager };
