# 第三方组件与许可证

云析 Windows 是 YunX 的非官方 Windows 衍生版本。原作者：**CYQawa**，原项目：https://github.com/CYQawa/YunX。Windows 版本由 **Ameri1021** 提出需求、整理并发布，借助 **OpenAI GPT-6.1-sol** 完成移植、修复和验证。

云析自身的源码与许可证：https://github.com/Ameri1021/YunX-win。Release 的版本标签提供与发布成品对应的源码和构建脚本。云析遵循 AGPL-3.0，全文随包提供于 `LICENSE.txt`；各第三方组件保留其原有许可证与版权。

## 桌面与 Java 运行时

| 组件 | 许可证与随包位置 | 源码 |
| --- | --- | --- |
| Electron 44.5.1，Electron 贡献者 | MIT，`LICENSE.electron.txt` | https://github.com/electron/electron/tree/v44.5.1 |
| Chromium 及其第三方组件，各自贡献者 | 各组件许可证，`LICENSES.chromium.html` | https://www.chromium.org/chromium-projects/ |
| Microsoft Build of OpenJDK 21；本次本地发布使用 21.0.6+7-LTS（Microsoft-10800203） | GPL-2.0 with Classpath Exception 及各模块附带条款，`resources/core/runtime/legal/` | https://github.com/microsoft/openjdk-jdk21u |

Java 运行时由 JDK 21 的 `jlink` 生成；完整许可证和各模块附加条款均保留在上述 `legal/` 目录中。微软提供的源代码入口与构建说明：https://github.com/microsoft/openjdk#source-code。其他构建环境生成的运行时版本以包内 `resources/core/runtime/release` 为准。

## Java / Kotlin 依赖

以下许可证文本随包提供于 `THIRD-PARTY-LICENSES/`。版权归各项目原权利人及贡献者所有。

| 组件 | 原权利人 / 贡献者 | 许可证文件 | 对应源码 |
| --- | --- | --- | --- |
| JetBrains Annotations 23.0.0 | JetBrains 及贡献者 | `JETBRAINS-ANNOTATIONS-23.0.0.txt`，Apache-2.0 | https://github.com/JetBrains/java-annotations/tree/23.0.0 |
| Kotlin Stdlib 2.2.21 | JetBrains 及贡献者 | `KOTLIN-2.2.21.txt`，Apache-2.0 | https://github.com/JetBrains/kotlin/tree/v2.2.21 |
| Kotlin Stdlib JDK 7 / 8 兼容库 1.9.10 | JetBrains 及贡献者 | `KOTLIN-1.9.10.txt`，Apache-2.0 | https://github.com/JetBrains/kotlin/tree/v1.9.10 |
| kotlinx.coroutines 1.8.1 | JetBrains 及贡献者 | `KOTLINX-COROUTINES-1.8.1.txt`，Apache-2.0 | https://github.com/Kotlin/kotlinx.coroutines/tree/1.8.1 |
| OkHttp 4.12.0 | Square 及贡献者 | `OKHTTP-4.12.0.txt`，Apache-2.0 | https://github.com/square/okhttp/tree/parent-4.12.0 |
| Okio 3.6.0 | Square 及贡献者 | `OKIO-3.6.0.txt`，Apache-2.0 | https://github.com/square/okio/tree/parent-3.6.0 |
| JSON-java 20240303 | JSON-java 贡献者 | `JSON-JAVA-20240303.txt`，Public Domain | https://github.com/stleary/JSON-java/tree/20240303 |

OkHttp 内置 Public Suffix List 数据的原通知保留于 JAR 中，并另附 `OKHTTP-PUBLIC-SUFFIX-NOTICE.txt`。相关数据由 Public Suffix List 贡献者维护，原通知中的许可证及源代码地址保持不变。

本说明不替代各组件的许可证全文。所有随包的版权、许可证和附加通知应在再分发时继续保留。
