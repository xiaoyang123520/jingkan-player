'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const SERIES_ID = '123456';
const EPISODES = [
  { id: '654321', index: 1, available: true },
  { id: '654322', index: 2, available: true },
];
const mediaUrl = (episodeId, quality = '720P') => `http://127.0.0.1:1234/media/${'a'.repeat(64)}/${SERIES_ID}/${episodeId}/${quality}`;
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const on = force === undefined ? !this.values.has(value) : Boolean(force);
    if (on) this.values.add(value); else this.values.delete(value);
    return on;
  }
}

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.listeners = {};
    this.classList = new FakeClassList(); this.dataset = {}; this.attributes = {}; this.hidden = true;
    this.disabled = false; this.checked = false; this.value = ''; this.textContent = '';
    this.currentTime = 0; this.duration = NaN; this.playbackRate = 1; this.currentSrc = ''; this.playCalls = 0;
    this._src = ''; this.parentNode = null;
  }
  get options() { return this.children.filter((node) => node.tagName === 'OPTION'); }
  set src(value) { this._src = String(value); this.currentSrc = this._src; }
  get src() { return this._src; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  dispatch(type, event = {}) {
    const e = { target: this, preventDefault() {}, ...event };
    for (const callback of this.listeners[type] || []) callback(e);
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  insertBefore(child, before) { const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); child.parentNode = this; return child; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') { this._src = ''; this.currentSrc = ''; } }
  pause() { this.dispatch('pause'); }
  load() {}
  play() { this.playCalls++; return Promise.resolve(); }
  scrollIntoView() {}
}

function makeHarness({ storage = {}, deferredPlay = null } = {}) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, new FakeElement(id === 'player-video' ? 'video' : 'div', id));
    return nodes.get(id);
  };
  const nav = ['favorites', 'recent'].map((view) => { const node = new FakeElement('button'); node.dataset.view = view; return node; });
  const body = new FakeElement('body'); body.classList = new FakeClassList();
  const document = {
    body,
    getElementById: get,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), parentNode: null }),
    querySelectorAll(selector) { return selector === '.nav-item' ? nav : []; },
    querySelector(selector) { return selector === '.catalog-section' ? new FakeElement('section') : null; },
    addEventListener() {},
  };
  const store = new Map(Object.entries(storage));
  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
  };
  const playCalls = [];
  let activeDeferredPlay = deferredPlay;
  const player = {
    async catalog() { return { items: [], page: 1, totalPages: 1 }; },
    async detail(id) { return { id, title: '测试剧', intro: '', cover: '', tags: [], episodes: EPISODES }; },
    async play(request) {
      playCalls.push(request);
      if (activeDeferredPlay && activeDeferredPlay.match(request)) return activeDeferredPlay.promise;
      return { url: mediaUrl(request.episodeId), quality: '720P', qualities: [{ key: '720P', label: '720P' }, { key: '1080P', label: '1080P' }] };
    },
    onProgress() {},
  };
  const window = { player, clearInterval() {}, setInterval() { return 1; }, clearTimeout() {}, setTimeout() { return 1; } };
  vm.runInNewContext(APP, { window, document, localStorage, URL, Date, Number, String, Array, Object, Math, JSON, Promise, Error, RegExp, setTimeout, clearTimeout });
  return { get, store, playCalls, nav, setDeferredPlay(value) { activeDeferredPlay = value; } };
}

async function openSeries(h) {
  const input = h.get('quick-open-input'); input.value = SERIES_ID;
  h.get('quick-open-form').dispatch('submit');
  await tick(); await tick();
  assert.equal(h.get('episode-list').children.length, EPISODES.length);
}
async function clickEpisode(h, index) {
  h.get('episode-list').children[index].dispatch('click');
  await tick(); await tick();
}
function readJSON(h, key) { return JSON.parse(h.store.get(key)); }


test('corrupt favorites/history records are ignored instead of crashing counts or local lists', async () => {
  const h = makeHarness({ storage: {
    'hg-player-favorites-v1': '[null,7,{"extra":1},{"id":"saved"}]',
    'hg-player-history-v1': '[null,false,{"id":"saved"}]',
  } });
  assert.equal(h.get('favorite-count').textContent, '1');
  h.nav.find((node) => node.dataset.view === 'recent').dispatch('click');
  assert.equal(h.get('list-grid').children.length, 1);
  await openSeries(h);
  h.get('favorite-button').dispatch('click');
  assert.deepEqual(readJSON(h, 'hg-player-favorites-v1').map((record) => record.id), [SERIES_ID, 'saved']);
  assert.equal(h.get('favorite-count').textContent, '2');
});

