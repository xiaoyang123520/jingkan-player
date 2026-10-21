'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCompat } = require('../compat-video.cjs');

async function fixture(t, scriptBody) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compat-video-'));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-ffmpeg');
  if (typeof scriptBody === 'function') scriptBody = scriptBody(dir);
  await fs.promises.writeFile(script, `#!/usr/bin/env node\n${scriptBody}\n`);
  await fs.promises.chmod(script, 0o755);
  return { dir, script, cacheDir: path.join(dir, 'cache') };
}

const copyingScript = `
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify('/tmp/compat-video-args-unused')}, '');
const input=args[args.indexOf('-i')+1];
const output=args[args.length-1];
fs.writeFileSync(output, Buffer.concat([Buffer.from('converted:'), fs.readFileSync(input)]));
`;

function withArgsLog(logFile) {
  return copyingScript.replace(`fs.writeFileSync(${JSON.stringify('/tmp/compat-video-args-unused')}, '');`,
    `fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(args));`);
}

test('transcodes a bounded chunk source, caches by id/quality, and serves exact byte ranges', async (t) => {
  const { dir, script, cacheDir } = await fixture(t, (dir) => withArgsLog(path.join(dir, 'args.json')));
  const log = path.join(dir, 'args.json');

  const original = Buffer.alloc(1024 * 1024 + 17, 0x5a);
  const calls = [];
  let streamCalls = 0;
  const provider = { async stream(id, fresh, quality) {
    streamCalls++;
    assert.equal(id, '1234567'); assert.equal(quality, '720P'); assert.equal(fresh, streamCalls > 1);
    return { total: original.length, async chunk(start, end) {
      calls.push([start, end]);
      return original.subarray(start, end + 1);
    } };
  } };
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider });
  const [first, duplicate] = await Promise.all([
    compat.prepare('1234567', '720P'), compat.prepare('1234567', '720P'),
  ]);
  assert.equal(streamCalls, 1, 'simultaneous preparations are deduplicated');
  assert.equal(first.total, Buffer.byteLength('converted:') + original.length);
  assert.equal(duplicate.total, first.total);
  assert.deepEqual(calls, [[0, 1024 * 1024 - 1], [1024 * 1024, original.length - 1]]);
  assert.deepEqual(await first.chunk(4, 17), Buffer.concat([Buffer.from('erted:'), Buffer.alloc(8, 0x5a)]));
  assert.deepEqual(await first.chunk(first.total - 4, first.total - 1), Buffer.alloc(4, 0x5a));
  await assert.rejects(first.chunk(-1, 0), /范围无效/);
  assert.deepEqual(await fs.promises.readdir(cacheDir), [
    require('node:crypto').createHash('sha256').update('1234567|720P').digest('hex') + '.mp4',
  ]);
  const args = JSON.parse(await fs.promises.readFile(log, 'utf8'));
  for (const pair of [['-c:v', 'libx264'], ['-preset', 'veryfast'], ['-crf', '23'], ['-threads', '2'],
    ['-pix_fmt', 'yuv420p'], ['-c:a', 'copy'], ['-movflags', '+faststart']]) {
    assert.ok(args.some((value, index) => value === pair[0] && args[index + 1] === pair[1]), `ffmpeg args include ${pair.join(' ')}`);
  }
  assert.equal(args.includes('-y'), true);
  await compat.prepare('1234567', '720P');
  assert.equal(streamCalls, 1, 'cache hit avoids a second provider request');
  await compat.prepare('1234567', '720P', true);
  assert.equal(streamCalls, 2, 'fresh bypasses the cache');
  await compat.close();
});

test('rejects invalid ids, qualities, ranges, oversized sources, and hides provider errors', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  let streams = 0;
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: { async stream() {
    streams++;
    throw new Error('https://secret.example/media?token=secret');
  } } });
  await assert.rejects(compat.prepare('12345', '720P'), /无效/);
  await assert.rejects(compat.prepare('123456', '4K'), /无效/);
  assert.equal(streams, 0);
  await assert.rejects(compat.prepare('123456', '720P'), (error) => {
    assert.equal(error.message, '视频兼容转换失败');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
  await compat.close();

  const large = createCompat({ ffmpegPath: script, cacheDir: path.join(cacheDir, 'large'), provider: {
    async stream() { return { total: 150 * 1024 * 1024 + 1, async chunk() { assert.fail('must reject before reading'); } }; },
  } });
  await assert.rejects(large.prepare('123456', 'auto'), /兼容转换失败/);
  await large.close();
});

