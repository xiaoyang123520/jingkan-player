# 第三方来源与变更说明

## hongguoTV

来源：https://github.com/sgsjsvc/hongguoTV

本次固定提交：`58c034ea91dfb0f280bc7c181049493b13c7eb11`

许可证：GPL-3.0-only。完整文本位于根目录 `LICENSE` 及 `vendor/hongguotv/LICENSE`。

随附文件：

- `vendor/hongguotv/shared/content-core/hongguo.js`：固定提交中的共享内容引擎，未修改。
- `vendor/hongguotv/shared/category-contract.cjs`：分类数据契约，未修改。
- `vendor/hongguotv/server/provider.mjs`：基于固定提交修改，增加清晰度列表接口及按选定清晰度播放/刷新缓存的参数，注入 Electron SM3 兼容层，并修正搜索超时及计时器清理；保留原有作者注释。
- `vendor/hongguotv/server/http.mjs`：原参考实现，用作设计参考；发行程序实际使用根目录 `source.js` 的本地令牌服务。
- `vendor/hongguotv/UPSTREAM-NOTICE.md`：保留上游的第三方告知。该告知部分提及其完整仓库的其他组件，不代表本包包含那些组件。
- `vendor/hongguotv/LICENSE.drpys`：保留内容引擎的原始上游 GPL 告知。

上游引擎曾衍生自 https://github.com/woshishiq1/drpys ，原始来源与提交见保留的 UPSTREAM-NOTICE.md。此版本并未打包 Android TV、React Native、家庭同步服务或上游 Windows 二进制。

## 净看旧版

原净看 0.1 界面与桌面壳在 MIT 许可下提供。原有许可保留在 `vendor/LICENSE.jingkan-original.txt`。本次包含 GPL 代码的组合版本按 GPL-3.0-only 交付；修改记录以使用说明和对应源码为准。GPL 不改变原作者对其原 MIT 代码的授权。

## 运行时和依赖

- Electron 44.9.3：https://github.com/electron/electron ，MIT；Chromium 等组件许可见 Windows 发行包随附的 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`。
- sm-crypto 0.5.7：https://github.com/JuneAndGreen/sm-crypto ，MIT；用于补齐 Electron BoringSSL 不支持的 SM3 摘要，其他加密原语仍使用运行时原生实现。
- axios 1.20.0：https://github.com/axios/axios ，MIT。
- electron-updater 6.8.11：https://github.com/electron-userland/electron-builder ，MIT；用于 Windows NSIS 安装版按需在线更新。
- electron-builder 26.15.3：https://github.com/electron-userland/electron-builder ，MIT；仅用于构建。

各传递依赖的许可证保留在运行包应用归档中的相应 `node_modules` 目录及 npm 发行源码中；准确依赖树由 package-lock.json 记录。交付源码包对应本次交付的应用二进制版本。

非官方接口可用性、内容版权及平台条款需由使用者自行确认；开源许可证不授予内容平台的商标或影视内容使用权。

## FFmpeg 兼容播放工具

随附 `tools/ffmpeg/ffmpeg.exe` / Windows 包 `resources/ffmpeg/ffmpeg.exe` 是 eugeneware/ffmpeg-static 的 b6.1.1 发行附件，来自 Gyan 6.1.1 essentials build，许可证 GPL v3。没有修改该二进制。

- 下载来源：https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- 二进制 SHA256：`04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00`
- 对应 FFmpeg 源码：https://github.com/FFmpeg/FFmpeg/tree/e38092ef93
- 构建者与构建资料：https://www.gyan.dev/ffmpeg/builds/
- x264 源码：https://code.videolan.org/videolan/x264

该构建的完整配置、依赖版本、版权信息及 GPL 全文保留在 `tools/ffmpeg/README`、`tools/ffmpeg/LICENSE`，发行包中同样保留。本包只通过独立子进程调用它处理本机临时媒体文件，不使用它打开用户提供的任意网络地址。应用自身对应源码在本次源码包中；FFmpeg 等第三方项目源码遵循其各自来源和许可证。
