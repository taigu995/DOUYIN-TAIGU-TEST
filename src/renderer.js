/**
 * 渲染进程 - UI 交互逻辑
 * 处理用户操作、更新界面状态
 */

// 检测是否在 Electron 环境
const isElectron = typeof window.electronAPI !== 'undefined';

// DOM 元素
const elements = {
  inputRoomId: document.getElementById('input-room-id'),
  inputProfileUrl: document.getElementById('input-profile-url'),
  inputLiveUrl: document.getElementById('input-live-url'),
  btnAdd: document.getElementById('btn-add'),
  addError: document.getElementById('add-error'),
  streamsList: document.getElementById('streams-list'),
  emptyState: document.getElementById('empty-state'),
  streamCount: document.getElementById('stream-count'),
  statusText: document.getElementById('status-text'),
  recordingCount: document.getElementById('recording-count'),
  loginStatus: document.getElementById('login-status'),
  loginStatusName: document.getElementById('login-status__name'),
  loginStatusBadge: document.getElementById('login-status__badge'),
  btnLogin: document.getElementById('btn-login'),
  btnSettings: document.getElementById('btn-settings'),
  settingsPanel: document.getElementById('settings-panel'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  btnBrowse: document.getElementById('btn-browse'),
  outputFolder: document.getElementById('output-folder'),
  checkInterval: document.getElementById('check-interval'),
  fps: document.getElementById('fps'),
  autoStart: document.getElementById('auto-start'),
  minimizeToTray: document.getElementById('minimize-to-tray'),
  launchAtLogin: document.getElementById('launch-at-login'),
  toastContainer: document.getElementById('toast-container'),
  btnLogs: document.getElementById('btn-logs'),
  logPanel: document.getElementById('log-panel'),
  btnCloseLogs: document.getElementById('btn-close-logs'),
  btnRefreshLogs: document.getElementById('btn-refresh-logs'),
  btnOpenLogFile: document.getElementById('btn-open-log-file')
};

// 当前直播间数据
let streamsData = [];

// ========== 登录状态 ==========
async function updateLoginStatus() {
  if (!isElectron) return;

  try {
    const status = await window.electronAPI.getLoginStatus();
    
    if (status.loggedIn) {
      elements.loginStatusName.textContent = status.name || '抖音用户';
      elements.loginStatusBadge.textContent = '已登录';
      elements.loginStatusBadge.className = 'login-status__badge login-status__badge--online';
      elements.loginStatus.className = 'login-status login-status--online';
      elements.btnLogin.style.display = 'none';
      
      // 如果有头像，替换图标
      if (status.avatar) {
        const avatarEl = elements.loginStatus.querySelector('.login-status__avatar');
        avatarEl.innerHTML = `<img src="${status.avatar}" alt="avatar" onerror="this.parentElement.innerHTML='<svg width=\\'16\\' height=\\'16\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\'><path d=\\'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2\\'></path><circle cx=\\'12\\' cy=\\'7\\' r=\\'4\\'></circle></svg>'">`;
      }
    } else {
      elements.loginStatusName.textContent = '未登录';
      elements.loginStatusBadge.textContent = '未登录';
      elements.loginStatusBadge.className = 'login-status__badge login-status__badge--offline';
      elements.loginStatus.className = 'login-status';
      elements.btnLogin.style.display = '';
    }
  } catch (e) {
    // ignore
  }
}

// ========== 初始化 ==========
async function init() {
  // 加载配置
  if (isElectron) {
    const config = await window.electronAPI.getConfig();
    elements.outputFolder.value = config.outputFolder || '';
    elements.checkInterval.value = config.checkInterval || 30;
    elements.fps.value = config.fps || 30;
    elements.autoStart.checked = config.autoStart !== false;
    elements.minimizeToTray.checked = config.minimizeToTray !== false;
    elements.launchAtLogin.checked = config.launchAtLogin === true;

    if (!config.outputFolder) {
      const defaultFolder = await window.electronAPI.getDefaultFolder();
      elements.outputFolder.placeholder = defaultFolder;
    }

    // 监听状态更新
    window.electronAPI.onStreamsUpdated((data) => {
      streamsData = data;
      renderStreamsList(data);
    });

    // 监听登录状态变化
    window.electronAPI.onLoginStatusChanged(() => {
      updateLoginStatus();
      showToast('登录状态已更新', 'success');
    });

    // 初始加载
    const status = await window.electronAPI.getAllStatus();
    streamsData = status || [];
    renderStreamsList(streamsData);

    // 检查登录状态
    updateLoginStatus();
  } else {
    // 非 Electron 环境（浏览器预览），显示模拟数据
    renderDemoMode();
  }

  // 绑定事件
  bindEvents();
}

// ========== 事件绑定 ==========
function bindEvents() {
  elements.btnAdd.addEventListener('click', handleAddStream);
  // Enter 键添加
  [elements.inputRoomId, elements.inputProfileUrl, elements.inputLiveUrl].forEach(input => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleAddStream();
      }
    });
  });

  elements.btnLogin.addEventListener('click', async () => {
    if (isElectron) {
      await window.electronAPI.openLogin();
      showToast('已打开登录窗口，请在弹出的窗口中登录抖音', 'info');
    } else {
      showToast('登录功能仅在桌面应用中可用', 'warning');
    }
  });

  elements.btnSettings.addEventListener('click', () => {
    elements.settingsPanel.style.display = 'flex';
  });

  elements.btnCloseSettings.addEventListener('click', () => {
    elements.settingsPanel.style.display = 'none';
  });

  elements.btnSaveSettings.addEventListener('click', handleSaveSettings);

  elements.btnBrowse.addEventListener('click', async () => {
    if (isElectron) {
      const result = await window.electronAPI.selectFolder();
      if (!result.canceled) {
        elements.outputFolder.value = result.path;
      }
    }
  });

  // 日志查看器事件
  elements.btnLogs.addEventListener('click', showLogPanel);
  elements.btnCloseLogs.addEventListener('click', hideLogPanel);
  elements.btnRefreshLogs.addEventListener('click', loadLogs);
  elements.btnOpenLogFile.addEventListener('click', openLogFile);
}

