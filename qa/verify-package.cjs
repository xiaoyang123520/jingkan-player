'use strict';
const asar = require('@electron/asar'), fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const root = path.resolve(__dirname, '..'); process.chdir(root);
const archive = 'dist/win-unpacked/resources/app.asar';
const files = ['main.js', 'preload.js', 'source.js', 'crypto-compat.cjs', 'compat-video.cjs', 'updater.cjs', 'renderer/app.js', 'renderer/index.html', 'renderer/style.css', 'renderer/update-ui.js', 'renderer/update-style.css', 'vendor/hongguotv/server/provider.mjs', 'vendor/hongguotv/shared/content-core/hongguo.js'];
const checks = files.map(file => { if (!asar.extractFile(archive, file).equals(fs.readFileSync(file))) throw Error('打包代码不是最新版本: ' + file); return { file, match: true }; });
const packed = JSON.parse(asar.extractFile(archive, 'package.json')), expected = require('../package.json');
for (const key of ['name', 'version', 'main', 'dependencies']) { if (JSON.stringify(packed[key]) !== JSON.stringify(expected[key])) throw Error('包内配置不一致: ' + key); } checks.push({ file: 'package.json', match: true });
for (const [input, output] of [['README.md', '使用说明.md'], ['RELEASING.md', 'RELEASING.md'], ['LICENSE', 'LICENSE.jingkan.txt'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md']]) { if (!fs.readFileSync(input).equals(fs.readFileSync('dist/win-unpacked/' + output))) throw Error('随包说明或许可不一致: ' + output); checks.push({ file: output, match: true }); }
for (const file of ['node_modules/sm-crypto/src/index.js', 'node_modules/axios/package.json', 'node_modules/electron-updater/package.json']) { asar.extractFile(archive, file); checks.push({ file, included: true }); }
for (const file of ['ffmpeg.exe', 'LICENSE', 'README']) { const input = fs.readFileSync('tools/ffmpeg/' + file), output = fs.readFileSync('dist/win-unpacked/resources/ffmpeg/' + file); if (!input.equals(output)) throw Error('FFmpeg 文件不一致'); checks.push({ file: 'resources/ffmpeg/' + file, match: true }); }
for (const file of ['dist/win-unpacked/Jingkan.exe', 'dist/win-unpacked/resources/ffmpeg/ffmpeg.exe']) { const exe = fs.readFileSync(file), pe = exe.readUInt32LE(0x3c); if (exe.readUInt16LE(pe + 4) !== 0x8664) throw Error('不是Windows AMD64运行时'); }
let updateFeedConfigured = false;
if (expected.build.publish?.[0]?.owner && expected.build.publish[0].repo) {
  const yaml = require('js-yaml');
  const feed = yaml.load(fs.readFileSync('dist/win-unpacked/resources/app-update.yml', 'utf8'));
  if (feed.owner !== expected.build.publish[0].owner || feed.repo !== expected.build.publish[0].repo) throw Error('更新源不一致');
  const latest = yaml.load(fs.readFileSync('dist/latest.yml', 'utf8'));
  if (latest.version !== expected.version) throw Error('更新元数据版本不一致');
  for (const item of latest.files) {
    const filename = decodeURIComponent(item.url);
    if (path.basename(filename) !== filename) throw Error('非法更新文件路径');
    const buffer = fs.readFileSync(path.join('dist', filename));
    if (crypto.createHash('sha512').update(buffer).digest('base64') !== item.sha512 || buffer.length !== item.size) throw Error('更新安装包SHA512/大小不一致');
  }
  checks.push({ file: 'latest.yml', sha512Match: true }); updateFeedConfigured = true;
}
const report = { version: expected.version, machine: 'AMD64', checks, updateFeedConfigured, windowsNativeAcceptance: false, liveUpdateAcceptance: false, ffmpegSha256: crypto.createHash('sha256').update(fs.readFileSync('tools/ffmpeg/ffmpeg.exe')).digest('hex') };
fs.writeFileSync('qa/package-result.json', JSON.stringify(report, null, 2) + '\n'); console.log('PASS 归档源码与运行时一致，Windows AMD64；更新源已配置=' + updateFeedConfigured);
