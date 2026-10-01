const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const pbkdf2 = promisify(crypto.pbkdf2);
const MAGIC = Buffer.from('YUNX_WINDOWS_AUTH_V1\n');

class SecureStore {
  constructor(directory, safeStorage) {
    this.directory = directory;
    this.file = path.join(directory, 'vault.json');
    this.safeStorage = safeStorage;
    fs.mkdirSync(directory, { recursive: true });
    this.state = { credentials: {}, tasks: [], bookmarks: [], settings: {} };
    if (fs.existsSync(this.file)) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭证保护暂不可用，原数据已保留，请稍后重试。');
      try {
        const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (value.version !== 1 || typeof value.encrypted !== 'string') throw new Error('format');
        this.state = JSON.parse(safeStorage.decryptString(Buffer.from(value.encrypted, 'base64')));
      } catch {
        throw new Error('无法解密应用数据，原文件已保留。请确认使用原 Windows 用户账户，或从认证备份恢复。');
      }
    }
  }
  save() {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭证保护不可用，未将敏感数据写入磁盘。');
    const value = { version: 1, encrypted: this.safeStorage.encryptString(JSON.stringify(this.state)).toString('base64') };
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

async function encryptBackup(records, password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('备份口令至少需要 12 个字符');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const key = await pbkdf2(password, salt, 210000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const data = Buffer.from(JSON.stringify({ version: 1, credentials: records }));
  return Buffer.concat([header, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}
async function decryptBackup(buffer, password) {
  if (buffer.length > 2 * 1024 * 1024 || buffer.length < MAGIC.length + 44 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是受支持的 Windows 加密认证备份文件');
  }
  const headerLength = MAGIC.length + 28;
  const salt = buffer.subarray(MAGIC.length, MAGIC.length + 16), iv = buffer.subarray(MAGIC.length + 16, headerLength);
  const key = await pbkdf2(password, salt, 210000, 32, 'sha256');
  try {
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(buffer.subarray(0, headerLength));
    cipher.setAuthTag(buffer.subarray(-16));
    const value = JSON.parse(Buffer.concat([cipher.update(buffer.subarray(headerLength, -16)), cipher.final()]).toString('utf8'));
    if (value.version !== 1 || !value.credentials || typeof value.credentials !== 'object' || Array.isArray(value.credentials)) throw new Error('format');
    return value.credentials;
  } catch { throw new Error('备份口令不正确或文件已损坏'); }
}
module.exports = { SecureStore, encryptBackup, decryptBackup };