// ========== 添加直播间 ==========
async function handleAddStream() {
  const roomId = elements.inputRoomId.value.trim();
  const profileUrl = elements.inputProfileUrl.value.trim();
  const liveUrl = elements.inputLiveUrl.value.trim();

  // 确定使用哪个输入
  let inputText = '';
  let inputType = '';

  if (roomId) {
    inputText = roomId;
    inputType = 'roomId';
  } else if (profileUrl) {
    inputText = profileUrl;
    inputType = 'profileUrl';
  } else if (liveUrl) {
    inputText = liveUrl;
    inputType = 'liveUrl';
  }

  if (!inputText) {
    showError('请至少输入一个房间号或链接');
    return;
  }

  elements.btnAdd.disabled = true;
  elements.btnAdd.innerHTML = '<span class="spinner"></span> 添加中...';
  hideError();

  try {
    if (isElectron) {
      const result = await window.electronAPI.addStream(inputText);
      if (result.success) {
        showToast(`已添加直播间: ${result.data.streamerName}`, 'success');
        // 清空对应输入框
        if (inputType === 'roomId') elements.inputRoomId.value = '';
        else if (inputType === 'profileUrl') elements.inputProfileUrl.value = '';
        else if (inputType === 'liveUrl') elements.inputLiveUrl.value = '';
        // 刷新列表
        const status = await window.electronAPI.getAllStatus();
        streamsData = status || [];
        renderStreamsList(streamsData);
      } else {
        showError(result.error);
      }
    } else {
      // Demo 模式
      showToast('添加功能仅在桌面应用中可用', 'warning');
    }
  } catch (err) {
    showError('添加失败: ' + err.message);
  } finally {
    elements.btnAdd.disabled = false;
    elements.btnAdd.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> 添加`;
  }
}

// ========== 保存设置 ==========
async function handleSaveSettings() {
  if (isElectron) {
    await window.electronAPI.setConfig('outputFolder', elements.outputFolder.value);
    await window.electronAPI.setConfig('checkInterval', parseInt(elements.checkInterval.value) || 30);
    await window.electronAPI.setConfig('fps', parseInt(elements.fps.value) || 30);
    await window.electronAPI.setConfig('autoStart', elements.autoStart.checked);
    await window.electronAPI.setConfig('minimizeToTray', elements.minimizeToTray.checked);
    await window.electronAPI.setConfig('launchAtLogin', elements.launchAtLogin.checked);
    showToast('设置已保存', 'success');
  }
  elements.settingsPanel.style.display = 'none';
}

// ========== 日志查看器 ==========
async function showLogPanel() {
  elements.logPanel.style.display = 'flex';
  await loadLogs();
}

function hideLogPanel() {
  elements.logPanel.style.display = 'none';
}

async function loadLogs() {
  const logContent = document.getElementById('log-content');
  const logFilePath = document.getElementById('log-file-path');
  
  if (!isElectron) {
    logContent.innerHTML = '<p class="log-loading">日志功能仅在桌面应用中可用</p>';
    return;
  }

  logContent.innerHTML = '<p class="log-loading">加载中...</p>';
  
  try {
    const result = await window.electronAPI.getLogContent();
    logFilePath.textContent = result.path;
    
    if (!result.content) {
      logContent.innerHTML = '<p class="log-loading">暂无日志记录</p>';
      return;
    }

    // Parse and colorize log lines
    const lines = result.content.split('\n');
    const html = lines.map(line => {
      let cls = 'info';
      if (line.includes('[ERROR]')) cls = 'error';
      else if (line.includes('[WARN]')) cls = 'warn';
      return `<div class="log-line ${cls}">${escapeHtml(line)}</div>`;
    }).join('');
    
    logContent.innerHTML = html;
    // Scroll to bottom
    logContent.scrollTop = logContent.scrollHeight;
  } catch (err) {
    logContent.innerHTML = `<p class="log-loading">加载日志失败: ${err.message}</p>`;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function openLogFile() {
  if (isElectron) {
    await window.electronAPI.openLogFile();
  }
}

// ========== 渲染直播间列表 ==========
function renderStreamsList(streams) {
  if (!streams || streams.length === 0) {
    elements.streamsList.innerHTML = '';
    elements.streamsList.appendChild(createEmptyState());
    elements.streamCount.textContent = '0 个直播间';
    elements.recordingCount.textContent = '录制中: 0';
    return;
  }

  elements.streamCount.textContent = `${streams.length} 个直播间`;
  const recordingCount = streams.filter(s => s.status === 'recording').length;
  elements.recordingCount.textContent = `录制中: ${recordingCount}`;

  elements.streamsList.innerHTML = '';
  streams.forEach(stream => {
    elements.streamsList.appendChild(createStreamCard(stream));
  });
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
      <polygon points="23 7 16 12 23 17 23 7"></polygon>
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
    </svg>
    <p>暂无直播间，请粘贴抖音直播链接添加</p>
  `;
  return div;
}

function createStreamCard(stream) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.dataset.roomId = stream.roomId;

  const statusMap = {
    checking: { text: '检测中...', dotClass: 'checking', textClass: '' },
    live: { text: '直播中', dotClass: 'live', textClass: 'live' },
    offline: { text: '未开播', dotClass: '', textClass: '' },
    recording: { text: '录制中', dotClass: 'recording', textClass: 'recording' },
    error: { text: '异常', dotClass: 'error', textClass: '' }
  };

  const status = statusMap[stream.status] || statusMap.checking;
  const initial = (stream.streamerName || '?')[0];
  const isRecording = stream.status === 'recording';
  const isLive = stream.isLive || stream.status === 'live' || stream.status === 'recording';

  // 录制时长
  let durationText = '';
  if (isRecording && stream.recorder && stream.recorder.startTime) {
    const duration = Date.now() - new Date(stream.recorder.startTime).getTime();
    durationText = formatDuration(duration);
  }

  card.innerHTML = `
    <div class="stream-card-header">
      <div class="stream-info">
        <div class="stream-avatar ${isLive ? 'live' : ''}">${initial}</div>
        <div class="stream-meta">
          <div class="stream-name" title="${stream.streamerName || '未知主播'}">${stream.streamerName || '未知主播'}</div>
          <div class="stream-room-id">房间号: ${stream.roomId}</div>
        </div>
      </div>
      <div class="stream-actions">
        ${isRecording
          ? `<button class="btn btn-danger btn-sm" onclick="handleStopRecording('${stream.roomId}')">停止录制</button>`
          : `<button class="btn btn-success btn-sm" onclick="handleStartRecording('${stream.roomId}')" ${!isLive ? 'disabled title="未开播"' : ''}>开始录制</button>`
        }
        <button class="btn btn-ghost btn-sm" onclick="handleRemoveStream('${stream.roomId}')" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </div>
    <div class="stream-card-body">
      <div class="stream-status">
        <span class="status-dot ${status.dotClass}"></span>
        <span class="status-text ${status.textClass}">${status.text}</span>
        ${durationText ? `<span class="stream-duration">${durationText}</span>` : ''}
      </div>
      ${stream.lastCheck ? `<span style="font-size:11px;color:var(--text-muted)">上次检测: ${formatTime(stream.lastCheck)}</span>` : ''}
    </div>
  `;

  return card;
}

