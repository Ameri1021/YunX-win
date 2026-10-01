const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SecureStore, encryptBackup, decryptBackup } = require('../electron/store.cjs');
test('备份认证加密、错误口令与篡改拒绝', async () => {
  const records = { quark: { cookie: 'private-cookie' } };
  const encrypted = await encryptBackup(records, 'a-strong-password-for-test');
  assert.equal(encrypted.includes(Buffer.from('private-cookie')), false);
  assert.deepEqual(await decryptBackup(encrypted, 'a-strong-password-for-test'), records);
  await assert.rejects(decryptBackup(encrypted, 'wrong-password'));
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 20] ^= 1;
  await assert.rejects(decryptBackup(tampered, 'a-strong-password-for-test'));
  await assert.rejects(decryptBackup(Buffer.from(JSON.stringify(records)), 'a-strong-password-for-test'));
  await assert.rejects(encryptBackup(records, '12345678'));
});
test('解密失败保留原数据，不静默清空或覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-store-test-'));
  const file = path.join(dir, 'vault.json');
  const original = JSON.stringify({ version: 1, encrypted: 'corrupt' }); fs.writeFileSync(file, original);
  const unavailable = { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('temporarily unavailable'); } };
  assert.throws(() => new SecureStore(dir, unavailable)); assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.rmSync(dir, { recursive: true });
});
