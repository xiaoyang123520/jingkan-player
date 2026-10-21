'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const target = path.resolve(__dirname, '../tools/ffmpeg/ffmpeg.exe');
const expected = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00';
const url = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64';
const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
(async () => {
  if (fs.existsSync(target) && hash(target) === expected) { console.log('FFmpeg 固定版本校验通过'); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.download';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body) throw Error(`FFmpeg 下载失败（HTTP ${response.status}）`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { flags: 'w' }));
    if (hash(temporary) !== expected) throw Error('FFmpeg SHA256 校验失败，未采用下载内容');
    fs.renameSync(temporary, target);
    console.log('FFmpeg 已下载且固定哈希校验通过');
  } finally { fs.rmSync(temporary, { force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
