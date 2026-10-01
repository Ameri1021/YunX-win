const path = require('node:path');
const PLATFORMS = Object.freeze([
  { id: 'quark', name: '夸克网盘', letter: 'Q', color: '#6474f0', login: 'https://pan.quark.cn/?fr=pc&platform=pc', hosts: ['quark.cn', 'quark.com'] },
  { id: 'uc', name: 'UC 网盘', letter: 'U', color: '#ec9657', login: 'https://drive.uc.cn/', hosts: ['uc.cn', 'ucweb.com'] },
  { id: 'xunlei', name: '迅雷网盘', letter: 'X', color: '#568bec', login: 'https://pan.xunlei.com/', hosts: ['xunlei.com', 'xunlei.cn'] },
  { id: 'c139', name: '139 网盘', letter: 'M', color: '#54a788', login: 'https://yun.139.com/', hosts: ['139.com', '10086.cn', 'cmcc.com'] },
  { id: 'pan123', name: '123 云盘', letter: '1', color: '#6c8eec', login: 'https://yun.123pan.cn/', hosts: ['123pan.com', '123pan.cn', '123865.com', '123684.com'] },
  { id: 'github', name: 'GitHub', letter: 'G', color: '#798196', hosts: ['github.com'] }
]);
function platformOf(id) {
  const platform = PLATFORMS.find(p => p.id === id);
  if (!platform) throw new Error('不支持的平台');
  return platform;
}
function trustedLogin(url, platform) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      platform.hosts.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host));
  } catch { return false; }
}
function httpUrl(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('仅支持 HTTP / HTTPS 地址');
  return parsed.href;
}
function publicTask(task) {
  const { spec, ...safe } = task;
  return safe;
}
function cleanSettings(value, downloadDir) {
  return {
    downloadDir: typeof value.downloadDir === 'string' && path.isAbsolute(value.downloadDir) ? path.normalize(value.downloadDir) : downloadDir,
    threads: Math.max(1, Math.min(32, Number(value.threads) || 8)),
    concurrency: Math.max(1, Math.min(5, Number(value.concurrency) || 3)),
    speedLimit: Math.max(0, Math.min(1024 * 1024 * 1024, Number(value.speedLimit) || 0)),
    mirrorPrefix: typeof value.mirrorPrefix === 'string' && value.mirrorPrefix.startsWith('https://') ? value.mirrorPrefix : '',
    proxyHost: typeof value.proxyHost === 'string' ? value.proxyHost.trim().slice(0, 253) : '',
    proxyPort: Math.max(0, Math.min(65535, Number(value.proxyPort) || 0)),
    theme: ['light', 'dark', 'system'].includes(value.theme) ? value.theme : 'system'
  };
}
function readableError(error) {
  return String(error?.message || error || '操作失败').replace(/https?:\/\/[^\s]+/g, '[链接]')
    .replace(/(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_.-]+)/g, '[凭证]').slice(0, 500);
}
module.exports = { PLATFORMS, platformOf, trustedLogin, httpUrl, publicTask, cleanSettings, readableError };
