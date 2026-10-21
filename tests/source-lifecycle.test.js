'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSource } = require('../source');
const SID = '123456', EID = '654321';
const opts = { seriesId: SID, episodeId: EID };
const stream = () => ({ total: 4, async chunk(s, e) { return Buffer.alloc(e - s + 1); } });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function provider(overrides = {}) { return { async detail() { return { episodes: [{ id: EID }] }; }, async qualities() { return []; }, async stream() { return stream(); }, ...overrides }; }

test('deduplicated play failures are sanitized for every caller', async t => {
  const gate = deferred(), entered = deferred();
  const source = createSource(provider({ async stream() { entered.resolve(); await gate.promise; throw Error('https://private.invalid/?signature=secret'); } }));
  t.after(() => source.close());
  const first = source.play(opts);
  await entered.promise;
  const second = source.play(opts);
  const settled = Promise.allSettled([first, second]);
  gate.resolve();
  const results = await settled;
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /片源暂不可用/);
    assert.doesNotMatch(result.reason.message, /private|signature|secret/);
  }
  assert.equal(results[0].reason.message, results[1].reason.message);
});

test('closing during detail lookup cancels play without opening a new media server', async () => {
  const gate = deferred(), entered = deferred(); let streamCalls = 0;
  const source = createSource(provider({ async detail() { entered.resolve(); await gate.promise; return { episodes: [{ id: EID }] }; }, async stream() { streamCalls++; return stream(); } }));
  const result = source.play(opts).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await source.close();
  gate.resolve();
  try {
    const outcome = await result;
    assert.ok(outcome.error, 'closed playback must not return a URL');
    assert.match(outcome.error.message, /取消/);
    assert.equal(streamCalls, 0);
  } finally { await source.close(); }
});

test('closing during stream setup cancels promptly and permits explicit restart', async () => {
  const gate = deferred(), entered = deferred(); let held = true;
  const source = createSource(provider({ async stream() { if (held) { entered.resolve(); await gate.promise; } return stream(); } }));
  const result = source.play(opts).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await source.close();
  try {
    const outcome = await Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(Error('cancellation stalled')), 250).unref())]);
    assert.match(outcome.error?.message || '', /取消/);
    held = false;
    await source.init();
    const fresh = await source.play(opts);
    assert.equal(source.isMediaUrl(fresh.url), true);
  } finally { gate.resolve(); await source.close(); }
});

test('closing immediately during server startup settles the startup promise', async () => {
  for (let i = 0; i < 20; i++) {
    const source = createSource(provider());
    const started = source.init().then(() => 'ready', () => 'cancelled');
    await source.close();
    let timer;
    try {
      const result = await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('startup did not settle')), 250); })]);
      assert.equal(result, 'cancelled');
    } finally { clearTimeout(timer); await source.close(); }
  }
});

test('non-Error upstream failures still produce a safe playback error', async t => {
  const source = createSource(provider({ async stream() { throw null; } }));
  t.after(() => source.close());
  await assert.rejects(source.play(opts), /片源暂不可用/);
});

test('close cancels every active play and the latest queued selection', async () => {
  const ids = Array.from({ length: 5 }, (_, i) => String(654321 + i));
  const gate = deferred(); let calls = 0;
  const source = createSource(provider({
    async detail() { return { episodes: ids.map(id => ({ id })) }; },
    async stream() { calls++; await gate.promise; return stream(); },
  }));
  const active = ids.slice(0, 4).map(episodeId => source.play({ ...opts, episodeId }).then(() => 'unexpected success', e => e.message));
  while (calls < 4) await new Promise(r => setImmediate(r));
  const queued = source.play({ ...opts, episodeId: ids[4] }).then(() => 'unexpected success', e => e.message);
  await source.close();
  try { for (const message of await Promise.all([...active, queued])) assert.match(message, /取消/); assert.equal(calls, 4); }
  finally { gate.resolve(); await source.close(); }
});
