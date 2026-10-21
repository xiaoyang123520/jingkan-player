'use strict';
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const directory = path.join(__dirname, 'fixtures'); fs.mkdirSync(directory, { recursive: true });
const executable = process.platform === 'win32' ? path.join(__dirname, '../tools/ffmpeg/ffmpeg.exe') : 'ffmpeg';
const result = spawnSync(executable, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', path.join(directory, 'test-video-silent.mp4')], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status || 0;