test('reports invalid byte ranges and does not publish failed ffmpeg output', async (t) => {
  const { dir, cacheDir } = await fixture(t, 'process.exit(7);');
  const compat = createCompat({ ffmpegPath: path.join(dir, 'fake-ffmpeg'), cacheDir, provider: {
    async stream() { return { total: 4, async chunk(start, end) { return Buffer.alloc(end - start + 1, 1); } }; },
  } });
  await assert.rejects(compat.prepare('123456', '360P'), (error) => error.message === '视频兼容转换失败');
  assert.deepEqual(await fs.promises.readdir(cacheDir), []);
  await compat.close();
});

test('classifies provider, oversized input, missing ffmpeg, timeout, conversion, and cache failures', async (t) => {
  const { dir, script, cacheDir } = await fixture(t, 'process.exit(7);');
  const provider = { async stream() { return { total: 4, async chunk(start, end) { return Buffer.alloc(end - start + 1, 1); } }; } };
  const assertCode = async (compat, expected) => assert.rejects(compat.prepare('123456', '360P'), (error) => {
    assert.equal(error.message, '视频兼容转换失败');
    assert.equal(error.playbackCode, expected);
    assert.equal(error.message.includes('secret'), false);
    return true;
  });

  const missing = createCompat({ ffmpegPath: path.join(dir, 'missing-ffmpeg'), cacheDir: path.join(cacheDir, 'missing'), provider });
  await assertCode(missing, 'CONVERT_UNAVAILABLE');
  await missing.close();

  const timeoutScript = await fixture(t, 'setTimeout(() => {}, 10000);');
  const timeout = createCompat({ ffmpegPath: timeoutScript.script, cacheDir: path.join(cacheDir, 'timeout'), provider, timeoutMs: 40 });
  await assertCode(timeout, 'CONVERT_TIMEOUT');
  await timeout.close();

  const failed = createCompat({ ffmpegPath: script, cacheDir: path.join(cacheDir, 'failed'), provider });
  await assertCode(failed, 'CONVERT_FAILED');
  await failed.close();

  const sourceError = createCompat({ ffmpegPath: script, cacheDir: path.join(cacheDir, 'source'), provider: {
    async stream() { throw new Error('https://private.invalid/?secret=token'); },
  } });
  await assertCode(sourceError, 'SOURCE_UNAVAILABLE');
  await sourceError.close();

  const oversized = createCompat({ ffmpegPath: script, cacheDir: path.join(cacheDir, 'large'), provider: {
    async stream() { return { total: 150 * 1024 * 1024 + 1, async chunk() { assert.fail('oversized source must not download'); } }; },
  } });
  await assertCode(oversized, 'INPUT_TOO_LARGE');
  await oversized.close();

  const cacheFile = path.join(dir, 'not-a-directory');
  await fs.promises.writeFile(cacheFile, 'x');
  const cacheFailure = createCompat({ ffmpegPath: script, cacheDir: cacheFile, provider });
  await assertCode(cacheFailure, 'CACHE_FAILED');
  await cacheFailure.close();
});

test('retries transient chunk failures up to three times and reports download progress safely', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  const source = Buffer.from('download data');
  let calls = 0;
  const events = [];
  const compat = createCompat({ ffmpegPath: script, cacheDir, onProgress(event) {
    events.push(event);
    throw new Error('observer exception must be ignored');
  }, provider: { async stream() { return { total: source.length, async chunk(start, end) {
    calls++;
    if (calls < 3) throw new Error('temporary transport error');
    return source.subarray(start, end + 1);
  } }; } } });
  const result = await compat.prepare('123456', '720P');
  assert.equal(calls, 3);
  assert.ok(events.some((event) => event.stage === 'source'));
  assert.ok(events.some((event) => event.stage === 'download' && event.percent === 100));
  assert.ok(events.some((event) => event.stage === 'convert' && event.elapsedSeconds === 0));
  assert.ok(events.some((event) => event.stage === 'ready'));
  assert.ok(events.every((event) => event.episodeId === '123456' && event.quality === '720P'));
  assert.equal((await result.chunk(0, result.total - 1)).toString(), `converted:${source}`);
  await compat.close();
});

