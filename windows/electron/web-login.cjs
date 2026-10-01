const crypto = require('node:crypto');
const { trustedLogin } = require('./policies.cjs');

const COOKIE_URLS = {
  quark: 'https://drive-pc.quark.cn/1/clouddrive/file',
  uc: 'https://pc-api.uc.cn/1/clouddrive/file'
};
// 只读取登录所需的已知字段，官方页面没有应用 preload 或 IPC 接口。
const storageScript = platformId => `(() => {
  const result = {};
  for (const name of ['localStorage', 'sessionStorage']) {
    const values = {};
    try {
      const storage = window[name];
      for (const key of ['authorToken', 'access_token', 'accessToken', 'tokenSet',
        'authorization', 'ORCHES-I-ACCOUNT-ENCRYPT', 'Login_UserNumber']) {
        const value = storage.getItem(key);
        if (value) values[key] = value;
      }
      // 迅雷当前版本把登录记录保存在包含 token/user/login 的对象中。
      if (${platformId === 'xunlei'}) for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (/token|user|login|device|^credentials_|^current_sub/i.test(key)) values[key] = storage.getItem(key);
      }
    } catch {}
    result[name] = values;
  }
  return JSON.stringify(result);
})()`;

function tokenValue(value, depth = 0) {
  if (depth > 3) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    try { return tokenValue(JSON.parse(text), depth + 1); } catch {}
    return text.replace(/^Bearer\s+/i, '').trim();
  }
  if (!value || typeof value !== 'object') return '';
  return tokenValue(value.token || value.authorToken || value.access_token || value.accessToken || '', depth + 1);
}

function cookieMap(cookies) {
  // 同名 Cookie 优先采用更具体的路径和域，避免其他登录域的旧值覆盖业务会话。
  const sorted = [...cookies].sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0) ||
    b.domain.replace(/^\./, '').length - a.domain.replace(/^\./, '').length);
  const values = new Map();
  for (const cookie of sorted) if (cookie.value && !values.has(cookie.name)) values.set(cookie.name, cookie.value);
  return values;
}

function credentialFromSources(platformId, cookies, storage = {}) {
  const unique = cookieMap(cookies);
  const sources = [storage.localStorage || {}, storage.sessionStorage || {}];
  if (['quark', 'uc', 'c139'].includes(platformId)) {
    if (platformId === 'c139') {
      for (const values of sources) for (const key of ['authorization', 'ORCHES-I-ACCOUNT-ENCRYPT', 'Login_UserNumber']) {
        if (values[key] && !unique.has(key)) unique.set(key, values[key]);
      }
      if (!unique.has('authorization') && !(unique.has('Os_SSo_Sid') && unique.has('RMKEY'))) return null;
    } else if (!unique.has('__pus') || !unique.has('__puus')) return null;
    return { cookie: [...unique].map(([key, value]) => `${key}=${value}`).join('; ') };
  }
  if (platformId === 'pan123') {
    for (const values of sources) for (const key of ['authorToken', 'access_token', 'accessToken', 'tokenSet']) {
      const token = tokenValue(values[key]);
      if (token.length >= 20 && !/[\r\n]/.test(token)) return { token };
    }
    const token = tokenValue(unique.get('sso-token'));
    return token.length >= 20 && !/[\r\n]/.test(token) ? { token } : null;
  }
  if (platformId !== 'xunlei') return null;
  const data = {};
  for (const values of [...sources].reverse()) {
    for (const [key, value] of Object.entries(values)) if (/token|user|login|^credentials_/i.test(key)) {
      try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') Object.assign(data, parsed); } catch {}
    }
    Object.assign(data, values);
  }
  const accessToken = tokenValue(data.access_token || data.accessToken);
  if (!accessToken) return null;
  const record = { accessToken, refreshToken: tokenValue(data.refresh_token || data.refreshToken), captchaToken: tokenValue(data.captcha_token || data.captchaToken) };
  const deviceId = tokenValue(data.device_id || data.deviceId);
  if (deviceId) record.deviceId = deviceId;
  return record;
}

