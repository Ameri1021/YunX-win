const test = require('node:test');
const assert = require('node:assert/strict');
const { credentialFromSources, readWebCredential, observeXunleiRequest, pan123Sign, accountNickname, validateWebCredential, createLoginMonitor } = require('../electron/web-login.cjs');
const { platformOf } = require('../electron/policies.cjs');
const token = 'synthetic-login-token-1234567890';
const cookie = (name, value, domain = '.quark.cn', path = '/') => ({ name, value, domain, path });

test('迅雷提取官网 credentials 记录并保留刷新、设备与验证码字段', async () => {
  const storage = { localStorage: { credentials_Xqp0kJBXWhwaTpB6: JSON.stringify({ access_token: token, refresh_token: 'synthetic-refresh' }), device_id: '"synthetic-device"', captcha_token: 'synthetic-captcha' } };
  const record = credentialFromSources('xunlei', [], storage);
  assert.deepEqual(record, { accessToken: token, refreshToken: 'synthetic-refresh', deviceId: 'synthetic-device', captchaToken: 'synthetic-captcha' });
  const observed = observeXunleiRequest({ url: 'https://api-pan.xunlei.com/drive/v1/files', requestHeaders: { Authorization: 'Bearer ' + token, 'X-Device-Id': 'real-device', 'x-captcha-token': 'real-captcha' } });
  assert.deepEqual(observed, { accessToken: token, deviceId: 'real-device', captchaToken: 'real-captcha' });
  assert.equal(observeXunleiRequest({ url: 'https://api-pan.xunlei.com.evil.test/drive/v1/files', requestHeaders: { Authorization: 'Bearer ' + token } }), null);
  const merged = await readWebCredential(platformOf('xunlei'), { cookies: { get: async () => [] } }, {
    isDestroyed: () => false, getURL: () => platformOf('xunlei').login, executeJavaScript: async () => JSON.stringify(storage)
  }, observed);
  assert.equal(merged.deviceId, 'real-device'); assert.equal(merged.refreshToken, 'synthetic-refresh');
});

test('123 登录支持原始值、JSON、Bearer、会话存储和单点登录 Cookie', () => {
  for (const value of [token, JSON.stringify(token), JSON.stringify({ token }), 'Bearer ' + token, JSON.stringify({ accessToken: token })]) {
    assert.deepEqual(credentialFromSources('pan123', [], { localStorage: { authorToken: value } }), { token });
  }
  assert.deepEqual(credentialFromSources('pan123', [], { sessionStorage: { accessToken: token } }), { token });
  assert.deepEqual(credentialFromSources('pan123', [], { localStorage: { tokenSet: JSON.stringify({ token, remember: 'no' }) } }), { token });
  assert.deepEqual(credentialFromSources('pan123', [cookie('sso-token', token, '.123pan.cn')]), { token });
  assert.equal(credentialFromSources('pan123', [], { localStorage: { authorToken: 'null', userin: JSON.stringify({ Nickname: '访客' }) } }), null);
});

test('夸克等待完整会话，使用业务地址的 Cookie 并排除其他登录域', async () => {
  const platform = platformOf('quark');
  assert.equal(credentialFromSources('quark', [cookie('__pus', 'partial')]), null);
  const record = await readWebCredential(platform, { cookies: { get: async filter => {
    assert.equal(filter.url, 'https://drive-pc.quark.cn/1/clouddrive/file');
    return [cookie('__pus', 'current'), cookie('__puus', 'current-session'), cookie('__pus', 'outside', '.evil.test')];
  } } }, { isDestroyed: () => false, getURL: () => platform.login });
  assert.equal(record.cookie, '__pus=current; __puus=current-session');
  assert.equal(credentialFromSources('quark', [cookie('__pus', 'old'), cookie('__pus', 'current', 'drive-pc.quark.cn'), cookie('__puus', 'session')]).cookie,
    '__pus=current; __puus=session');
});

