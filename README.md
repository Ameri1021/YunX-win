# 云析 · YunX Windows

Windows 10/11 x64 桌面版，支持夸克、UC、迅雷、139、123 云盘和 GitHub。

## 下载

安装包和便携 ZIP 见 [Windows Releases](https://github.com/Ameri1021/YunX-win/releases)。安装版运行 EXE 按提示安装；便携版解压 ZIP 后打开 `YunX.exe`。成品自带运行时，无需另装 Java 或 Node.js。

## 来源与署名

原 Android 项目作者为 **CYQawa**，原项目地址：[CYQawa/YunX](https://github.com/CYQawa/YunX)。原代码版权声明、贡献者署名和许可证均予以保留。本版本以原项目提交 [`91af14e`](https://github.com/CYQawa/YunX/commit/91af14e) 为参考基础。

本仓库为非官方 Windows 衍生版本，由 **Ameri1021** 提出需求、整理并存档，借助 **OpenAI GPT-6.1-sol** 进行 Windows 移植、修复和验证。平台接口实现迁移自原项目；原作者及其他贡献者的版权仍归各自权利人所有。

2026-10-01 存档的 **Windows 1.0.2** 版本主要包含官方网页登录、Windows 加密凭证存储、主进程网络通道、固定分片下载及暂停续传的修复。

## 内容与使用

- `windows/`：Windows 应用源码、资源、构建脚本和测试。
- `.github/workflows/windows-ci.yml`：Windows 验证与打包流程。
- `LICENSE`：原 AGPL-3.0 许可证全文。

Git 仓库归档 Windows 源码、许可证及来源说明。原 Android 参考工程、原 Git 历史、个人账号数据、认证备份、签名私钥、开发依赖、运行时及构建结果不提交到 Git；安装包和便携包通过 Releases 单独分发。原工程在本地完整保留。

运行、开发和打包方法见 [Windows 使用说明](windows/README.md)。归档前的检查结果见 [隐私检查记录](windows/ARCHIVE-CHECK.md)。

## 协议

本 Windows 衍生版本继续遵循 [GNU AGPL-3.0](LICENSE)。向他人分发成品时，应按协议提供与成品对应的完整源码及必要构建脚本；第三方组件保留各自的许可证。

平台接口会随官方服务调整，实际登录和下载能力以账号与平台响应为准。真实网盘账号的线上行为不属于本次存档验证范围。
