const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, safeStorage, nativeTheme, Tray, Menu, nativeImage, Notification, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { CoreBridge } = require('./core-bridge.cjs');
const { SecureStore, encryptBackup, decryptBackup } = require('./store.cjs');
const { PLATFORMS, platformOf, trustedLogin, httpUrl, publicTask, cleanSettings, readableError } = require('./policies.cjs');
const { readWebCredential, observeXunleiRequest, validateWebCredential, createLoginMonitor } = require('./web-login.cjs');
const { proxyConfiguration } = require('./network-bridge.cjs');

const smoke = process.argv.includes('--smoke-test');
if (smoke) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-smoke-')));
app.setName('YunX');
if (!smoke) app.setPath('userData', path.join(app.getPath('appData'), 'YunX'));
let mainWindow, core, store, tray, networkSession, quitting = false, saveTimer;
const loginWindows = new Map();
const uiFile = path.join(__dirname, '..', 'ui', 'index.html');
const uiUrl = pathToFileURL(uiFile).href;
const resourceDirectory = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources');
function publish(type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('yunx:event', type, data);
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { store.save(); } catch (error) { publish('error', { message: readableError(error) }); } }, 700);
}
function accounts() {
  return PLATFORMS.map(platform => ({ ...platform, hosts: undefined, login: undefined,
    loggedIn: Boolean(store.state.credentials[platform.id]), nickname: store.state.credentials[platform.id]?.nickname || '' }));
}
function state() {
  return { version: app.getVersion(), accounts: accounts(), tasks: store.state.tasks.map(publicTask), settings: store.state.settings, bookmarks: store.state.bookmarks };
}
async function syncCredentials() { await core.request('credentials.set', store.state.credentials); publish('accounts', accounts()); }
async function saveCredential(platform, record) {
  platformOf(platform);
  const validated = await core.request('credentials.validate', { platform, record });
  return persistCredential(platform, validated);
}
async function persistCredential(platform, validated) {
  const previous = store.state.credentials[platform];
  store.state.credentials[platform] = validated;
  try { store.save(); } catch (error) {
    if (previous) store.state.credentials[platform] = previous;
    else delete store.state.credentials[platform];
    throw error;
  }
  await syncCredentials();
  return accounts();
}

async function startCore() {
  networkSession = session.fromPartition('yunx-network');
  await networkSession.setProxy(proxyConfiguration(store.state.settings));
  core = new CoreBridge(path.join(resourceDirectory, 'core'), path.join(app.getPath('userData'), 'core'), networkSession);
  core.on('download', task => {
    const index = store.state.tasks.findIndex(item => item.id === task.id);
    const previous = index < 0 ? null : store.state.tasks[index];
    if (index < 0) store.state.tasks.push(task); else store.state.tasks[index] = task;
    publish('download', publicTask(task));
    saveSoon();
    if (!smoke && task.status === 'completed' && previous?.status !== 'completed' && Notification.isSupported()) {
      new Notification({ title: '下载完成', body: task.name }).show();
    }
  });
  core.on('downloadRemoved', ({ id }) => {
    store.state.tasks = store.state.tasks.filter(task => task.id !== id);
    store.save(); publish('removed', { id });
  });
  core.on('credential', ({ platform, record }) => {
    if (!store.state.credentials[platform]) return;
    store.state.credentials[platform] = record;
    saveSoon(); publish('accounts', accounts());
  });
  core.on('offline', data => {
    store.state.tasks.forEach(task => { if (['queued', 'downloading'].includes(task.status)) { task.status = 'paused'; task.speed = 0; } });
    saveSoon(); publish('offline', data);
  });
  await core.ready;
  await syncCredentials();
  await core.request('configure', store.state.settings);
  store.state.tasks = await core.request('download.restore', { tasks: store.state.tasks });
  store.save();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 820, minWidth: 940, minHeight: 680, show: false,
    title: '云析 YunX', backgroundColor: '#f5f6fa', autoHideMenuBar: true,
    icon: path.join(resourceDirectory, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: !smoke }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  mainWindow.loadFile(uiFile);
  mainWindow.once('ready-to-show', () => { if (!smoke) mainWindow.show(); });
  mainWindow.on('close', event => {
    if (!quitting && store.state.tasks.some(task => ['queued', 'downloading'].includes(task.status)) && tray) {
      event.preventDefault(); mainWindow.hide();
      tray.setToolTip('云析 · 正在后台下载');
    }
  });
  const image = nativeImage.createFromPath(path.join(resourceDirectory, 'icon.png'));
  if (!smoke && !image.isEmpty()) {
    tray = new Tray(image.resize({ width: 20, height: 20 }));
    tray.setToolTip('云析 YunX');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开云析', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' }, { label: '退出（暂停下载）', click: () => app.quit() }
    ]));
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  }
}

