const test = require('node:test');
const assert = require('node:assert/strict');
const { NetworkBridge, proxyConfiguration } = require('../electron/network-bridge.cjs');

test('网络通道按消费确认分块传输，大文件不一次性缓存在进程内', async () => {
  const data = Buffer.alloc(200000, 23);
  const chunks = [];
  let bridge;
  bridge = new NetworkBridge(async (_url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.get('accept-encoding'), 'identity');
    return new Response(data, { status: 206, headers: { 'Content-Length': String(data.length), 'Content-Range': 'bytes 0-199999/200000' } });
  }, (method, params) => {
    if (method === 'network.chunk') {
      const chunk = Buffer.from(params.body, 'base64'); assert.ok(chunk.length <= 65536); chunks.push(chunk);
      queueMicrotask(() => bridge.acknowledge(params.id));
    }
  });
  await bridge.request({ id: '1', url: 'https://example.test/file', method: 'GET', headers: [] });
  assert.deepEqual(Buffer.concat(chunks), data); assert.equal(bridge.active.size, 0);
});

test('跨来源重定向剥离凭证且保留 Range，拒绝带用户名或文件协议的目标', async () => {
  let count = 0;
  const events = [];
  const bridge = new NetworkBridge(async (_url, options) => {
    if (++count === 1) return new Response(null, { status: 302, headers: { Location: 'https://other.test/file' } });
    assert.equal(options.headers.has('cookie'), false); assert.equal(options.headers.has('authorization'), false);
    assert.equal(options.headers.get('range'), 'bytes=0-0');
    return new Response(null, { status: 204 });
  }, (method, params) => events.push({ method, params }));
  await bridge.request({ id: '1', url: 'https://example.test/file', method: 'GET', headers: [['Cookie', 'synthetic-cookie'], ['Authorization', 'Bearer synthetic-token'], ['Range', 'bytes=0-0']] });
  assert.equal(count, 2); assert.equal(events[0].params.status, 204);
  for (const url of ['file:///C:/Windows/test', 'https://user:password@example.test/']) await bridge.request({ id: '2', url, method: 'GET', headers: [] });
  assert.equal(count, 2); assert.equal(events.filter(event => event.method === 'network.error').length, 2);
});

test('关闭响应流及时取消网络连接，不等待大文件读完', async () => {
  let bridge;
  let signal;
  const events = [];
  bridge = new NetworkBridge(async (_url, options) => { signal = options.signal; return new Response(Buffer.alloc(200000)); }, (method, params) => {
    events.push(method); if (method === 'network.chunk') bridge.cancel(params.id);
  });
  await bridge.request({ id: '1', url: 'https://example.test/file', method: 'GET', headers: [] });
  assert.equal(signal.aborted, true); assert.deepEqual(events, ['network.response', 'network.chunk']); assert.equal(bridge.active.size, 0);
});

test('网络错误只发送固定标记，不透传服务器错误或凭证', async () => {
  const events = [];
  const bridge = new NetworkBridge(async () => { throw new Error('Cookie=synthetic-secret'); }, (method, params) => events.push({ method, params }));
  await bridge.request({ id: '1', url: 'https://example.test/', method: 'GET', headers: [] });
  assert.deepEqual(events, [{ method: 'network.error', params: { id: '1' } }]);
});

test('手动代理与系统代理均保留，回环地址始终旁路', () => {
  assert.deepEqual(proxyConfiguration({}), { mode: 'system' });
  const config = proxyConfiguration({ proxyHost: '127.0.0.1', proxyPort: 7897 });
  assert.equal(config.proxyRules, 'http=127.0.0.1:7897;https=127.0.0.1:7897');
  assert.ok(config.proxyBypassRules.includes('127.*'));
  assert.throws(() => proxyConfiguration({ proxyHost: 'host;DIRECT', proxyPort: 80 }));
});
