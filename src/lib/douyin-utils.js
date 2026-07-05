/**
 * 抖音工具模块
 * 负责解析分享链接、提取主播名称、判断直播状态
 */
const { net } = require('electron');

/**
 * 从用户粘贴的分享文本中提取抖音链接
 * 支持格式：
 * - https://v.douyin.com/xxxxx/
 * - https://live.douyin.com/XXXXXXX
 * - https://www.douyin.com/user/xxxxx
 * 以及包含链接的分享文本
 */
function extractUrl(text) {
  if (!text || typeof text !== 'string') return null;

  // 匹配所有可能的抖音链接
  const urlPatterns = [
    /https?:\/\/v\.douyin\.com\/[A-Za-z0-9]+\/?/g,
    /https?:\/\/live\.douyin\.com\/\d+/g,
    /https?:\/\/www\.douyin\.com\/user\/[A-Za-z0-9_-]+/g
  ];

  for (const pattern of urlPatterns) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      return matches[0];
    }
  }
  return null;
}

/**
 * 从分享文本中提取主播名称
 * 支持格式：【主播名】
 */
function extractNameFromText(text) {
  if (!text) return null;
  const match = text.match(/【(.+?)】/);
  return match ? match[1] : null;
}

/**
 * 解析短链接，获取重定向后的真实URL
 * 返回 { roomId, realUrl }
 */
function resolveShortUrl(shortUrl) {
  return new Promise((resolve, reject) => {
    // 短链接需要跟踪重定向
    if (shortUrl.includes('v.douyin.com')) {
      const request = net.request({
        method: 'GET',
        url: shortUrl,
        redirect: 'manual'
      });

      request.on('redirect', (statusCode, method, redirectUrl) => {
        request.abort();
        const roomIdMatch = redirectUrl.match(/live\.douyin\.com\/(\d+)/);
        if (roomIdMatch) {
          resolve({ roomId: roomIdMatch[1], realUrl: redirectUrl });
        } else {
          // 可能还需要继续跟踪
          resolve({ roomId: null, realUrl: redirectUrl });
        }
      });

      request.on('response', (response) => {
        const statusCode = response.statusCode;
        if (statusCode >= 300 && statusCode < 400) {
          const location = response.headers['location'];
          const loc = Array.isArray(location) ? location[0] : location;
          if (loc) {
            const roomIdMatch = loc.match(/live\.douyin\.com\/(\d+)/);
            if (roomIdMatch) {
              resolve({ roomId: roomIdMatch[1], realUrl: loc });
              return;
            }
          }
        }
        // 如果直接返回200，尝试从URL解析
        const roomIdMatch = shortUrl.match(/live\.douyin\.com\/(\d+)/);
        resolve({
          roomId: roomIdMatch ? roomIdMatch[1] : null,
          realUrl: shortUrl
        });
      });

      request.on('error', (error) => {
        reject(new Error(`网络请求失败: ${error.message}`));
      });

      // 设置超时
      setTimeout(() => {
        request.abort();
        reject(new Error('请求超时'));
      }, 10000);

      request.end();
    } else {
      // 直接链接，提取roomId
      const roomIdMatch = shortUrl.match(/live\.douyin\.com\/(\d+)/);
      resolve({
        roomId: roomIdMatch ? roomIdMatch[1] : null,
        realUrl: shortUrl
      });
    }
  });
}

/**
 * 构建直播间URL
 */
function buildLiveUrl(roomId) {
  return `https://live.douyin.com/${roomId}`;
}

/**
 * 生成录制文件名
 * 格式：[主播名称][年-月-日-时-分-秒].mp4
 */
function generateFileName(streamerName) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  // 清理文件名中的非法字符
  const safeName = (streamerName || '未知主播').replace(/[<>:"/\\|?*]/g, '_');
  return `${safeName}_${timestamp}`;
}

module.exports = {
  extractUrl,
  extractNameFromText,
  resolveShortUrl,
  buildLiveUrl,
  generateFileName
};