async function login(platformId) {
  const platform = platformOf(platformId);
  if (!platform.login) throw new Error('请在账号页粘贴 GitHub Token');
  if (loginWindows.has(platformId)) { loginWindows.get(platformId).focus(); return { opened: true }; }
  const partition = 'persist:yunx-login-' + platformId;
  const loginSession = session.fromPartition(partition);
  await loginSession.setProxy(proxyConfiguration(store.state.settings));
  loginSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  loginSession.on('will-download', event => event.preventDefault());
  const window = new BrowserWindow({ width: 1040, height: 780, parent: mainWindow, show: !smoke, title: platform.name + ' · 完成登录后自动保存', autoHideMenuBar: true,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  loginWindows.set(platformId, window);
  let observed = {};
  if (platformId === 'xunlei') loginSession.webRequest.onBeforeSendHeaders({ urls: ['https://api-pan.xunlei.com/drive/v1/*'] }, (details, callback) => {
    if (!window.isDestroyed() && details.webContentsId === window.webContents.id) {
      const record = observeXunleiRequest(details);
      if (record) observed = { ...observed, ...record };
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (trustedLogin(url, platform)) window.loadURL(url);
    return { action: 'deny' };
  });
  for (const name of ['will-navigate', 'will-redirect']) {
    window.webContents.on(name, (event, url) => { if (!trustedLogin(url, platform)) event.preventDefault(); });
  }
  const monitor = createLoginMonitor({
    isActive: () => !window.isDestroyed() && trustedLogin(window.webContents.getURL(), platform),
    readCandidate: () => readWebCredential(platform, loginSession, window.webContents, observed),
    validate: record => ['quark', 'pan123'].includes(platformId) ? validateWebCredential(platformId, record, loginSession) :
      core.request('credentials.validate', { platform: platformId, record }),
    save: record => persistCredential(platformId, record),
    onSuccess: () => {
      publish('notice', { message: platform.name + '登录成功' });
      window.close();
    },
    onStatus: status => window.setTitle(platform.name + (status === 'checking' ? ' · 已检测到登录信息，正在校验并保存' :
      ' · 校验暂未通过，将自动重试；也可使用手动导入'))
  });
  const timer = setInterval(() => monitor.check(), 2000);
  window.webContents.on('did-finish-load', () => monitor.check());
  window.on('closed', () => {
    monitor.stop(); clearInterval(timer); loginWindows.delete(platformId);
    if (platformId === 'xunlei') loginSession.webRequest.onBeforeSendHeaders(null);
    observed = {};
  });
  await window.loadURL(platform.login);
  return { opened: true };
}

async function downloadSpec(spec) {
  httpUrl(spec.url);
  if (spec.platform === 'github' && store.state.settings.mirrorPrefix && !spec.headers?.Authorization) {
    spec = { ...spec, fallbackUrl: spec.url, url: store.state.settings.mirrorPrefix + spec.url };
    httpUrl(spec.url);
  }
  let directory = store.state.settings.downloadDir;
  if (spec.relativeParent) {
    const root = path.resolve(directory);
    const segments = spec.relativeParent.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\:]/.test(segment))) throw new Error('下载目录不安全');
    directory = path.resolve(root, ...segments);
    if (!directory.startsWith(root + path.sep)) throw new Error('下载目录超出保存位置');
  }
  const task = await core.request('download.enqueue', { spec, directory });
  const index = store.state.tasks.findIndex(item => item.id === task.id);
  if (index < 0) store.state.tasks.push(task);
  store.save();
  return publicTask(task);
}

