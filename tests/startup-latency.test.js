'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSource } = require('../source');
const turn = () => new Promise(resolve => setImmediate(resolve));
const options = { seriesId: '123456', episodeId: '654321', compat: true };

test('quality hints load concurrently with preparation rather than after conversion', async t => {
  let release, preparing = false, qualityCalls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = createSource({
    async detail() { return { episodes: [{ id: '654321' }] }; },
    async qualities() { qualityCalls++; return [{ key: '720P', label: '720P' }, { key: '360P', label: '360P' }]; },
  }, { compat: { async prepare() { preparing = true; await gate; }, async close() { release(); } } });
  t.after(() => runtime.close());
  const work = runtime.play(options);
  while (!preparing) await turn();
  await turn();
  assert.equal(qualityCalls, 1, 'metadata query starts while conversion is pending');
  release();
  assert.deepEqual((await work).qualities.map(q => q.key), ['720P', '360P']);
});

test('a stalled optional quality endpoint cannot indefinitely block ready playback', async t => {
  const runtime = createSource({
    async detail() { return { episodes: [{ id: '654321' }] }; },
    qualities() { return new Promise(() => {}); },
  }, { compat: { async prepare() {}, async close() {} } });
  t.after(() => runtime.close());
  const started = performance.now();
  const result = await Promise.race([
    runtime.play(options),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('optional metadata blocked playback')), 3500); timer.unref(); }),
  ]);
  assert.ok(performance.now() - started < 700, 'ready playback no longer incurs the old 1200ms metadata timeout');
  assert.equal(result.quality, '720P');
  assert.deepEqual(result.qualities, [{ key: '720P', label: '720P' }]);
  assert.ok(result.url.endsWith('/720P/compat'));
});

test('empty or rejected quality hints retain the playable current quality', async t => {
  for (const qualities of [async () => [], async () => { throw Error('private upstream error'); }]) {
    const runtime = createSource({ async detail() { return { episodes: [{ id: '654321' }] }; }, qualities },
      { compat: { async prepare() {}, async close() {} } });
    t.after(() => runtime.close());
    const result = await runtime.play(options);
    assert.deepEqual(result.qualities, [{ key: '720P', label: '720P' }]);
  }
});
