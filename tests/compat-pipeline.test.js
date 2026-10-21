'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createCompat } = require('../compat-video.cjs');
const MiB = 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function setup(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingkan-pipeline-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'ffmpeg');
  fs.writeFileSync(script, '#!/usr/bin/env node\n' + body);
  fs.chmodSync(script, 0o755);
  return { dir, script, cacheDir: path.join(dir, 'cache') };
}
const copier = `const fs=require('node:fs'); const chunks=[];
process.stdin.on('data', chunk => {chunks.push(chunk);fs.writeFileSync(process.argv.at(-1)+'.started','yes');});
process.stdin.on('end',()=>fs.writeFileSync(process.argv.at(-1),Buffer.concat(chunks)));`;
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await sleep(10); }
  assert.fail('timed out');
}
test('pipeline feeds ffmpeg before the last download finishes, preserving exact chunk order', async t => {
  const { script, cacheDir } = await setup(t, copier);
  const original = Buffer.alloc(5 * MiB + 17);
  for (let i = 0; i < original.length; i++) original[i] = Math.floor(i / MiB) + 1;
  let release, active = 0, peak = 0, streams = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream() { streams++; return { total: original.length, pipeable: true, async chunk(start, end) {
      active++; peak = Math.max(peak, active);
      try {
        if (start >= 3 * MiB) await gate;
        else await sleep(start === 0 ? 40 : 5);
        return original.subarray(start, end + 1);
      } finally { active--; }
    } }; },
  } });
  t.after(() => compat.close());
  const work = compat.prepare('123456', '720P');
  try {
    await waitFor(async () => active > 0 && (await fs.promises.readdir(cacheDir)).some(name => name.endsWith('.started')));
    assert.ok(peak <= 3, 'bounded network prefetch');
    assert.equal((await fs.promises.readdir(cacheDir)).some(name => name.endsWith('.input.tmp')), false, 'no full input file on disk');
  } finally { release(); }
  const result = await work;
  assert.deepEqual(await result.chunk(0, result.total - 1), original);
  await compat.prepare('123456', '720P');
  assert.equal(streams, 1, 'completed seekable output is reused');
});
test('pipeline retries short chunks and reports download errors without publishing a cache', async t => {
  const { script, cacheDir } = await setup(t, copier);
  let attempts = 0;
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream() { return { total: 2 * MiB, pipeable: true, async chunk(start, end) {
      if (start === MiB) { attempts++; return Buffer.alloc(1); }
      return Buffer.alloc(end - start + 1);
    } }; },
  } });
  t.after(() => compat.close());
  await assert.rejects(compat.prepare('123456', '720P'), error => error.playbackCode === 'DOWNLOAD_FAILED');
  assert.equal(attempts, 3);
  assert.equal((await fs.promises.readdir(cacheDir)).some(name => /^[a-f0-9]{64}\.mp4$/.test(name)), false);
});
test('closing a pipeline cancels a stalled upstream and encoder promptly', async t => {
  const { script, cacheDir } = await setup(t, copier);
  let started = false;
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream() { return { total: 2 * MiB, pipeable: true, chunk() { started = true; return new Promise(() => {}); } }; },
  } });
  const work = compat.prepare('123456', '720P');
  const rejected = assert.rejects(work, error => error.playbackCode === 'CANCELLED');
  await waitFor(() => started);
  await Promise.race([compat.close(), sleep(2000).then(() => { throw Error('close stalled'); })]);
  await rejected;
  assert.deepEqual(await fs.promises.readdir(cacheDir), []);
});
test('encoder timeout terminates a pipeline even when its first source chunk never arrives', async t => {
  const { script, cacheDir } = await setup(t, copier);
  const compat = createCompat({ ffmpegPath: script, cacheDir, timeoutMs: 120, provider: {
    async stream() { return { total: MiB, pipeable: true, chunk() { return new Promise(() => {}); } }; },
  } });
  t.after(() => compat.close());
  await assert.rejects(compat.prepare('123456', '720P'), error => error.playbackCode === 'CONVERT_TIMEOUT');
});
test('real ffmpeg accepts piped front-loaded MP4 and produces a seekable H264 cache', async t => {
  if (!fs.existsSync('/usr/bin/ffmpeg')) return t.skip('system ffmpeg not installed');
  const { cacheDir } = await setup(t, copier);
  const data = fs.readFileSync(path.join(__dirname, '../qa/fixtures/test-video.mp4'));
  const compat = createCompat({ ffmpegPath: '/usr/bin/ffmpeg', cacheDir, provider: {
    async stream() { return { total: data.length, pipeable: true, async chunk(start, end) { return data.subarray(start, end + 1); } }; },
  } });
  t.after(() => compat.close());
  const result = await compat.prepare('123456', '720P');
  assert.ok(result.total > 0);
  const file = path.join(cacheDir, (await fs.promises.readdir(cacheDir)).find(name => /^[a-f0-9]{64}\.mp4$/.test(name)));
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
  assert.equal(info.streams.find(row => row.codec_type === 'video').codec_name, 'h264');
  assert.equal(info.streams.find(row => row.codec_type === 'audio').codec_name, 'aac');
  assert.deepEqual(await result.chunk(4, 7), Buffer.from('ftyp'));
  const decoded = execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-f', 'framemd5', '-'], { encoding: 'utf8' });
  assert.match(decoded, /#stream#/);
});

test('an encoder exiting successfully before all input is fed is not a successful conversion', async t => {
  const { script, cacheDir } = await setup(t, `require('node:fs').writeFileSync(process.argv.at(-1), 'incomplete');process.exit(0);`);
  let aborted = false;
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream() { return { total: MiB, pipeable: true, chunk(start, end, signal) {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    } }; },
  } });
  t.after(() => compat.close());
  await assert.rejects(compat.prepare('123456', '720P'), error => error.playbackCode === 'CONVERT_FAILED');
  assert.equal(aborted, true, 'network subscriber receives encoder cancellation');
  assert.deepEqual(await fs.promises.readdir(cacheDir), [], 'incomplete output is removed');
});
