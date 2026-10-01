const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { session } = require('electron');
const { platformOf } = require('../electron/policies.cjs');
const { SecureStore } = require('../electron/store.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 使用隔离数据与模拟官网验证自动登录，绝不读取个人登录会话。 */
async function verifyWebLogin({ app, store, mainWindow, operations, safeStorage, loginWindows, networkSession }) {
  for (const platformId of ['quark', 'pan123', 'xunlei']) {
    const platform = platformOf(platformId);
    const loginSession = session.fromPartition('persist:yunx-login-' + platformId);
    const secret = 'synthetic-web-login-secret-' + platformId;
    let checks = 0, lists = 0;
    await networkSession.protocol.handle('https', request => {
      const url = new URL(request.url);
      if (platformId === 'quark') assert.ok(request.headers.get('cookie')?.includes('__pus=' + secret));
      else assert.equal(request.headers.get('authorization'), 'Bearer ' + secret);
      if (platformId === 'xunlei') {
        assert.equal(request.headers.has('origin'), false);
        if (request.headers.get('x-device-id') !== 'synthetic-web-device') return new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
        if (url.pathname === '/drive/v1/about') {
          if (++checks === 1) return new Response('{}', { status: 503 });
          return new Response(JSON.stringify({ quota: { usage: '0', limit: '100000' } }));
        }
      }
      if (++lists === 1) return new Response(JSON.stringify({ status: 503, code: 503, error: 'unavailable', message: '模拟列表请求暂不可用' }), { status: 503 });
      const fixture = platformId === 'quark' ? { status: 200, data: { list: [{ fid: '101', file_name: '测试目录', dir: true }, { fid: '102', file_name: '验证文件.txt', size: 123, dir: false }] } } :
        platformId === 'pan123' ? { code: 0, data: { Next: '-1', InfoList: [{ FileId: 101, FileName: '测试目录', Type: 1 }, { FileId: 102, FileName: '验证文件.txt', Size: 123, Type: 0, S3KeyFlag: 'test', Etag: 'test' }] } } :
          { files: [{ id: '101', name: '测试目录', kind: 'drive#folder', size: '0' }, { id: '102', name: '验证文件.txt', kind: 'drive#file', size: '123' }], next_page_token: '' };
      return new Response(JSON.stringify(fixture), { headers: { 'Content-Type': 'application/json' } });
    });
    await loginSession.protocol.handle('https', request => {
      const url = new URL(request.url);
      const account = platformId === 'quark' ? url.href === 'https://pan.quark.cn/account/info' : url.href === 'https://api.123pan.cn/b/api/user/info';
      if (account) {
        if (platformId === 'quark') assert.ok(request.headers.get('cookie')?.includes('__pus=' + secret));
        else assert.equal(request.headers.get('authorization'), 'Bearer ' + secret);
        if (++checks === 1) return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
        const data = platformId === 'quark' ? { success: true, data: { nickname: '模拟夸克用户' } } : { code: 0, data: { Nickname: '模拟123用户' } };
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      }
      if (platformId === 'xunlei' && url.hostname === 'api-pan.xunlei.com') return new Response('{}', {
        headers: { 'Access-Control-Allow-Origin': 'https://pan.xunlei.com', 'Access-Control-Allow-Headers': 'authorization,x-device-id,x-captcha-token' }
      });
      if (url.origin !== new URL(platform.login).origin) return new Response('', { status: 403 });
      const script = platformId === 'pan123' ? `localStorage.setItem('authorToken', ${JSON.stringify(JSON.stringify({ token: 'Bearer ' + secret }))});` :
        platformId === 'xunlei' ? `localStorage.setItem('credentials_Xqp0kJBXWhwaTpB6', ${JSON.stringify(JSON.stringify({ access_token: secret, refresh_token: 'synthetic-refresh', device_id: 'synthetic-web-device', captcha_token: 'synthetic-web-captcha' }))});
          fetch('https://api-pan.xunlei.com/drive/v1/about', {headers:{Authorization:${JSON.stringify('Bearer ' + secret)},'X-Device-Id':'synthetic-web-device','X-Captcha-Token':'synthetic-web-captcha'}}).catch(()=>{});` : '';
      return new Response(`<html><head><meta charset="utf-8"></head><body>模拟官网登录<script>${script}</script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
    });
    try {
      if (platformId === 'quark') {
        await loginSession.cookies.set({ url: 'https://drive-pc.quark.cn/', domain: '.quark.cn', name: '__pus', value: secret, secure: true });
        // 登录子域的旧值不得覆盖业务地址所用的 Cookie。
        await loginSession.cookies.set({ url: 'https://login.quark.cn/', domain: 'login.quark.cn', name: '__pus', value: 'synthetic-stale-login', secure: true });
      }
      await operations.login({ platform: platformId });
      const window = loginWindows.get(platformId);
      assert.equal(await window.webContents.executeJavaScript('Boolean(window.yunx || window.require)'), false);
      assert.equal(window.webContents.getLastWebPreferences().preload, undefined);
      if (platformId === 'quark') {
        await delay(2200); assert.equal(checks, 0); assert.equal(Boolean(store.state.credentials.quark), false);
        await loginSession.cookies.set({ url: 'https://drive-pc.quark.cn/', domain: '.quark.cn', name: '__puus', value: 'synthetic-session', secure: true });
      }
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !window.isDestroyed()) await delay(100);
      assert.equal(window.isDestroyed(), true, platformId + ' 自动保存后应关闭登录窗口');
      assert.ok(checks >= 2, platformId + ' 首次校验失败后应重试');
      const restored = new SecureStore(app.getPath('userData'), safeStorage);
      assert.ok(restored.state.credentials[platformId].nickname);
      assert.equal(fs.readFileSync(store.file, 'utf8').includes(secret), false);
      const publicState = await operations.state();
      assert.equal(publicState.accounts.find(account => account.id === platformId).loggedIn, true);
      assert.equal(JSON.stringify(publicState).includes(secret), false);
      assert.equal(await mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('#account-list [data-op="logout"][data-platform="${platformId}"]'))`), true);
      if (platformId === 'xunlei') assert.equal(restored.state.credentials.xunlei.deviceId, 'synthetic-web-device');
      await assert.rejects(mainWindow.webContents.executeJavaScript(`window.yunx.invoke('cloud', {platform:'${platformId}'})`));
      const listing = await mainWindow.webContents.executeJavaScript(`window.yunx.invoke('cloud', {platform:'${platformId}'})`);
      assert.equal(listing.items.length, 2); assert.equal(listing.items[0].isDir, true);
      assert.equal(listing.items[1].name, '验证文件.txt');
      const child = await mainWindow.webContents.executeJavaScript(`window.yunx.invoke('list', ${JSON.stringify({ sessionId: listing.sessionId, directory: listing.items[0].id })})`);
      assert.equal(child.items.length, 2); assert.equal(JSON.stringify(child).includes(secret), false);
      await operations.logout({ platform: platformId });
      assert.equal(store.state.credentials[platformId], undefined);
    } finally {
      loginWindows.get(platformId)?.close();
      loginSession.protocol.unhandle('https');
      networkSession.protocol.unhandle('https');
    }
  }
}

/** 隐藏窗口完成真实 IPC、Windows 加密、下载和界面检查，不使用个人账号。 */
async function run({ app, core, store, mainWindow, operations, safeStorage, loginWindows, networkSession }) {
  const output = app.isPackaged ? path.join(app.getPath('userData'), 'verification') : path.resolve(__dirname, '..', 'artifacts');
  fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-download-smoke-'));
  const data = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    let from = 0, to = data.length - 1;
    if (range) {
      const parts = /bytes=(\d+)-(\d*)/.exec(range);
      from = Number(parts[1]); to = parts[2] ? Math.min(Number(parts[2]), to) : to;
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${data.length}`, 'Content-Length': to - from + 1, 'Content-Type': 'application/octet-stream' });
    } else res.writeHead(200, { 'Content-Length': data.length, 'Content-Type': 'application/octet-stream' });
    const write = () => {
      if (res.destroyed) return;
      const end = Math.min(from + 16384, to + 1);
      res.write(data.subarray(from, end)); from = end;
      if (from > to) res.end(); else setTimeout(write, 7);
    };
    write();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const errors = [];
  mainWindow.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  try {
    if (mainWindow.webContents.isLoading()) await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
    await delay(500);
    // 隐藏窗口的动画时钟可能节流；截图检查最终布局，不捕捉过渡帧。
    await mainWindow.webContents.insertCSS('*,*::before,*::after{animation:none!important;transition:none!important}');
    // 验证监听器确实能捕捉错误，避免 Electron 参数升级让检查失效。
    await mainWindow.webContents.executeJavaScript('console.error("yunx-smoke-console-check")');
    await delay(50);
    assert.ok(errors.includes('yunx-smoke-console-check'));
    errors.splice(errors.indexOf('yunx-smoke-console-check'), 1);
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    assert.equal(await mainWindow.webContents.executeJavaScript('Boolean(window.yunx && !window.require)'), true);
    const state = await mainWindow.webContents.executeJavaScript('window.yunx.invoke("state")');
    assert.equal(state.accounts.length, 6);
    assert.equal(state.accounts.some(account => account.id === 'baidu'), false);
    store.state.credentials.github = { token: 'synthetic-test-secret' }; store.save();
    assert.equal(fs.readFileSync(store.file, 'utf8').includes('synthetic-test-secret'), false);
    delete store.state.credentials.github; store.save();
    await verifyWebLogin({ app, store, mainWindow, operations, safeStorage, loginWindows, networkSession });
    const github = await core.request('share.resolve', { text: 'https://github.com/example/repository/releases/download/v1/example.zip' });
    assert.equal(github.items[0].name, 'example.zip');
    await assert.rejects(core.request('share.resolve', { text: 'https://pan.baidu.com/s/1removed?pwd=1234' }));
    await operations.settings({ ...store.state.settings, downloadDir: directory, threads: 4 });
    const task = await mainWindow.webContents.executeJavaScript(`window.yunx.invoke('downloadUrl', ${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/file`, name: '桌面验证.bin' })})`);
    const deadline = Date.now() + 20000;
    let current, paused = false;
    while (Date.now() < deadline) {
      current = store.state.tasks.find(item => item.id === task.id);
      if (!paused && current?.status === 'downloading' && current.downloaded > 100000) {
        await operations.pause({ id: task.id });
        assert.equal(store.state.tasks.find(item => item.id === task.id).status, 'paused');
        await operations.resume({ id: task.id }); paused = true;
      }
      if (['completed', 'failed'].includes(current?.status)) break;
      await delay(50);
    }
    assert.equal(current.status, 'completed', current.error);
    assert.equal(paused, true, '流式网络通道应支持暂停续传');
    assert.deepEqual(fs.readFileSync(current.path), data);
    assert.equal(await mainWindow.webContents.executeJavaScript('document.querySelectorAll("#platform-chips .platform-chip").length'), 6);
    for (const page of ['resolve', 'accounts', 'downloads', 'bookmarks', 'settings']) {
      await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-page="${page}"]').click()`);
      await mainWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      assert.equal(await mainWindow.webContents.executeJavaScript(`document.querySelector('#page-${page}').hidden`), false);
      const screenshot = await mainWindow.webContents.capturePage();
      fs.writeFileSync(path.join(output, page + '.png'), screenshot.toPNG());
      const overflow = await mainWindow.webContents.executeJavaScript('document.documentElement.scrollWidth > window.innerWidth');
      assert.equal(overflow, false, page + ' 横向溢出');
    }
    await operations.settings({ ...store.state.settings, theme: 'dark' });
    await mainWindow.webContents.executeJavaScript('document.querySelector("[data-page=resolve]").click()');
    await mainWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await mainWindow.webContents.executeJavaScript('document.documentElement.dataset.theme'), 'dark');
    fs.writeFileSync(path.join(output, 'dark.png'), (await mainWindow.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []);
    console.log('Windows 实机检查通过：夸克/123/迅雷自动登录、加密保存和文件浏览、主进程网络通道、安全 IPC、分片暂停续传及完整性、5 个页面与深色主题。');
    await core.close();
    server.closeAllConnections(); server.close();
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error);
    server.closeAllConnections(); server.close();
    await core.close(); app.exit(1);
  }
}
module.exports = { run };
