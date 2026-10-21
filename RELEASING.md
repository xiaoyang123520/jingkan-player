# 净看发布与在线更新

## 第一次发布

建议公开仓库名为 `jingkan-player`。在拥有者确认确切公开内容前，不创建公开仓库、不推送文件、不创建 Release。

公开 Git 内容为应用源码、版本锁文件、GPL 及第三方许可、测试代码、构建脚本和说明。不得提交个人配置、收藏/进度、API 凭据、环境变量文件、历史调试记录、播放素材或缓存。FFmpeg 二进制不进 Git，由固定哈希下载脚本准备；构建产物放 Releases。

确认真实拥有者和仓库后执行：

```sh
node scripts/configure-release.cjs OWNER/jingkan-player
npm install --package-lock-only --ignore-scripts
npm ci
node scripts/prepare-ffmpeg.cjs
npm test
npm run build:win
node qa/verify-package.cjs
```

`npm test` 在 Linux 运行；Windows 构建可以与 Linux 测试拆开完成。必须以绑定真实仓库后重新构建的安装包发布，不能发布未配置更新源的候选包。不要在客户端嵌入 GitHub Token；公开仓库更新不需要客户端密钥。

## 逐个核对 Release 附件

版本标签与 `package.json` 一致，如 `v0.2.5`，作为正式版发布，不能是草稿或 prerelease。至少包含：

- `Jingkan-Setup-0.2.5-x64.exe`
- `Jingkan-Setup-0.2.5-x64.exe.blockmap`
- `latest.yml`，由同一次安装包构建生成，不能手写哈希
- `Jingkan-0.2.5-windows-x64.zip`（便携版，可选）
- `Jingkan-0.2.5-source.zip`，与交付二进制对应的完整源码和必要第三方许可
- `SHA256SUMS.txt` 和准确的版本说明

安装包、blockmap、latest.yml 必须匹配同一版本。检查 `latest.yml` 的 version、安装包文件名和 SHA512，并与安装程序实际计算值比对。只上传 ZIP 或只上传 EXE，不能构成完整在线更新源。

GitHub Actions 的 `Build Windows release candidates` 只产生待审查 Artifact，不自动发布。不需要为了构建给工作流开放 contents:write。

## 后续发布

升高 `package.json` 的稳定版本号并同步锁文件、界面版本说明及变更记录；重复测试、构建、验证及附件核对。GitHub 最新正式 Release 才是安装版的更新源。不要覆盖旧版本的附件，不要让标签版本与包内版本不同。

没有商业代码签名证书时必须公开说明未知发布者风险。SHA512/SHA256 是完整性检查，不是独立的发布者认证，仓库账号必须启用强认证。

## Windows 必做验收

在干净的 Windows 用户环境先安装低版本，写入收藏和进度，然后发布更高的测试版本。检查启动提示、用户手动下载、下载进度、取消重启、确认安装和新版本启动，确认收藏/历史/进度仍保留。还需覆盖断网、下载失败、校验失败和正常退出不安装。

0.2.3 不含更新器，只能手动安装一次新安装版。ZIP 便携版本不宣称支持原地自动安装。

当前沙箱仅能验证 Linux 下单元/界面回归、Windows 包结构以及模拟更新生命周期；在真实公开仓库和 Windows 跨版本验证完成前，状态应记录为“实现完成，线上验收待完成”，不能记录为“已上线且更新成功”。
