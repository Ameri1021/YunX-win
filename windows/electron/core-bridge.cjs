const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { NetworkBridge } = require('./network-bridge.cjs');

class CoreBridge extends EventEmitter {
  constructor(resources, stateDirectory, networkSession) {
    super();
    const java = path.join(resources, 'runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (!fs.existsSync(java)) throw new Error('本地服务未构建，请先运行 npm run build:core。');
    this.pending = new Map();
    this.sequence = 0;
    this.child = spawn(java, ['-Dfile.encoding=UTF-8', '-Djava.net.useSystemProxies=true', '-cp', path.join(resources, 'lib', '*'), 'com.yunx.desktop.CoreMainKt', stateDirectory], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    this.network = new NetworkBridge((url, options) => networkSession.fetch(url, options), (method, params) => {
      if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
    });
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event) {
        if (message.event === 'networkRequest') { void this.network.request(message.data); return; }
        if (message.event === 'networkAck') { this.network.acknowledge(message.data.id); return; }
        if (message.event === 'networkCancel') { this.network.cancel(message.data.id); return; }
        if (message.event === 'ready') this.readyResolve(message.data);
        this.emit(message.event, message.data);
      } else {
        const item = this.pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timeout);
        this.pending.delete(message.id);
        if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result);
      }
    });
    // 协议异常与网络日志不含用户凭证；产品日志只记录退出状态。
    this.child.stderr.on('data', () => {});
    const fail = error => {
      this.network.close();
      this.readyReject(error);
      for (const item of this.pending.values()) { clearTimeout(item.timeout); item.reject(error); }
      this.pending.clear();
      this.emit('offline', { message: '本地服务已停止，请重启应用。' });
    };
    this.child.on('error', error => fail(new Error('本地服务启动失败：' + error.code)));
    this.child.on('exit', code => fail(new Error('本地服务已停止（' + code + '）')));
  }
  async request(method, params = {}, timeoutMs = 120000) {
    await this.ready;
    if (!this.child.stdin.writable || this.child.exitCode !== null) throw new Error('本地服务未运行，请重启应用');
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('操作超时，请稍后重试')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async close() {
    if (this.child.exitCode !== null) return;
    try { await this.request('shutdown', {}, 10000); } catch { }
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 2000);
    await new Promise(resolve => { if (this.child.exitCode !== null) resolve(); else this.child.once('exit', resolve); });
    clearTimeout(timer);
  }
}
module.exports = { CoreBridge };
