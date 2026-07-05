/**
 * 预加载脚本 - 安全的 IPC 桥接
 * 通过 contextBridge 暴露有限 API 给渲染进程
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 添加直播间
  addStream: (inputText) => ipcRenderer.invoke('add-stream', inputText),

  // 删除直播间
  removeStream: (roomId) => ipcRenderer.invoke('remove-stream', roomId),

  // 开始录制
  startRecording: (roomId) => ipcRenderer.invoke('start-recording', roomId),

  // 停止录制
  stopRecording: (roomId) => ipcRenderer.invoke('stop-recording', roomId),

  // 获取所有直播间状态
  getAllStatus: () => ipcRenderer.invoke('get-all-status'),

  // 获取配置
  getConfig: () => ipcRenderer.invoke('get-config'),

  // 设置配置
  setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),

  // 选择文件夹
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 打开登录窗口
  openLogin: () => ipcRenderer.invoke('open-login'),

  // 在浏览器中打开
  openInBrowser: (url) => ipcRenderer.invoke('open-in-browser', url),

  // 获取默认文件夹
  getDefaultFolder: () => ipcRenderer.invoke('get-default-folder'),

  // 监听直播间状态更新
  onStreamsUpdated: (callback) => {
    ipcRenderer.on('streams-updated', (event, data) => {
      callback(data);
    });
  }
});