// ========== 操作处理 ==========
window.handleStartRecording = async function (roomId) {
  if (!isElectron) {
    showToast('录制功能仅在桌面应用中可用', 'warning');
    return;
  }
  try {
    const result = await window.electronAPI.startRecording(roomId);
    if (result.success) {
      showToast('开始录制', 'success');
    } else {
      showToast('录制失败: ' + result.error, 'error');
    }
  } catch (err) {
    showToast('录制出错: ' + err.message, 'error');
  }
};

window.handleStopRecording = async function (roomId) {
  if (!isElectron) return;
  try {
    const result = await window.electronAPI.stopRecording(roomId);
    if (result.success) {
      showToast('已停止录制', 'success');
    } else {
      showToast('停止失败: ' + result.error, 'error');
    }
  } catch (err) {
    showToast('停止出错: ' + err.message, 'error');
  }
};

window.handleRemoveStream = async function (roomId) {
  if (!confirm('确定要删除这个直播间吗？')) return;
  if (!isElectron) return;
  try {
    const result = await window.electronAPI.removeStream(roomId);
    if (result.success) {
      showToast('已删除', 'success');
      const status = await window.electronAPI.getAllStatus();
      streamsData = status || [];
      renderStreamsList(streamsData);
    }
  } catch (err) {
    showToast('删除出错: ' + err.message, 'error');
  }
};

