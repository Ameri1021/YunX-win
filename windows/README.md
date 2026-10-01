# 云析 Windows 桌面版

支持 Windows 10/11 x64。保留夸克、UC、迅雷、139、123 云盘和 GitHub，移除百度网盘。

## 使用

安装包与便携 ZIP 下载：[Windows Releases](https://github.com/Ameri1021/YunX-win/releases)。本 Windows 衍生版本源码：[Ameri1021/YunX-win](https://github.com/Ameri1021/YunX-win)。

1. 安装 `YunX-Windows-1.0.2-x64.exe`，或解压便携包后打开 `YunX.exe`。
2. 在「网盘账号」完成官方网站登录。登录完成后应用自动校验并保存；也可以手动导入自己的 Cookie / Token。
3. 迅雷另外支持账号密码与短信验证码登录。平台要求设备验证时，需要在官方页面完成验证。
4. 在「分享解析」粘贴完整文案，支持提取码、目录浏览、单文件与文件夹批量下载。
5. GitHub 支持仓库、账号、Releases、文件直链和源码 ZIP；私有仓库需要有读取权限的 Token。
6. 在「下载管理」暂停、继续、打开文件或定位保存位置。关闭窗口时，有任务会留在托盘继续下载；托盘选择退出会暂停任务。重新打开后，中断任务显示为已暂停。

默认保存到用户下载目录的 `YunX` 文件夹，可以在设置中修改。设置支持线程数、任务并发、全局限速、主题、HTTP 代理和 GitHub 下载加速前缀。

代理留空时使用 Windows 系统网络设置；本机回环地址始终直接连接。网页登录、网盘接口与下载连接共用主进程的 Chromium 网络通道，避免 Java 与浏览器经过同一个系统代理时握手行为不同。服务与父进程只通过标准输入输出通信，不监听 HTTP 端口；下载数据按消费确认分块传递，不把整份文件缓存到内存。

## 本地数据

账号、任务请求头、收藏与设置保存在 `%APPDATA%/YunX/vault.json`，使用 Electron safeStorage 调用 Windows DPAPI 加密，只能由原 Windows 用户解密。解密失败时保留原文件，不清空账号。

浏览器登录分平台隔离，退出一个平台只清除该平台的登录会话。认证备份另用 PBKDF2-SHA256（210,000 次）和 AES-256-GCM 加密，并认证文件头；仅支持本 Windows 版的加密备份格式。

网页登录校验暂时失败时会自动重试；夸克等待完整业务会话，123 兼容官网的原始、JSON 和 Bearer Token。两者通过登录窗口的网络会话校验官方账号接口，校验成功后加密保存并自动关闭登录窗口。便携版解压位置改变不影响当前 Windows 用户的账号记录。

迅雷支持官网的 `credentials_…` 登录记录，并在主进程读取官方文件接口实际使用的设备和验证码字段。官方页面没有应用 preload。文件列表请求失败会显示错误，成功的空目录才显示为空。

断点文件保存在目标目录下的 `.yunx-parts/任务ID`，完成后清理。Windows 版使用固定区间的分片计划，同时比较 URL、总长度、ETag 与 Last-Modified；计划变化时会重新下载。合并期间保留分片以便保存失败后恢复，因此需要额外约一份文件的空间。

## 开发

需要 Node.js 22 或更高版本和 JDK 21；设置 `JAVA_HOME` 指向 JDK。无需 Android SDK。

```powershell
cd windows
npm ci
npm run dev
```

目录分工：

- `ui/`：桌面界面与中文文案。
- `electron/`：主进程、官方登录窗口、Windows 加密存储与白名单 IPC。
- `core/`：Kotlin / OkHttp 平台解析接口与下载服务，使用标准输入输出通信，不监听网络端口。
- `scripts/`：运行时生成与隐藏窗口实机检查。
- `tests/` 和 `core/src/test/`：来源限制、凭证保护、认证备份与断点下载测试。
- `resources/`：图标和生成的本地服务运行时；生成物不提交。
- `dist/`：安装包与便携包输出。

平台接口从原工程迁移，协议要求的 App 参数与 User-Agent 保持原格式；代码本身不再依赖 Android 类库。原 Android 的安装包自检模块仍完整保存在 `../android/`。

## 验证与打包

```powershell
npm test
npm run build:core
npm run test:smoke
npm run dist
npm run dist:portable
```

`build:core` 会运行 Kotlin 测试并生成精简 Java 运行时。`test:smoke` 使用临时数据目录、模拟官网及本机文件服务，验证夸克/123/迅雷自动登录失败重试、加密记录重新读取、文件和子目录浏览、Windows 加密、真实 IPC、主进程网络通道的下载暂停续传与完整性及页面布局，截图保存在 `artifacts/`。它不会登录个人账号。

安装包默认为当前用户安装，不要求管理员权限。当前构建没有 Windows 代码签名，首次打开可能出现系统发布者提示。分发时请使用自己的代码签名证书；应用不自动下载执行更新。

## 验证范围

本地服务和桌面端有自动测试，真实网盘登录、短信和取链仍需要自己的账号进行验证；没有账号时不会声称这些线上流程已经通过。大型 GitHub 目录最多由官方 contents 接口返回 1,000 个条目；特殊分支名带斜杠时建议从仓库根目录浏览。

## 来源、署名与协议

原 Android 项目作者为 **CYQawa**，原项目地址：[CYQawa/YunX](https://github.com/CYQawa/YunX)。本 Windows 版为非官方衍生版本，保留原项目的版权声明和贡献者署名，继续遵循 [AGPL-3.0](LICENSE)。

由 **Ameri1021** 提出需求、整理并存档，借助 **OpenAI GPT-6.1-sol** 完成 Windows 移植、修复和验证。2026-10-01 归档的 1.0.2 版本主要包含官方网页登录、Windows 加密存储、主进程网络通道与固定分片下载的修复。平台接口迁移自原项目，原作者及其他贡献者的版权仍归各自权利人所有。

源代码存档不包含个人账号数据、认证备份、签名私钥、开发依赖、运行时和构建结果。若另行分发 EXE，应按 AGPL-3.0 提供与该成品对应的完整源码及必要构建脚本，并保留第三方组件的许可证。

安装包与便携包随附 `LICENSE.txt`、本文档、`THIRD-PARTY-NOTICES.md` 和 `THIRD-PARTY-LICENSES/`；Electron、Chromium 与 Java 运行时另保留其自带许可证。第三方组件及其源码地址详见 [第三方组件说明](THIRD-PARTY-NOTICES.md)。
