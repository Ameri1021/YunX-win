const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let javaHome = process.env.JAVA_HOME;
// 开发机常见安装位置；发布包自带运行时，不依赖这项检测。
if (!javaHome && process.platform === 'win32') {
  for (const dir of ['C:/Program Files/Microsoft', 'C:/Program Files/Eclipse Adoptium', 'C:/Program Files/Java']) {
    if (!fs.existsSync(dir)) continue;
    const match = fs.readdirSync(dir).find(name => /(?:jdk-?21|jdk-21|jdk21)/i.test(name));
    if (match) { javaHome = path.join(dir, match); break; }
  }
}
if (!javaHome || !fs.existsSync(path.join(javaHome, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink'))) {
  throw new Error('构建 Windows 版需要 JDK 21，请设置 JAVA_HOME。');
}
const env = { ...process.env, JAVA_HOME: javaHome, PATH: path.join(javaHome, 'bin') + path.delimiter + process.env.PATH };
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.bat') });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['test', 'installDist', '--no-daemon'], path.join(root, 'core'));
if (process.argv.includes('--test')) process.exit(0);
const resources = path.join(root, 'resources', 'core');
fs.mkdirSync(resources, { recursive: true });
fs.cpSync(path.join(root, 'core', 'build', 'install', 'yunx-core', 'lib'), path.join(resources, 'lib'), { recursive: true });
const runtime = path.join(resources, 'runtime');
if (!fs.existsSync(runtime)) {
  run(path.join(javaHome, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink'), [
    '--add-modules', 'java.base,java.logging,java.management,java.naming,java.net.http,java.sql,jdk.crypto.ec,jdk.unsupported',
    '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=2', '--output', runtime
  ]);
}
console.log('Windows 本地服务和 Java 运行时已准备好。');