const operations = {
  state,
  resolve: p => core.request('share.resolve', { text: String(p.text || '').slice(0, 100000), password: String(p.password || '') }),
  list: p => core.request('share.list', { sessionId: p.sessionId, directory: p.directory }),
  cloud: p => core.request('cloud.list', { platform: platformOf(p.platform).id }),
  link: async p => {
    const spec = await core.request('download.link', { ref: p.ref });
    return { url: spec.url, name: spec.fileName };
  },
  download: async p => downloadSpec(await core.request('download.link', { ref: p.ref })),
  downloadFolder: async p => {
    const specs = await core.request('download.folder', { ref: p.ref }, 600000);
    for (const spec of specs) await downloadSpec(spec);
    return { count: specs.length };
  },
  downloadUrl: p => downloadSpec({ url: httpUrl(p.url), fileName: String(p.name || new URL(p.url).pathname.split('/').pop() || 'download'), platform: 'generic', headers: {} }),
  pause: p => core.request('download.pause', { id: p.id }),
  resume: p => core.request('download.resume', { id: p.id }),
  remove: p => core.request('download.remove', { id: p.id }),
  openFile: async p => {
    const task = store.state.tasks.find(item => item.id === p.id);
    if (!task || task.status !== 'completed') throw new Error('文件尚未下载完成');
    const result = await shell.openPath(task.path);
    if (result) throw new Error(result);
    return { ok: true };
  },
  showFile: p => { const task = store.state.tasks.find(item => item.id === p.id); if (task) shell.showItemInFolder(task.path); return { ok: true }; },
  login: p => login(p.platform),
  saveCredential: p => {
    const platform = platformOf(p.platform).id;
    let record;
    if (platform === 'xunlei') {
      try { record = JSON.parse(p.value); } catch { record = { accessToken: String(p.value || '').trim() }; }
      if (record.access_token) record.accessToken = record.access_token;
      if (record.refresh_token) record.refreshToken = record.refresh_token;
      if (record.device_id) record.deviceId = record.device_id;
      if (record.captcha_token) record.captchaToken = record.captcha_token;
    } else record = ['github', 'pan123'].includes(platform) ? { token: String(p.value || '').trim() } : { cookie: String(p.value || '').trim() };
    return saveCredential(platform, record);
  },
  xunleiSms: p => core.request('xunlei.sms', p),
  xunleiPassword: async p => {
    const result = await core.request('xunlei.password', p);
    if (result.loggedIn) { store.state.credentials.xunlei = result.record; store.save(); await syncCredentials(); }
    return { loggedIn: result.loggedIn, message: result.message };
  },
  xunleiCode: async p => {
    const result = await core.request('xunlei.code', p);
    if (result.loggedIn) { store.state.credentials.xunlei = result.record; store.save(); await syncCredentials(); }
    return { loggedIn: result.loggedIn, message: result.message };
  },
  logout: async p => {
    const platform = platformOf(p.platform).id;
    loginWindows.get(platform)?.close();
    await session.fromPartition('persist:yunx-login-' + platform).clearStorageData();
    delete store.state.credentials[platform];
    store.save(); await syncCredentials(); return accounts();
  },
  chooseDirectory: async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择下载目录', defaultPath: store.state.settings.downloadDir, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  },
  settings: async p => {
    store.state.settings = cleanSettings(p, store.state.settings.downloadDir);
    await networkSession.setProxy(proxyConfiguration(store.state.settings));
    for (const window of loginWindows.values()) await window.webContents.session.setProxy(proxyConfiguration(store.state.settings));
    store.save(); await core.request('configure', store.state.settings);
    nativeTheme.themeSource = store.state.settings.theme;
    publish('settings', store.state.settings); return store.state.settings;
  },
  clipboard: () => clipboard.readText().slice(0, 100000),
  bookmark: p => {
    const text = String(p.text || '').slice(0, 100000);
    if (!text.trim()) throw new Error('请先输入分享链接');
    const item = { id: crypto.randomUUID(), text, name: String(p.name || '分享收藏').slice(0, 200), date: new Date().toISOString() };
    store.state.bookmarks.push(item); store.save(); return store.state.bookmarks;
  },
  removeBookmark: p => { store.state.bookmarks = store.state.bookmarks.filter(item => item.id !== p.id); store.save(); return store.state.bookmarks; },
  exportAuth: async p => {
    const encrypted = await encryptBackup(store.state.credentials, p.password);
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出加密认证备份', defaultPath: '云析认证备份.yunxauth', filters: [{ name: '云析认证备份', extensions: ['yunxauth'] }] });
    if (!result.canceled) fs.writeFileSync(result.filePath, encrypted);
    return { canceled: result.canceled };
  },
  importAuth: async p => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择认证备份', properties: ['openFile'], filters: [{ name: '云析认证备份', extensions: ['yunxauth'] }] });
    if (result.canceled) return { canceled: true };
    if (fs.statSync(result.filePaths[0]).size > 2 * 1024 * 1024) throw new Error('备份文件过大');
    const records = await decryptBackup(fs.readFileSync(result.filePaths[0]), p.password);
    const imported = Object.keys(records).filter(id => PLATFORMS.some(platform => platform.id === id));
    if (!imported.length) throw new Error('备份中没有受支持的账号');
    const answer = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['取消', '确认导入'], defaultId: 0, cancelId: 0,
      message: '导入将替换这些平台的登录信息', detail: imported.map(id => platformOf(id).name).join('、') });
    if (answer.response !== 1) return { canceled: true };
    imported.forEach(id => { store.state.credentials[id] = records[id]; });
    store.save(); await syncCredentials(); return { canceled: false, accounts: accounts() };
  }
};
ipcMain.handle('yunx:invoke', async (event, operation, payload) => {
  try {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame.url !== uiUrl) throw new Error('拒绝来自非应用页面的操作');
    if (!Object.hasOwn(operations, operation)) throw new Error('不支持的操作');
    return { result: await operations[operation](payload || {}) };
  } catch (error) { return { error: readableError(error) }; }
});

if (!smoke && !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    try {
      store = new SecureStore(app.getPath('userData'), safeStorage);
      store.state.settings = cleanSettings(store.state.settings || {}, path.join(app.getPath('downloads'), 'YunX'));
      store.state.credentials ||= {}; store.state.tasks ||= []; store.state.bookmarks ||= [];
      nativeTheme.themeSource = store.state.settings.theme;
      await startCore(); createWindow();
      if (smoke) await require('../scripts/smoke.cjs').run({ app, core, store, mainWindow, operations, safeStorage, loginWindows, networkSession });
    } catch (error) {
      if (smoke) { console.error(readableError(error)); app.exit(1); }
      else { dialog.showErrorBox('云析启动失败', readableError(error)); app.exit(1); }
    }
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !core) return;
  event.preventDefault(); quitting = true;
  clearTimeout(saveTimer);
  for (const window of loginWindows.values()) window.close();
  core.close().finally(() => {
    try { store.save(); } catch { }
    tray?.destroy(); app.quit();
  });
});