test('invalid progress records are discarded and late events from the previous episode cannot write to the new one', async () => {
  let release;
  const gate = { match: (request) => request.episodeId === EPISODES[1].id, promise: new Promise((resolve) => { release = resolve; }) };
  const h = makeHarness({ deferredPlay: gate, storage: {
    'hg-player-progress-v1': JSON.stringify({
      [`${SERIES_ID}::${EPISODES[0].id}`]: { time: 'broken', updatedAt: 9 },
      [`${SERIES_ID}::${EPISODES[1].id}`]: { time: 78, updatedAt: 'bad' },
      garbage: null,
    }),
  } });
  await openSeries(h); await clickEpisode(h, 0);
  const video = h.get('player-video'); video.duration = 100; video.dispatch('loadedmetadata');
  assert.equal(video.currentTime, 0, 'invalid saved position must not be sought');
  const firstUrl = video.currentSrc;
  video.currentTime = 20; video.dispatch('pause');
  assert.deepEqual(Object.keys(readJSON(h, 'hg-player-progress-v1')), [`${SERIES_ID}::${EPISODES[0].id}`]);

  h.get('episode-list').children[1].dispatch('click'); await tick();
  assert.equal(h.playCalls.at(-1).episodeId, EPISODES[1].id);
  video.currentSrc = firstUrl; video.currentTime = 50; video.dispatch('timeupdate');
  const duringSwitch = readJSON(h, 'hg-player-progress-v1');
  assert.equal(duringSwitch[`${SERIES_ID}::${EPISODES[1].id}`], undefined, 'old episode time must not be assigned to the selected episode');
  release({ url: mediaUrl(EPISODES[1].id), quality: '720P', qualities: [{ key: '720P', label: '720P' }] });
  await tick();
  video.currentTime = 0; video.duration = 100; video.dispatch('loadedmetadata');
  video.currentTime = 30; video.dispatch('pause');
  const finalMap = readJSON(h, 'hg-player-progress-v1');
  assert.equal(finalMap[`${SERIES_ID}::${EPISODES[0].id}`].time, 20);
  assert.equal(finalMap[`${SERIES_ID}::${EPISODES[1].id}`].time, 30);
});

test('quality-switch loading window cannot overwrite saved position with stale media time', async () => {
  let release;
  const gate = { match: () => true, promise: new Promise((resolve) => { release = resolve; }) };
  const h = makeHarness();
  await openSeries(h); await clickEpisode(h, 0);
  const video = h.get('player-video'); video.duration = 100; video.dispatch('loadedmetadata');
  video.currentTime = 24; video.dispatch('pause');
  h.setDeferredPlay(gate);
  h.get('quality-select').value = '1080P';
  h.get('quality-select').dispatch('change'); await tick();
  const request = h.playCalls.at(-1);
  assert.equal(request.quality, '1080P');
  video.currentSrc = mediaUrl(EPISODES[0].id); video.currentTime = 70; video.dispatch('timeupdate');
  const map = readJSON(h, 'hg-player-progress-v1');
  assert.equal(map[`${SERIES_ID}::${EPISODES[0].id}`].time, 24);
  release({ url: mediaUrl(EPISODES[0].id, '1080P'), quality: '1080P', qualities: [{ key: '720P' }, { key: '1080P' }] });
  await tick();
});

test('reopening a history episode restores saved position when its new source emits loadedmetadata', async () => {
  const h = makeHarness();
  await openSeries(h); await clickEpisode(h, 0);
  const video = h.get('player-video');
  video.duration = 8; video.currentTime = 0.5; video.dispatch('loadedmetadata');
  video.currentTime = 3; video.dispatch('pause');

  h.get('close-detail').dispatch('click');
  assert.equal(video.currentSrc, '', 'closing details clears the old media source');
  h.nav.find((node) => node.dataset.view === 'recent').dispatch('click');
  h.get('list-grid').children[0].dispatch('click');
  await tick(); await tick();
  assert.equal(h.get('episode-list').children.length, EPISODES.length);
  await clickEpisode(h, 0);

  video.duration = 8; video.currentTime = 0; video.dispatch('loadedmetadata');
  assert.equal(video.currentTime, 3, 'new source metadata applies the progress saved before closing');
  assert.equal(video.playCalls, 2, 'metadata starts playback for both the original and resumed source');
  assert.equal(h.get('video-placeholder').hidden, true, 'successful metadata handling dismisses the loading placeholder');
});
