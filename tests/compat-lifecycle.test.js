'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCompat } = require('../compat-video.cjs');

async function fixture(t, scriptBody) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compat-lifecycle-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-ffmpeg');
  await fs.promises.writeFile(script, `#!/usr/bin/env node\n${scriptBody}\n`);
  await fs.promises.chmod(script, 0o755);
  return { dir, script, cacheDir: path.join(dir, 'cache') };
}

async function waitForFile(file) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return await fs.promises.readFile(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for fake ffmpeg to start');
}

test('close kills and reaps active ffmpeg, then waits for conversion cleanup', async (t) => {
  const pidFile = path.join(os.tmpdir(), `compat-lifecycle-${process.pid}-${Date.now()}.pid`);
  t.after(() => fs.promises.rm(pidFile, { force: true }));
  const { script, cacheDir } = await fixture(t,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream() { return { total: 4, async chunk(start, end) { return Buffer.alloc(end - start + 1, 9); } }; },
  } });
  const preparation = compat.prepare('123456', '720P');
  const pid = Number(await waitForFile(pidFile));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);

  const closeA = compat.close();
  const closeB = compat.close();
  await Promise.all([closeA, closeB]);
  await assert.rejects(preparation, (error) => error.playbackCode === 'CANCELLED');
  assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH', 'child has exited before close resolves');
  assert.deepEqual(await fs.promises.readdir(cacheDir), [], 'cancelled conversion is not published');
});

test('range reads remain exact and reject malformed or out-of-file byte ranges', async (t) => {
  const { script, cacheDir } = await fixture(t,
    `const fs=require('node:fs'); const args=process.argv.slice(2); const input=args[args.indexOf('-i')+1]; fs.writeFileSync(args[args.length-1], Buffer.concat([Buffer.from('mp4:'), fs.readFileSync(input)]));`);
  const source = Buffer.from('0123456789abcdef');
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: { async stream() {
    return { total: source.length, async chunk(start, end) { return source.subarray(start, end + 1); } };
  } } });
  t.after(() => compat.close());
  const converted = await compat.prepare('987654', '360P');
  assert.equal(converted.total, 20);
  assert.deepEqual(await converted.chunk(4, 9), Buffer.from('012345'));
  await assert.rejects(converted.chunk(0, converted.total), /范围无效/);
  await assert.rejects(converted.chunk(-1, 0), /范围无效/);
  assert.deepEqual(await converted.chunk(16, 19), Buffer.from('cdef'));
});
