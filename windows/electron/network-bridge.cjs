const { httpUrl } = require('./policies.cjs');

const CHUNK_SIZE = 65536;

/** 主进程使用 Chromium 网络，经父子进程的标准输入输出传送有界数据流。 */
class NetworkBridge {
  constructor(fetch, send) { this.fetch = fetch; this.send = send; this.active = new Map(); }
  acknowledge(id) { this.active.get(id)?.ack?.(); }
  cancel(id) {
    const entry = this.active.get(id);
    if (entry) { entry.controller.abort(); entry.ack?.(); }
  }
  close() { for (const id of this.active.keys()) this.cancel(id); }
  async request(data) {
    const entry = { controller: new AbortController(), ack: null };
    this.active.set(data.id, entry);
    let response;
    try {
      let url = httpUrl(data.url), method = data.method;
      let headers = new Headers(data.headers);
      // 长度校验使用未压缩的字节；不自动带入浏览器里其他会话的 Cookie。
      headers.set('Accept-Encoding', 'identity');
      let body = data.body ? Buffer.from(data.body, 'base64') : undefined;
      for (let redirects = 0; ; redirects++) {
        response = await this.fetch(url, { method, headers, body, credentials: 'omit', redirect: 'manual', signal: entry.controller.signal });
        if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) break;
        if (redirects >= 10) throw new Error('重定向次数过多');
        const next = httpUrl(new URL(response.headers.get('location'), url).href);
        if (new URL(next).origin !== new URL(url).origin) {
          headers.delete('Cookie'); headers.delete('Authorization');
        }
        if (response.status === 303 && method !== 'HEAD' || [301, 302].includes(response.status) && method === 'POST') {
          method = 'GET'; body = undefined; headers.delete('Content-Type'); headers.delete('Content-Length');
        }
        await response.body?.cancel(); url = next;
      }
      if (entry.controller.signal.aborted) return;
      const responseHeaders = [...response.headers].filter(([name]) => name.toLowerCase() !== 'set-cookie');
      for (const value of response.headers.getSetCookie?.() || []) responseHeaders.push(['set-cookie', value]);
      // Chromium 已解压时，不把压缩长度误用于下载的实际字节校验。
      const encoded = response.headers.get('content-encoding');
      const wireHeaders = encoded && encoded !== 'identity' ? responseHeaders.filter(([name]) => !['content-encoding', 'content-length'].includes(name.toLowerCase())) : responseHeaders;
      this.send('network.response', { id: data.id, status: response.status, url: response.url || url, headers: wireHeaders });
      if (response.body && method !== 'HEAD') {
        const reader = response.body.getReader();
        try {
          while (!entry.controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
              if (entry.controller.signal.aborted) break;
              // 收到服务的消费确认后才传下一块，避免大文件堆积在内存或标准输入中。
              await new Promise(resolve => {
                entry.ack = resolve;
                this.send('network.chunk', { id: data.id, body: Buffer.from(value.subarray(offset, offset + CHUNK_SIZE)).toString('base64') });
              });
              entry.ack = null;
            }
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      if (!entry.controller.signal.aborted) this.send('network.end', { id: data.id });
    } catch {
      // 只传固定错误，不把请求地址、凭证或服务端正文写入日志/界面。
      if (!entry.controller.signal.aborted) this.send('network.error', { id: data.id });
    } finally { this.active.delete(data.id); }
  }
}

function proxyConfiguration(settings) {
  if (!settings.proxyHost || !settings.proxyPort) return { mode: 'system' };
  const host = settings.proxyHost.trim();
  if (!/^[a-z\d.:[\]-]+$/i.test(host) || settings.proxyPort < 1 || settings.proxyPort > 65535) throw new Error('HTTP 代理地址或端口无效');
  const authority = (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host) + ':' + settings.proxyPort;
  return { mode: 'fixed_servers', proxyRules: `http=${authority};https=${authority}`, proxyBypassRules: 'localhost;*.localhost;127.*;[::1]' };
}

module.exports = { NetworkBridge, proxyConfiguration };