test('permanent short reads fail after three attempts and close cancels active preparation', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  let shortReads = 0;
  const broken = createCompat({ ffmpegPath: script, cacheDir, provider: { async stream() { return { total: 4, async chunk() {
    shortReads++;
    return Buffer.from('x');
  } }; } } });
  await assert.rejects(broken.prepare('123456', '360P'), (error) => error.playbackCode === 'DOWNLOAD_FAILED');
  assert.equal(shortReads, 3, 'at most three attempts per chunk');
  await broken.close();

  let release;
  const waiting = createCompat({ ffmpegPath: script, cacheDir: path.join(cacheDir, 'cancel'), provider: {
    stream() { return new Promise((resolve) => { release = () => resolve({ total: 4, async chunk() { return Buffer.alloc(4); } }); }); },
  } });
  const preparing = waiting.prepare('123456', '360P');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await waiting.close();
  release();
  await assert.rejects(preparing, (error) => error.message === '视频兼容转换失败' && error.playbackCode === 'CANCELLED');
});

test('cache initialization can recover after a temporary filesystem failure', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  await fs.promises.writeFile(cacheDir, 'blocking file');
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream() { return { total: 4, async chunk(a, b) { return Buffer.alloc(b - a + 1, 1); } }; },
  } });
  t.after(() => compat.close());
  await assert.rejects(compat.prepare('123456', '720P'), e => e.playbackCode === 'CACHE_FAILED');
  await fs.promises.unlink(cacheDir);
  const recovered = await compat.prepare('123456', '720P');
  assert.ok(recovered.total > 4);
});

test('fresh preparation queues a real refresh after an ordinary in-flight build', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream(eid, fresh) {
      calls.push(fresh);
      if (!fresh) await gate;
      return { total: 4, async chunk(a, b) { return Buffer.alloc(b - a + 1, fresh ? 2 : 1); } };
    },
  } });
  t.after(() => compat.close());
  const ordinary = compat.prepare('123456', '720P');
  while (!calls.length) await new Promise(resolve => setImmediate(resolve));
  const [freshA, freshB] = [compat.prepare('123456', '720P', true), compat.prepare('123456', '720P', true)];
  release();
  await ordinary;
  const [a, b] = await Promise.all([freshA, freshB]);
  assert.deepEqual(calls, [false, true], 'refresh is not swallowed, and concurrent refreshes are deduplicated');
  assert.equal(a.total, b.total);
  assert.deepEqual(await a.chunk(a.total - 4, a.total - 1), Buffer.alloc(4, 2));
});

test('zero-byte cached videos are rebuilt after startup and after runtime truncation', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const name = require('node:crypto').createHash('sha256').update('123456|720P').digest('hex') + '.mp4';
  const file = path.join(cacheDir, name);
  await fs.promises.writeFile(file, Buffer.alloc(0));
  let providerCalls = 0;
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: { async stream() {
    providerCalls++;
    return { total: 4, async chunk(start, end) { return Buffer.alloc(end - start + 1, 7); } };
  } } });
  t.after(() => compat.close());
  const first = await compat.prepare('123456', '720P');
  assert.ok(first.total > 0);
  assert.equal(providerCalls, 1);
  await fs.promises.truncate(file, 0);
  const second = await compat.prepare('123456', '720P');
  assert.ok(second.total > 0);
  assert.equal(providerCalls, 2);
  assert.equal((await second.chunk(0, second.total - 1)).length, second.total);
  await fs.promises.truncate(file, 2);
  const third = await compat.prepare('123456', '720P');
  assert.ok(third.total > 2);
  assert.equal(providerCalls, 3);
});

test('active playback lease prevents cache eviction until its stream is released', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  const compat = createCompat({ ffmpegPath: script, cacheDir, maxBytes: 20, provider: {
    async stream() { return { total: 4, async chunk(start, end) { return Buffer.alloc(end - start + 1, 7); } }; },
  } });
  t.after(() => compat.close());
  const active = await compat.prepare('123456', '720P', false, true);
  const second = await compat.prepare('123457', '720P');
  assert.ok(second.total > 0);
  assert.deepEqual(await active.chunk(0, active.total - 1), Buffer.from('converted:' + '\x07'.repeat(4)),
    'a concurrent cache trim must not remove an entry held by an active media request');
  await active.release();
  assert.deepEqual(await fs.promises.readdir(cacheDir), [
    require('node:crypto').createHash('sha256').update('123456|720P').digest('hex') + '.mp4',
  ], 'after release the over-budget cache trims the least recently used entry');
});

