'use strict';
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const paths = {
  link: '<path d="m10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 1)"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  cloud: '<path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11Z"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4Z"/>',
  settings: '<path d="m9 3-.5 2-2 1.2-2-.6-2 3.5 1.5 1.4v2.4l-1.5 1.4 2 3.5 2-.6 2 1.2.5 2h6l.5-2 2-1.2 2 .6 2-3.5-1.5-1.4v-2.4l1.5-1.4-2-3.5-2 .6-2-1.2L15 3Z"/><circle cx="12" cy="12" r="3"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 8 8m-2-2 2-2m-5-1 2-2"/>',
  clipboard: '<path d="M9 4H5v17h14V4h-4M9 2h6v4H9Z"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  folder: '<path d="M3 6h7l2 3h9v11H3Z"/><path d="M3 6V4h7l2 3h8v2"/>',
  file: '<path d="M6 2h8l5 5v15H6Z"/><path d="M14 2v6h5M9 13h7m-7 4h7"/>',
  shield: '<path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5Z"/><path d="m8 11 3 3 5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 13 8-13 8Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  open: '<path d="M14 3h7v7m0-7L11 13M9 3H3v18h18v-6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.file}</svg>`;
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
const titles = {
  resolve: ['分享解析', '从分享链接，到你的本地文件。'],
  downloads: ['下载管理', '每一份文件，都有条不紊。'],
  accounts: ['网盘账号', '连接你的网盘，在一个地方管理文件。'],
  bookmarks: ['我的收藏', '把值得保留的分享，放在这里。'],
  settings: ['设置', '让云析适应你的使用习惯。']
};
let model = { accounts: [], tasks: [], settings: {}, bookmarks: [] }, currentPage = 'resolve', browse = null, history = [], filter = 'all', selected = new Set(), toastTimer;
function toast(message, error = false) {
  $('toast').textContent = message;
  $('toast').classList.toggle('error', error);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3500);
}
async function invoke(operation, payload) { return window.yunx.invoke(operation, payload); }
async function action(operation, payload) {
  try { return await invoke(operation, payload); } catch (error) { toast(error.message, true); throw error; }
}
function bytes(value) {
  if (!value || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return (value / 1024 ** index).toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}
function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(section => { section.hidden = section.id !== 'page-' + page; });
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  $('page-title').textContent = titles[page][0]; $('page-description').textContent = titles[page][1];
  if (page === 'downloads') renderTasks();
  if (page === 'accounts') renderAccounts();
  if (page === 'bookmarks') renderBookmarks();
  if (page === 'settings') renderSettings();
}
function empty(title, description, symbol = 'folder') {
  return `<div class="empty-state"><div class="empty-illustration">${icon(symbol)}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>`;
}
function renderAccounts() {
  $('platform-chips').innerHTML = model.accounts.map(p => `<div class="platform-chip"><span class="mini-logo" data-platform="${p.id}">${p.letter}</span>${p.name}</div>`).join('');
  $('account-list').innerHTML = model.accounts.map(p => `<article class="account-card"><div class="account-top"><div class="account-logo" data-platform="${p.id}">${p.letter}</div><div><h3>${p.name}</h3><p>${escapeHtml(p.loggedIn ? p.nickname || '已连接账号' : p.id === 'github' ? '使用 Token 提升访问额度' : '登录后浏览和下载文件')}</p></div><span class="account-status ${p.loggedIn ? 'logged' : ''}">${p.loggedIn ? '● 已连接' : '未登录'}</span></div><div class="account-actions">${p.loggedIn ? `<button class="button primary small" data-op="cloud" data-platform="${p.id}">浏览文件</button><button class="button secondary small" data-op="logout" data-platform="${p.id}">退出登录</button>` : p.id !== 'github' ? `<button class="button primary small" data-op="login" data-platform="${p.id}">网页登录</button>` : ''}${p.id === 'xunlei' ? '<button class="button secondary small" data-op="xunleiLogin">密码 / 短信</button>' : ''}<button class="button secondary small" data-op="credential" data-platform="${p.id}">${p.id === 'github' ? '配置 Token' : '手动导入'}</button></div></article>`).join('');
}
function applyTheme() {
  const theme = model.settings.theme || 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
}
function renderSettings() {
  const s = model.settings;
  $('setting-dir').textContent = s.downloadDir || '';
  $('setting-threads').value = s.threads || 8;
  $('setting-concurrency').value = s.concurrency || 3;
  $('setting-speed').value = (s.speedLimit || 0) / 1048576;
  $('setting-theme').value = s.theme || 'system';
  $('setting-mirror').value = s.mirrorPrefix || '';
  $('setting-proxy-host').value = s.proxyHost || '';
  $('setting-proxy-port').value = s.proxyPort || '';
  $('current-download-dir').textContent = s.downloadDir || '';
}
function renderTasks() {
  const active = model.tasks.filter(task => ['queued', 'downloading'].includes(task.status));
  const completed = model.tasks.filter(task => task.status === 'completed');
  $('download-count').textContent = active.length;
  $('stat-active').textContent = active.length;
  $('stat-complete').textContent = completed.length;
  $('stat-speed').textContent = bytes(active.reduce((sum, task) => sum + (task.speed || 0), 0)) + '/s';
  const tasks = model.tasks.filter(task => filter === 'all' || (filter === 'active' ? task.status !== 'completed' : task.status === 'completed'));
  if (!tasks.length) { $('task-list').innerHTML = empty('还没有下载任务', '从分享解析中选择文件，或添加一个文件直链。', 'download'); return; }
  const states = { queued: '排队中', downloading: '正在下载', paused: '已暂停', failed: '下载失败', completed: '已完成' };
  $('task-list').innerHTML = tasks.slice().reverse().map(task => {
    const percent = task.total > 0 ? Math.min(100, task.downloaded * 100 / task.total) : 0;
    const running = ['queued', 'downloading'].includes(task.status);
    return `<article class="task-card" data-task="${task.id}"><div class="task-icon">${icon('file')}</div><div class="task-info"><div class="task-title"><strong title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</strong><span class="task-status">${states[task.status] || '已暂停'}${task.total > 0 ? ' · ' + percent.toFixed(0) + '%' : ''}</span></div><div class="progress"><div data-progress="${task.id}"></div></div><div class="task-meta"><span>${bytes(task.downloaded)} / ${task.total ? bytes(task.total) : '大小未知'}</span><span>${running && task.speed ? bytes(task.speed) + '/s' : escapeHtml(model.accounts.find(platform => platform.id === task.platform)?.name || '直接下载')}</span></div>${task.error ? `<p class="task-error">${escapeHtml(task.error)}</p>` : ''}</div><div class="task-actions">${task.status === 'completed' ? `<button data-op="openFile" data-id="${task.id}" title="打开文件">${icon('open')}</button><button data-op="showFile" data-id="${task.id}" title="在文件夹中显示">${icon('folder')}</button>` : `<button data-op="${running ? 'pause' : 'resume'}" data-id="${task.id}" title="${running ? '暂停' : '继续'}">${icon(running ? 'pause' : 'play')}</button>`}<button data-op="remove" data-id="${task.id}" title="移除任务（保留已完成文件）">${icon('trash')}</button></div></article>`;
  }).join('');
  tasks.forEach(task => { const node = document.querySelector(`[data-progress="${task.id}"]`); if (node) node.style.width = (task.total ? Math.min(100, task.downloaded * 100 / task.total) : 0) + '%'; });
}
function renderFiles() {
  if (!browse) return;
  $('file-results').hidden = false; $('resolve-empty').hidden = true;
  $('file-title').textContent = browse.title;
  $('breadcrumb').textContent = history.map(item => item.name).join('  /  ');
  $('file-back').disabled = history.length <= 1;
  $('select-all').checked = false;
  $('file-summary').textContent = `${browse.items.length} 个项目`;
  $('file-list').innerHTML = browse.items.length ? browse.items.map(item => `<tr><td class="check-cell">${item.ref ? `<input type="checkbox" data-select="${item.ref}" aria-label="选择 ${escapeHtml(item.name)}">` : ''}</td><td class="file-name" title="${escapeHtml(item.name)}"><div>${icon(item.isDir ? 'folder' : 'file')}${item.isDir ? `<button class="folder-link" data-op="folder" data-id="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>` : escapeHtml(item.name)}</div></td><td>${item.isDir ? '—' : item.size > 0 ? bytes(item.size) : '未知'}</td><td>${escapeHtml(item.modified?.slice(0, 19).replace('T', ' ') || '—')}</td><td>${!item.isDir ? `<button class="text-button" data-op="download" data-ref="${item.ref}">下载</button><button class="text-button" data-op="link" data-ref="${item.ref}" title="查看直链">直链</button>` : item.ref ? `<button class="text-button" data-op="downloadFolder" data-ref="${item.ref}">下载文件夹</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="5" class="loading-row">这个文件夹是空的</td></tr>';
  selected.clear();
}
function setBrowse(result, name) {
  browse = result;
  history = [{ sessionId: result.sessionId, directory: result.directory, name: name || result.title || '根目录' }];
  renderFiles(); showPage('resolve');
}
function renderBookmarks() {
  $('bookmark-list').innerHTML = model.bookmarks.length ? model.bookmarks.slice().reverse().map(item => `<article class="card bookmark-card"><span class="heading-icon">${icon('bookmark')}</span><div><strong>${escapeHtml(item.name)}</strong><p>${escapeHtml(item.text)}</p></div><button class="button primary small" data-op="openBookmark" data-id="${item.id}">解析</button><button class="text-button" data-op="removeBookmark" data-id="${item.id}">删除</button></article>`).join('') : empty('把喜欢的分享留在这里', '在分享解析页点击收藏按钮，之后就能快速找到。', 'bookmark');
}
function modal(title, content, buttons) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = content;
  $('modal-actions').replaceChildren();
  for (const { name, primary, handler } of buttons) {
    const button = document.createElement('button'); button.className = 'button ' + (primary ? 'primary' : 'secondary'); button.textContent = name;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await handler(); } catch (error) { toast(error.message, true); } finally { button.disabled = false; }
    });
    $('modal-actions').appendChild(button);
  }
  if (!$('modal').open) $('modal').showModal();
}
const closeModal = () => { $('modal').close(); $('modal-body').replaceChildren(); $('modal-actions').replaceChildren(); };
$('modal-close').onclick = closeModal;
$('modal').addEventListener('cancel', () => { $('modal-body').replaceChildren(); });
function credentialModal(id) {
  const p = model.accounts.find(p => p.id === id);
  const label = ['github', 'pan123'].includes(id) ? 'Token' : id === 'xunlei' ? 'access_token 或包含刷新信息的 JSON' : 'Cookie';
  modal('导入' + p.name + '登录信息', `<p class="modal-body-text">只导入你自己的登录信息。保存前会验证有效性，成功后由 Windows 加密保管。</p><label class="modal-field"><span>${label}</span><textarea id="credential-value" autocomplete="off" spellcheck="false" placeholder="粘贴登录信息"></textarea></label>${id === 'github' ? '<p class="modal-body-text">在 GitHub → Settings → Developer settings 中创建 Token，公开仓库无需授予写入权限；私有仓库只选择需要访问的仓库和读取权限。</p>' : ''}`, [
    { name: '取消', handler: closeModal }, { name: '验证并保存', primary: true, handler: async () => { model.accounts = await action('saveCredential', { platform: id, value: $('credential-value').value }); closeModal(); renderAccounts(); toast('登录信息已保存'); } }
  ]);
}
function authModal(exporting) {
  modal(exporting ? '导出认证备份' : '导入认证备份', `<p class="modal-body-text">${exporting ? '备份包含账号登录信息，请使用不易猜测的口令，并妥善保管文件。' : '选择 Windows 版导出的加密备份。导入前会显示将被替换的平台。'}</p><label class="modal-field"><span>备份口令${exporting ? '（至少 12 个字符）' : ''}</span><input type="password" id="auth-password" autocomplete="new-password"></label>${exporting ? '<label class="modal-field"><span>再次输入口令</span><input type="password" id="auth-confirm" autocomplete="new-password"></label>' : ''}`, [
    { name: '取消', handler: closeModal }, { name: exporting ? '加密并导出' : '选择备份并导入', primary: true, handler: async () => {
      const password = $('auth-password').value;
      if (exporting && password !== $('auth-confirm').value) throw new Error('两次输入的口令不一致');
      const result = await action(exporting ? 'exportAuth' : 'importAuth', { password });
      if (result.accounts) { model.accounts = result.accounts; renderAccounts(); }
      if (!result.canceled) { closeModal(); toast(exporting ? '认证备份已导出' : '认证备份已导入'); }
    } }
  ]);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.page) { showPage(button.dataset.page); return; }
  const op = button.dataset.op;
  if (!op) return;
  button.disabled = true;
  try {
    if (op === 'credential') credentialModal(button.dataset.platform);
    else if (op === 'login') { await action('login', { platform: button.dataset.platform }); toast('在官方网站完成登录后，登录信息会自动保存'); }
    else if (op === 'logout') { model.accounts = await action('logout', { platform: button.dataset.platform }); renderAccounts(); toast('已退出登录'); }
    else if (op === 'cloud') setBrowse(await action('cloud', { platform: button.dataset.platform }));
    else if (op === 'folder') {
      const item = browse.items.find(item => item.id === button.dataset.id);
      const result = await action('list', { sessionId: browse.sessionId, directory: item.id });
      history.push({ sessionId: result.sessionId, directory: result.directory, name: item.name }); browse = result; renderFiles();
    } else if (op === 'download' || op === 'downloadFolder') {
      const result = await action(op, { ref: button.dataset.ref });
      if (op === 'downloadFolder') toast(`已加入 ${result.count} 个文件`); else toast('已加入下载队列');
    } else if (op === 'link') {
      const result = await action('link', { ref: button.dataset.ref });
      modal('文件直链', '<p class="modal-body-text">直链可能有有效期，部分平台下载时还需要请求头。使用内置下载可自动携带。</p><label class="modal-field"><textarea id="direct-link" readonly spellcheck="false"></textarea></label>', [{ name: '关闭', handler: closeModal }, { name: '复制链接', primary: true, handler: async () => { await navigator.clipboard.writeText(result.url); toast('链接已复制'); } }]);
      $('direct-link').value = result.url;
    } else if (['pause', 'resume', 'remove', 'openFile', 'showFile'].includes(op)) await action(op, { id: button.dataset.id });
    else if (op === 'openBookmark') { const item = model.bookmarks.find(item => item.id === button.dataset.id); $('share-text').value = item.text; showPage('resolve'); $('resolve-button').click(); }
    else if (op === 'removeBookmark') { model.bookmarks = await action(op, { id: button.dataset.id }); renderBookmarks(); }
    else if (op === 'xunleiLogin') xunleiModal();
  } catch { } finally { button.disabled = false; }
});
$('resolve-button').onclick = async () => {
  const button = $('resolve-button'); button.disabled = true; button.textContent = '正在解析…';
  try { setBrowse(await action('resolve', { text: $('share-text').value, password: $('share-password').value })); }
  catch { } finally { button.disabled = false; button.innerHTML = '解析链接' + icon('arrow'); }
};
$('paste-link').onclick = async () => { try { $('share-text').value = await action('clipboard'); } catch { } };
$('share-text').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('resolve-button').click(); });
$('save-bookmark').onclick = async () => { try { model.bookmarks = await action('bookmark', { text: $('share-text').value, name: browse?.title || $('share-text').value.slice(0, 60) }); toast('已收藏'); } catch { } };
$('file-back').onclick = async () => {
  if (history.length <= 1) return;
  try { const previous = history[history.length - 2]; const result = await action('list', previous); history.pop(); browse = result; renderFiles(); } catch { }
};
$('file-refresh').onclick = async () => { try { browse = await action('list', { sessionId: browse.sessionId, directory: browse.directory }); renderFiles(); } catch { } };
$('file-list').addEventListener('change', event => { if (event.target.dataset.select) { if (event.target.checked) selected.add(event.target.dataset.select); else selected.delete(event.target.dataset.select); } });
$('select-all').onchange = event => { document.querySelectorAll('[data-select]').forEach(input => { input.checked = event.target.checked; if (input.checked) selected.add(input.dataset.select); else selected.delete(input.dataset.select); }); };
$('batch-download').onclick = async () => {
  if (!selected.size) { toast('请先选择文件'); return; }
  $('batch-download').disabled = true;
  let count = 0;
  try {
    for (const ref of selected) { const item = browse.items.find(item => item.ref === ref); const result = await action(item.isDir ? 'downloadFolder' : 'download', { ref }); count += item.isDir ? result.count : 1; }
    toast(`已加入 ${count} 个文件`); showPage('downloads');
  } catch { } finally { $('batch-download').disabled = false; }
};
$('download-filters').onclick = event => { const button = event.target.closest('[data-filter]'); if (button) { filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(node => node.classList.toggle('active', node === button)); renderTasks(); } };
$('pause-all').onclick = async () => { try { for (const task of model.tasks.filter(task => ['queued', 'downloading'].includes(task.status))) await action('pause', { id: task.id }); } catch { } };
$('resume-all').onclick = async () => { try { for (const task of model.tasks.filter(task => ['paused', 'failed'].includes(task.status))) await action('resume', { id: task.id }); } catch { } };
$('add-download').onclick = () => modal('添加文件下载', '<label class="modal-field"><span>文件直链</span><input id="manual-url" type="url" placeholder="https://"></label><label class="modal-field"><span>保存名称（选填）</span><input id="manual-name" placeholder="自动使用链接中的文件名"></label>', [{ name: '取消', handler: closeModal }, { name: '开始下载', primary: true, handler: async () => { await action('downloadUrl', { url: $('manual-url').value, name: $('manual-name').value }); closeModal(); toast('已加入下载队列'); } }]);
$('choose-directory').onclick = async () => { try { const directory = await action('chooseDirectory'); if (directory) { model.settings.downloadDir = directory; $('setting-dir').textContent = directory; } } catch { } };
$('save-settings').onclick = async () => {
  const mirror = $('setting-mirror').value.trim();
  if (mirror && !mirror.startsWith('https://')) { toast('下载加速前缀必须以 https:// 开头', true); return; }
  try { model.settings = await action('settings', { ...model.settings, threads: Number($('setting-threads').value), concurrency: Number($('setting-concurrency').value), speedLimit: Number($('setting-speed').value) * 1048576, theme: $('setting-theme').value, mirrorPrefix: mirror, proxyHost: $('setting-proxy-host').value, proxyPort: Number($('setting-proxy-port').value) }); renderSettings(); applyTheme(); toast('设置已保存'); } catch { }
};
$('export-auth').onclick = () => authModal(true); $('import-auth').onclick = () => authModal(false);
function xunleiModal() {
  let sms = {};
  const body = '<p class="modal-body-text">使用自己的迅雷账号登录。新设备可能需要短信验证。</p><label class="modal-field"><span>账号 / 手机号</span><input id="xl-account" autocomplete="username"></label><label class="modal-field"><span>密码（密码登录时填写）</span><input id="xl-password" type="password" autocomplete="current-password"></label><label class="modal-field"><span>短信验证码</span><input id="xl-code" inputmode="numeric" autocomplete="one-time-code"></label><p id="xl-message" class="modal-body-text"></p>';
  modal('登录迅雷网盘', body, [
    { name: '发送短信', handler: async () => { sms = await action('xunleiSms', { account: $('xl-account').value }); $('xl-message').textContent = sms.message || '短信已发送'; } },
    { name: '密码登录', handler: async () => { const result = await action('xunleiPassword', { account: $('xl-account').value, password: $('xl-password').value }); if (result.loggedIn) { closeModal(); toast('迅雷登录成功'); } else $('xl-message').textContent = result.message || '请发送短信完成验证'; } },
    { name: '验证码登录', primary: true, handler: async () => { const result = await action('xunleiCode', { account: $('xl-account').value, code: $('xl-code').value, creditKey: sms.creditKey || '', smsToken: sms.smsToken || '' }); if (result.loggedIn) { closeModal(); toast('迅雷登录成功'); } else $('xl-message').textContent = result.message || '登录失败，请重试'; } }
  ]);
}
window.yunx.onEvent((type, data) => {
  if (type === 'download') { const index = model.tasks.findIndex(task => task.id === data.id); if (index < 0) model.tasks.push(data); else model.tasks[index] = data; renderTasks(); }
  else if (type === 'removed') { model.tasks = model.tasks.filter(task => task.id !== data.id); renderTasks(); }
  else if (type === 'accounts') { model.accounts = data; renderAccounts(); }
  else if (type === 'settings') { model.settings = data; applyTheme(); renderSettings(); }
  else if (type === 'notice') toast(data.message);
  else if (type === 'offline' || type === 'error') toast(data.message, true);
});
(async () => {
  try { model = await action('state'); $('version').textContent = model.version; renderAccounts(); renderTasks(); renderSettings(); renderBookmarks(); applyTheme(); }
  catch { }
})();
