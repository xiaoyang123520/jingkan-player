'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createPlayableStream } = require('../vendor/hongguotv/server/provider.mjs');

const corePath = path.join(__dirname, '../vendor/hongguotv/shared/content-core/hongguo.js');
function coreHarness(body) {
  const requests = [];
  const axios = async (url, config) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(config.headers.Range);
    assert.ok(range, 'media request must include a byte range');
    const start = Number(range[1]), end = Number(range[2]);
    requests.push({ url, start, end });
    return {
      status: 206,
      data: body.subarray(start, end + 1),
      headers: { 'content-range': `bytes ${start}-${end}/${body.length}` },
    };
  };
  const context = vm.createContext({
    require: name => {
      assert.equal(name, 'node:crypto');
      return crypto;
    },
    Buffer,
    axios,
    AbortController,
    mediaLookup: undefined,
  });
  const source = fs.readFileSync(corePath, 'utf8');
  vm.runInContext(`${source}\nthis.testApi = { prepareHeader, remoteRange };`, context, { timeout: 5000 });
  return { api: context.testApi, requests };
}

function sampleMp4(total) {
  const body = Buffer.alloc(total);
  body.writeUInt32BE(16, 0);
  body.write('ftyp', 4, 'ascii');
  body.write('isom', 8, 'ascii');
  body.writeUInt32BE(8, 16);
  body.write('moov', 20, 'ascii');
  for (let i = 24; i < body.length; i++) body[i] = i % 251;
  return body;
}

test('parallel header preparation is single-flight and playback reuses cached prefix bytes', async () => {
  const body = sampleMp4(1536 * 1024);
  const { api, requests } = coreHarness(body);
  const stream = { url: 'https://media.example/video', backupUrl: '', key: null };

  const [preparedA, preparedB] = await Promise.all([
    api.prepareHeader(stream),
    api.prepareHeader(stream),
  ]);
  assert.equal(preparedA, preparedB);
  assert.equal(preparedA.total, body.length);
  assert.equal(requests.length, 1, 'parallel callers should share the initial header transfer');
  assert.equal(requests[0].start, 0);
  assert.equal(requests[0].end, 256 * 1024 - 1);

  const playbackEnd = 1024 * 1024 - 1;
  const playback = await api.remoteRange(stream, 0, playbackEnd);
  assert.deepEqual(playback.data, body.subarray(0, playbackEnd + 1));
  assert.deepEqual(requests.slice(1).map(({ start, end }) => [start, end]), [[256 * 1024, playbackEnd]],
    'playback should fetch only bytes not already downloaded for header preparation');
});

test('provider stream exposes the sequential pipe contract and preserves chunk decryption', async () => {
  const calls = [];
  const internal = {
    streamCache: { delete: key => calls.push(['delete-stream', key]) },
    videoInfoCache: { delete: key => calls.push(['delete-info', key]) },
    async resolveStream(id, quality) { calls.push(['resolve', id, quality]); return { key: 'test-key' }; },
    async prepareHeader(stream) { calls.push(['prepare', stream.key]); return { total: 777, header: Buffer.from('mp4') }; },
    async remoteRange(stream, start, end, signal) { calls.push(['range', stream.key, start, end, signal]); return { data: Buffer.from([1, 2, 3]) }; },
    decryptPartial(data, start, key, prepared) { calls.push(['decrypt', start, key, prepared.total]); return data; },
  };
  const stream = await createPlayableStream(internal, '12345', false, '720P');
  assert.equal(stream.total, 777);
  assert.equal(stream.pipeable, true);
  const controller = new AbortController();
  assert.deepEqual(await stream.chunk(0, 2, controller.signal), Buffer.from([1, 2, 3]));
  assert.deepEqual(calls, [
    ['resolve', '12345', '720P'],
    ['prepare', 'test-key'],
    ['range', 'test-key', 0, 2, controller.signal],
    ['decrypt', 0, 'test-key', 777],
  ]);
});

test('fresh provider stream still invalidates cached stream and video metadata', async () => {
  const calls = [];
  const internal = {
    streamCache: { delete: key => calls.push(['delete-stream', key]) },
    videoInfoCache: { delete: key => calls.push(['delete-info', key]) },
    async resolveStream() { return { key: null }; },
    async prepareHeader() { return { total: 8 }; },
    async remoteRange() { return { data: Buffer.alloc(0) }; },
    decryptPartial(data) { return data; },
  };
  await createPlayableStream(internal, '67890', true, '1080P');
  assert.deepEqual(calls, [['delete-stream', '67890|1080P'], ['delete-info', '67890']]);
});