test('bounded parallel downloads preserve byte positions and monotonic progress despite out-of-order chunks', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  const original = Buffer.alloc(4 * 1024 * 1024 + 31);
  for (let i = 0; i < original.length; i++) original[i] = (i * 17 + (i >>> 12)) & 0xff;
  let active = 0;
  let peak = 0;
  const finished = [];
  const progress = [];
  const compat = createCompat({ ffmpegPath: script, cacheDir, downloadConcurrency: 3,
    onProgress(event) { if (event.stage === 'download') progress.push(event.percent); },
    provider: { async stream() { return { total: original.length, async chunk(start, end) {
      active++;
      peak = Math.max(peak, active);
      try {
        const index = Math.floor(start / (1024 * 1024));
        await new Promise(resolve => setTimeout(resolve, index === 0 ? 60 : (4 - index) * 5));
        finished.push(index);
        return original.subarray(start, end + 1);
      } finally { active--; }
    } }; } } });
  t.after(() => compat.close());
  const result = await compat.prepare('123456', '720P');
  assert.equal(peak, 3, 'never exceeds configured concurrency and uses all three workers');
  assert.notDeepEqual(finished, [0, 1, 2, 3, 4], 'chunks complete out of order');
  assert.deepEqual(await result.chunk(0, result.total - 1), Buffer.concat([Buffer.from('converted:'), original]));
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b), 'reported download percentage never regresses');
  assert.equal(progress.at(-1), 100);
});

test('download failure waits for every in-flight worker before temp files are removed', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  let slowWorkersSettled = 0;
  let failAttempts = 0;
  const compat = createCompat({ ffmpegPath: script, cacheDir, downloadConcurrency: 3, provider: {
    async stream() { return { total: 3 * 1024 * 1024, async chunk(start, end) {
      if (start === 0) { failAttempts++; throw new Error('temporary error'); }
      await new Promise(resolve => setTimeout(resolve, start === 1024 * 1024 ? 35 : 65));
      slowWorkersSettled++;
      return Buffer.alloc(end - start + 1, 7);
    } }; },
  } });
  t.after(() => compat.close());
  await assert.rejects(compat.prepare('123456', '720P'), error => error.playbackCode === 'DOWNLOAD_FAILED');
  assert.equal(failAttempts, 3, 'failed chunk retains the existing retry policy');
  assert.equal(slowWorkersSettled, 2, 'failure is not returned until all started workers settle');
  assert.deepEqual(await fs.promises.readdir(cacheDir), [], 'cleanup happens after workers stop writing');
});

test('startup removes only exact compat temp-file names and tolerates unrelated files', async (t) => {
  const { script, cacheDir } = await fixture(t, copyingScript);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const staleInput = 'a'.repeat(32) + '.input.tmp';
  const staleOutput = 'b'.repeat(32) + '.partial.mp4';
  const keep = ['a'.repeat(31) + '.input.tmp', 'c'.repeat(32) + '.other.tmp', 'notes.txt'];
  for (const name of [staleInput, staleOutput, ...keep]) await fs.promises.writeFile(path.join(cacheDir, name), 'stale');
  const compat = createCompat({ ffmpegPath: script, cacheDir, provider: {
    async stream() { return { total: 4, async chunk(start, end) { return Buffer.alloc(end - start + 1, 7); } }; },
  } });
  t.after(() => compat.close());
  await compat.prepare('123456', '720P');
  const names = await fs.promises.readdir(cacheDir);
  assert.equal(names.includes(staleInput), false);
  assert.equal(names.includes(staleOutput), false);
  for (const name of keep) assert.equal(names.includes(name), true, `${name} is preserved`);
});

test('downloadConcurrency accepts only integer values from one through four', (t) => {
  const base = { ffmpegPath: 'ffmpeg', cacheDir: '/tmp/compat-test', provider: { stream() {} } };
  for (const value of [0, 5, 1.5, '3']) {
    assert.throws(() => createCompat({ ...base, downloadConcurrency: value }), /参数无效/);
  }
  for (const value of [1, 2, 3, 4]) assert.doesNotThrow(() => createCompat({ ...base, downloadConcurrency: value }));
});
