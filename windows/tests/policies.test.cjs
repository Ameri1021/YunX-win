const test = require('node:test');
const assert = require('node:assert/strict');
const { PLATFORMS, platformOf, trustedLogin, httpUrl, publicTask, cleanSettings } = require('../electron/policies.cjs');
test('Windows 平台只有五个网盘和 GitHub', () => {
  assert.deepEqual(PLATFORMS.map(p => p.id), ['quark', 'uc', 'xunlei', 'c139', 'pan123', 'github']);
  assert.throws(() => platformOf('baidu'));
});
test('官方登录来源匹配完整主机边界', () => {
  const platform = platformOf('quark');
  assert.equal(trustedLogin('https://pan.quark.cn/', platform), true);
  for (const url of ['http://pan.quark.cn/', 'https://pan.quark.cn.evil.test/', 'file:///C:/test', 'https://user:password@pan.quark.cn/']) assert.equal(trustedLogin(url, platform), false);
});
test('网页看不到下载请求头、Cookie 和带凭证的持久化规格', () => {
  const value = publicTask({ id: '1', name: 'file', spec: { headers: { Cookie: 'secret' }, url: 'https://example.org/?token=secret' } });
  assert.deepEqual(value, { id: '1', name: 'file' });
});
test('下载协议与设置值域检查', () => {
  assert.throws(() => httpUrl('file:///C:/Windows/system.ini'));
  assert.throws(() => httpUrl('https://user:pass@example.org/file'));
  const settings = cleanSettings({ threads: 999, concurrency: -2, proxyPort: 70000 }, 'C:\\Downloads');
  assert.equal(settings.threads, 32); assert.equal(settings.concurrency, 1); assert.equal(settings.proxyPort, 65535);
});