// ========== 工具函数 ==========
function showError(msg) {
  elements.addError.textContent = msg;
  elements.addError.style.display = 'block';
}

function hideError() {
  elements.addError.style.display = 'none';
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = '0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// ========== Demo 模式（浏览器预览） ==========
function renderDemoMode() {
  const demoStreams = [
    {
      roomId: '7459644624701',
      streamerName: '刘桐桐',
      status: 'recording',
      isLive: true,
      lastCheck: Date.now(),
      recorder: { startTime: new Date(Date.now() - 3661000).toISOString(), frameCount: 108000 }
    },
    {
      roomId: '8392017463820',
      streamerName: '小明同学',
      status: 'live',
      isLive: true,
      lastCheck: Date.now() - 15000,
      recorder: null
    },
    {
      roomId: '6283910475621',
      streamerName: '旅行日记',
      status: 'offline',
      isLive: false,
      lastCheck: Date.now() - 30000,
      recorder: null
    }
  ];

  streamsData = demoStreams;
  renderStreamsList(demoStreams);
  elements.statusText.textContent = '演示模式 - 桌面应用功能完整可用';
}

// 定时更新录制时长
setInterval(() => {
  const recordingStreams = streamsData.filter(s => s.status === 'recording');
  if (recordingStreams.length > 0) {
    recordingStreams.forEach(stream => {
      const card = document.querySelector(`[data-room-id="${stream.roomId}"]`);
      if (card && stream.recorder && stream.recorder.startTime) {
        const durationEl = card.querySelector('.stream-duration');
        if (durationEl) {
          const duration = Date.now() - new Date(stream.recorder.startTime).getTime();
          durationEl.textContent = formatDuration(duration);
        }
      }
    });
  }
}, 1000);

// 启动
document.addEventListener('DOMContentLoaded', init);