test('离开官方主页面后不读取或保存网页凭证', async () => {
  let reads = 0;
  const loginSession = { cookies: { get: async () => { reads++; return []; } } };
  const wc = { isDestroyed: () => false, getURL: () => 'https://yun.123pan.cn.evil.test/' };
  assert.equal(await readWebCredential(platformOf('pan123'), loginSession, wc), null);
  assert.equal(reads, 0);
  let current = platformOf('pan123').login;
  wc.getURL = () => current;
  wc.executeJavaScript = async () => { current = 'https://evil.test/'; return JSON.stringify({ localStorage: { authorToken: token } }); };
  assert.equal(await readWebCredential(platformOf('pan123'), loginSession, wc), null);
});

test('账号校验拒绝访客和过期响应，兼容 123 的成功返回格式', () => {
  assert.equal(accountNickname('quark', { success: true, code: 'OK', data: {} }), null);
  assert.equal(accountNickname('quark', { success: false, data: { nickname: '访客' } }), null);
  assert.equal(accountNickname('quark', { success: true, data: { nickname: '测试用户' } }), '测试用户');
  assert.equal(accountNickname('pan123', { code: 401, data: { Nickname: '过期用户' } }), null);
  assert.equal(accountNickname('pan123', { code: 0, data: { Nickname: '' } }), null);
  assert.equal(accountNickname('pan123', { code: 200, data: { nickname: '测试用户' } }), '测试用户');
  assert.deepEqual(pan123Sign('/b/api/user/info', 1700000000, 1234567), { 'auth-key': 'f2ac3dd', 'auth-value': '1700000000-1234567-b6459abb' });
});

test('网页登录校验限定官方接口且禁止携带凭证重定向', async () => {
  let requests = 0;
  const loginSession = { fetch: async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.123pan.cn/b/api/user/info');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    return { ok: true, json: async () => ({ code: 0, data: { Nickname: '测试用户' } }) };
  } };
  assert.deepEqual(await validateWebCredential('pan123', { token }, loginSession), { token, nickname: '测试用户' });
  await assert.rejects(validateWebCredential('github', { token }, loginSession));
  assert.equal(requests, 1);
});

test('首次失败后同一凭证会自动重试，校验成功才保存并完成登录', async () => {
  let time = 0, attempts = 0, saved = 0, completed = 0;
  const statuses = [];
  const monitor = createLoginMonitor({
    readCandidate: async () => ({ token }), isActive: () => true, now: () => time,
    validate: async record => { if (++attempts === 1) throw new Error('临时网络错误'); return { ...record, nickname: '测试用户' }; },
    save: async record => { assert.equal(record.nickname, '测试用户'); saved++; },
    onSuccess: () => completed++, onStatus: status => statuses.push(status)
  });
  await monitor.check();
  assert.equal(saved, 0);
  await monitor.check();
  assert.equal(attempts, 1);
  time = 2000;
  await monitor.check(); await monitor.check();
  assert.equal(attempts, 2); assert.equal(saved, 1); assert.equal(completed, 1);
  assert.deepEqual(statuses, ['checking', 'retry', 'checking']);
});

test('凭证变化立即校验，失败采用有限退避且不并发重复保存', async () => {
  let time = 0, attempts = 0, value = token;
  const monitor = createLoginMonitor({
    readCandidate: async () => ({ token: value }), isActive: () => true, now: () => time,
    validate: async () => { attempts++; throw new Error('校验失败'); },
    save: () => assert.fail('失败凭证不能保存'), onSuccess: () => assert.fail('失败不能报成功'), onStatus: () => {}
  });
  await Promise.all([monitor.check(), monitor.check()]); assert.equal(attempts, 1);
  value += '-new';
  await monitor.check(); assert.equal(attempts, 2);
  time = 2000; await monitor.check(); assert.equal(attempts, 3);
  time = 4000; await monitor.check(); assert.equal(attempts, 3);
  time = 6000; await monitor.check(); assert.equal(attempts, 4);
});

test('关闭登录窗口后丢弃仍在校验的结果，避免退出账号后被回写', async () => {
  let finish;
  const validation = new Promise(resolve => { finish = resolve; });
  const monitor = createLoginMonitor({
    readCandidate: async () => ({ token }), isActive: () => true,
    validate: () => validation, save: () => assert.fail('窗口关闭后不得保存'),
    onSuccess: () => assert.fail('窗口关闭后不得通知'), onStatus: () => {}
  });
  const check = monitor.check();
  await Promise.resolve();
  monitor.stop(); finish({ token, nickname: '测试用户' });
  await check;
});
