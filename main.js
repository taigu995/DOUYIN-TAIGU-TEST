/**
 * 抖音直播录制工具 - Electron 主进程
 * 负责窗口管理、IPC通信、系统托盘
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, session, nativeImage } = require('electron');
const path = require('path');
const { StreamManager } = require('./src/lib/stream-manager');
const { getConfig, setConfig } = require('./src/lib/config');

let mainWindow = null;
let tray = null;
let streamManager = null;

// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

/**
 * 创建主窗口
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 750,
    minHeight: 500,
    title: '抖音直播录制工具',
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 关闭时最小化到托盘
  mainWindow.on('close', (e) => {
    const config = getConfig();
    if (config.minimizeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 创建系统托盘
 */
function createTray() {
  // 创建一个简单的托盘图标
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA4ElEQVQ4T2NkoBAwUqifgWoGzPn/n+E/AwMDIwMDQyczA8NMBgaG7cQaAgMDGRgZGBcwMDJMI2QIzACG//8Z5jMwMExgYGDYhs8QmAHIBjEyMk5kYGCYj88lMAOQDUJWw8jIOAmfS2AGoBiEpOY/PpfADMBpEJJBJLkEngbIMkAJJghDyDIAZghMM8wFuAwhywBkQ5ANIcUABnRD8BlClgHYDCHaAGyGEG0ALkOINgCXIUQbgM8Qog3AZwh1DMBjCNEGEDKEaAMIGYLXAFDCJRijWPMBMekYl1qqZGYAFlyJ4LsVe3QAAAAASUVORK5CYII='
  );

  tray = new Tray(icon);
  tray.setToolTip('抖音直播录制工具');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        // 停止所有录制
        if (streamManager) {
          streamManager.destroyAll();
        }
        tray.destroy();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

/**
 * 注册 IPC 处理
 */
function setupIPC() {
  // 添加直播间
  ipcMain.handle('add-stream', async (event, inputText) => {
    try {
      const result = await streamManager.addStreamByInput(inputText);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 删除直播间
  ipcMain.handle('remove-stream', async (event, roomId) => {
    try {
      await streamManager.removeStreamById(roomId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 开始录制
  ipcMain.handle('start-recording', async (event, roomId) => {
    try {
      await streamManager.startRecording(roomId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 停止录制
  ipcMain.handle('stop-recording', async (event, roomId) => {
    try {
      await streamManager.stopRecording(roomId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // 获取所有直播间状态
  ipcMain.handle('get-all-status', async () => {
    return streamManager.getAllStatus();
  });

  // 获取配置
  ipcMain.handle('get-config', async () => {
    return getConfig();
  });

  // 设置配置
  ipcMain.handle('set-config', async (event, key, value) => {
    setConfig(key, value);
    return { success: true };
  });

  // 选择输出文件夹
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择录制文件保存位置'
    });
    if (result.canceled) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });

  // 打开登录窗口（用于首次登录抖音）
  ipcMain.handle('open-login', async () => {
    const loginWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      title: '登录抖音',
      parent: mainWindow,
      modal: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:douyin',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      }
    });

    loginWindow.loadURL('https://www.douyin.com', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    });

    // 监听URL变化，登录成功后关闭
    loginWindow.webContents.on('did-navigate', (event, url) => {
      if (url.includes('douyin.com') && !url.includes('login')) {
        // 可能已登录
      }
    });

    return { success: true };
  });

  // 在浏览器中打开直播间（用于调试）
  ipcMain.handle('open-in-browser', async (event, url) => {
    const { shell } = require('electron');
    await shell.openExternal(url);
    return { success: true };
  });

  // 获取输出文件夹路径
  ipcMain.handle('get-default-folder', async () => {
    const { app } = require('electron');
    return path.join(app.getPath('videos'), '抖音直播录制');
  });
}

/**
 * 应用启动
 */
app.whenReady().then(async () => {
  // 配置 session
  const douyinSession = session.fromPartition('persist:douyin');
  douyinSession.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

  // 初始化流管理器
  streamManager = new StreamManager();
  streamManager.setUpdateCallback((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('streams-updated', status);
    }
  });

  // 创建窗口
  createMainWindow();
  createTray();
  setupIPC();

  // 恢复已保存的直播间
  await streamManager.restoreStreams();
});

// macOS 点击 dock 图标时重新显示窗口
app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

// 其他实例尝试启动时，聚焦当前窗口
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// 退出前清理
app.on('before-quit', () => {
  if (streamManager) {
    streamManager.destroyAll();
  }
});

app.on('window-all-closed', () => {
  // Windows 下不退出，保持托盘运行
  if (process.platform !== 'darwin' && !tray) {
    app.quit();
  }
});