async function readWebCredential(platform, loginSession, webContents, observed = {}) {
  if (webContents.isDestroyed() || !trustedLogin(webContents.getURL(), platform)) return null;
  const cookies = (await loginSession.cookies.get(COOKIE_URLS[platform.id] ? { url: COOKIE_URLS[platform.id] } : {}))
    .filter(cookie => platform.hosts.some(host => cookie.domain.replace(/^\./, '') === host || cookie.domain.endsWith('.' + host)));
  let storage = {};
  if (!['quark', 'uc'].includes(platform.id)) {
    if (webContents.isDestroyed() || !trustedLogin(webContents.getURL(), platform)) return null;
    storage = JSON.parse(await webContents.executeJavaScript(storageScript(platform.id)));
    if (webContents.isDestroyed() || !trustedLogin(webContents.getURL(), platform)) return null;
  }
  const record = credentialFromSources(platform.id, cookies, storage);
  if (platform.id === 'xunlei' && observed.accessToken) return { ...(record || {}), ...observed };
  return record;
}

function observeXunleiRequest(details) {
  try {
    const url = new URL(details.url);
    if (url.protocol !== 'https:' || url.hostname !== 'api-pan.xunlei.com' || !url.pathname.startsWith('/drive/v1/')) return null;
    const headers = new Map(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]));
    const accessToken = tokenValue(headers.get('authorization'));
    if (!accessToken || !/^Bearer\s+/i.test(headers.get('authorization') || '')) return null;
    const record = { accessToken };
    for (const [name, key] of [['x-device-id', 'deviceId'], ['x-captcha-token', 'captchaToken']]) {
      if (headers.get(name)) record[key] = headers.get(name);
    }
    return record;
  } catch { return null; }
}

function crc32Hex(value) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(value)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16);
}

function pan123Sign(path, ts = Math.floor(Date.now() / 1000), random = crypto.randomInt(10000000)) {
  const minute = new Date((ts + 57600) * 1000).toISOString().replace(/\D/g, '').slice(0, 12);
  const key = crc32Hex([...minute].map(digit => 'adefghlmyijnopkqrstubcvwsz'[Number(digit)]).join(''));
  return { 'auth-key': key, 'auth-value': `${ts}-${random}-${crc32Hex(`${ts}|${random}|${path}|web|3|${key}`)}` };
}

function accountNickname(platformId, json) {
  const data = json?.data;
  if (!data || typeof data !== 'object') return null;
  if (platformId === 'quark') {
    if (json.success !== true) return null;
    return typeof data.nickname === 'string' && data.nickname.trim() ? data.nickname : null;
  }
  if (platformId === 'pan123' && [0, 200].includes(Number(json.code))) {
    const nickname = data.Nickname || data.nickname;
    return typeof nickname === 'string' && nickname.trim() ? nickname : null;
  }
  return null;
}

async function validateWebCredential(platformId, record, loginSession) {
  // 校验与官方登录页共用 Chromium 网络环境，避免系统代理/证书差异阻断保存。
  const url = platformId === 'quark' ? 'https://pan.quark.cn/account/info' : 'https://api.123pan.cn/b/api/user/info';
  const headers = { Accept: 'application/json, text/plain, */*' };
  if (platformId === 'quark') headers.Cookie = record.cookie;
  else if (platformId === 'pan123') Object.assign(headers, {
    Authorization: 'Bearer ' + record.token, platform: 'web', 'app-version': '3',
    loginuuid: crypto.randomBytes(16).toString('hex'), ...pan123Sign('/b/api/user/info')
  });
  else throw new Error('不支持的网页登录校验');
  const response = await loginSession.fetch(url, { headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('登录信息校验暂未通过');
  const nickname = accountNickname(platformId, await response.json());
  if (!nickname) throw new Error('登录信息校验暂未通过');
  return { ...record, nickname };
}

function createLoginMonitor({ readCandidate, validate, save, onSuccess, onStatus, isActive, now = Date.now }) {
  let checking = false, stopped = false, failedHash = '', failures = 0, retryAt = 0;
  const active = () => !stopped && isActive();
  return {
    stop() { stopped = true; },
    async check() {
      if (checking || !active()) return;
      checking = true;
      let hash = '';
      try {
        const record = await readCandidate();
        if (!record || !active()) return;
        hash = crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
        if (hash === failedHash && now() < retryAt) return;
        if (hash !== failedHash) failures = 0;
        onStatus('checking');
        const validated = await validate(record);
        if (!active()) return;
        await save(validated);
        if (!active()) return;
        stopped = true;
        onSuccess();
      } catch {
        if (!active()) return;
        if (hash) {
          failedHash = hash;
          retryAt = now() + Math.min(30000, 2000 * (2 ** Math.min(failures++, 4)));
        }
        onStatus('retry');
      } finally { checking = false; }
    }
  };
}

module.exports = { credentialFromSources, readWebCredential, observeXunleiRequest, pan123Sign, accountNickname, validateWebCredential, createLoginMonitor };
