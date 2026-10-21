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
    this.classList = new FakeClassList(); this.dataset = {}; this.attributes = {}; this.hidden = false; this.isConnected = true; this.tabIndex = -1; this.inert = false;
    this.disabled = false; this.checked = false; this.value = ''; this.textContent = '';
    this.currentTime = 0; this.duration = NaN; this.playbackRate = 1; this.currentSrc = ''; this.playCalls = 0;
    this._src = ''; this.parentNode = null; this.ownerDocument = null;
  }
  get options() { return this.children.filter((node) => node.tagName === 'OPTION'); }
  set src(value) { this._src = String(value); this.currentSrc = this._src; }
  get src() { return this._src; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  get parentElement() { return this.parentNode && this.parentNode.tagName ? this.parentNode : null; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; this.focusCalls = (this.focusCalls || 0) + 1; }
  querySelectorAll() {
    const found = [];
    const visit = (node) => node.children.forEach((child) => { if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(child.tagName) || child.attributes.tabindex != null) found.push(child); visit(child); });
    visit(this); return found;
  }
  dispatch(type, event = {}) {
    const e = { target: this, preventDefault() {}, ...event };
    for (const callback of this.listeners[type] || []) callback(e);
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; child.isConnected = this.isConnected; return child; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  insertBefore(child, before) { const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); child.parentNode = this; return child; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((node) => node !== this); this.parentNode = null; this.isConnected = false; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'src') { this._src = ''; this.currentSrc = ''; } }
  pause() { this.dispatch('pause'); }
  load() {}
  play() { this.playCalls++; return Promise.resolve(); }
  scrollIntoView() {}
}

function makeHarness({ storage = {}, deferredPlay = null } = {}) {
  const nodes = new Map();
  const tags = { 'player-video': 'video', 'quick-open-input': 'input', 'title-filter': 'input', 'close-detail': 'button', 'fullscreen-button': 'button', 'favorite-button': 'button', 'retry-detail': 'button', 'retry-play': 'button', 'previous-episode': 'button', 'next-episode': 'button', 'quality-select': 'select', 'playback-rate': 'select', 'quick-open-form': 'form' };
  const get = (id) => {
    if (!nodes.has(id)) { const node = new FakeElement(tags[id] || 'div', id); node.ownerDocument = document; node.tabIndex = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(node.tagName) ? 0 : -1; node.hidden = ['detail-backdrop', 'detail-error', 'retry-detail', 'global-error', 'catalog-empty', 'list-view', 'list-empty', 'about-view', 'catalog-status'].includes(id); nodes.set(id, node); }
    return nodes.get(id);
  };
  const nav = ['favorites', 'recent'].map((view) => { const node = new FakeElement('button'); node.dataset.view = view; return node; });
  const body = new FakeElement('body'); body.classList = new FakeClassList();
  const document = {
    body, activeElement: body,
    getElementById: get,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ textContent: String(text), parentNode: null }),
    querySelectorAll(selector) { return selector === '.nav-item' ? nav : []; },
    querySelector(selector) { return selector === '.catalog-section' ? new FakeElement('section') : null; },
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    dispatch(type, event = {}) { const e = { preventDefault() {}, ...event }; for (const fn of this.listeners[type] || []) fn(e); return e; },
  };
  const append = (parent, ...ids) => ids.forEach((id) => parent.appendChild(get(id)));
  const app = new FakeElement('div', 'app-shell'); app.ownerDocument = document; body.appendChild(app);
  const quickForm = get('quick-open-form'); app.appendChild(quickForm); quickForm.appendChild(get('quick-open-input'));
  const backdrop = get('detail-backdrop'), dialog = get('detail-dialog'), layout = new FakeElement('div'); layout.ownerDocument = document;
  const playerColumn = new FakeElement('div'); playerColumn.ownerDocument = document; const detailInfo = new FakeElement('div'); detailInfo.ownerDocument = document;
  const frame = get('video-frame'), toolbar = new FakeElement('div'); toolbar.ownerDocument = document;
  append(body, 'detail-backdrop'); backdrop.appendChild(dialog); dialog.appendChild(get('close-detail')); dialog.appendChild(layout); layout.appendChild(playerColumn); layout.appendChild(detailInfo);
  playerColumn.appendChild(frame); append(frame, 'player-video', 'fullscreen-button'); playerColumn.appendChild(toolbar);
  append(toolbar, 'previous-episode', 'next-episode', 'quality-select', 'retry-play', 'playback-rate', 'retry-detail', 'detail-error');
  append(detailInfo, 'favorite-button', 'episode-list');
  const store = new Map(Object.entries(storage)); let storageWrites = 0;
  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { storageWrites++; store.set(key, String(value)); },
  };
  const playCalls = [];
  let activeDeferredPlay = deferredPlay;
  let activeDetail = null;
  let progressListener = null;
  const player = {
    async catalog() { return { items: [], page: 1, totalPages: 1 }; },
    async detail(id) { if (activeDetail) return activeDetail(id); return { id, title: '测试剧', intro: '', cover: '', tags: [], episodes: EPISODES }; },
    async play(request) {
      playCalls.push(request);
      if (activeDeferredPlay && activeDeferredPlay.match(request)) return activeDeferredPlay.promise;
      return { url: mediaUrl(request.episodeId), quality: '720P', qualities: [{ key: '720P', label: '720P' }, { key: '1080P', label: '1080P' }] };
    },
    onProgress(callback) { progressListener = callback; },
  };
  const window = { player, clearInterval() {}, setInterval() { return 1; }, clearTimeout() {}, setTimeout() { return 1; } };
  vm.runInNewContext(APP, { window, document, localStorage, URL, Date, Number, String, Array, Object, Math, JSON, Promise, Error, RegExp, setTimeout, clearTimeout });
  return { get, store, playCalls, nav, document, get storageWrites() { return storageWrites; }, emitProgress(status) { progressListener?.(status); }, setDeferredPlay(value) { activeDeferredPlay = value; }, setDetail(value) { activeDetail = value; } };
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

test('repeated timeupdate events within one ten-second checkpoint do not repeatedly write playback progress', async () => {
  const h = makeHarness();
  await openSeries(h); await clickEpisode(h, 0);
  const video = h.get('player-video'); video.duration = 100; video.dispatch('loadedmetadata');
  const before = h.storageWrites;
  video.currentTime = 12; video.dispatch('timeupdate'); video.dispatch('timeupdate');
  assert.equal(h.storageWrites - before, 1, 'duplicate browser timeupdate events in the same checkpoint should persist once');
  video.currentTime = 13.5; video.dispatch('timeupdate');
  assert.equal(h.storageWrites - before, 1, 'progress in the same checkpoint must not trigger another synchronous storage write');
  video.currentTime = 21; video.dispatch('timeupdate');
  assert.equal(h.storageWrites - before, 2, 'a later checkpoint still persists newer playback progress');
});

test('compatibility progress describes pipelined download and conversion without changing legacy wording', async () => {
  const h = makeHarness(); await openSeries(h);
  h.get('compat-mode').checked = true;
  h.get('episode-list').children[0].dispatch('click');
  assert.match(h.get('video-placeholder-text').textContent, /首次载入需要下载和转换/);
  h.emitProgress({ episodeId: EPISODES[0].id, quality: '720P', stage: 'download', percent: 37, pipelined: true });
  assert.match(h.get('video-placeholder-text').textContent, /下载并同步转换 37%/);
  h.emitProgress({ episodeId: EPISODES[0].id, quality: '720P', stage: 'convert', elapsedSeconds: 12, pipelined: true });
  assert.match(h.get('video-placeholder-text').textContent, /下载并转换兼容视频/);
  h.emitProgress({ episodeId: EPISODES[0].id, quality: '720P', stage: 'download', percent: 37, pipelined: false });
  assert.match(h.get('video-placeholder-text').textContent, /缓存视频 37%/);
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

test('detail failures expose a dedicated retry that clears on success and traps focus until connected restoration', async () => {
  const h = makeHarness(); let calls = 0;
  h.setDetail(async (id) => {
    calls++;
    if (calls === 1) throw Error('detail temporarily unavailable');
    return { id, title: '重试成功', intro: '', tags: [], episodes: EPISODES };
  });
  const opener = h.get('quick-open-input'); opener.focus(); opener.value = SERIES_ID;
  h.get('quick-open-form').dispatch('submit'); await tick();
  assert.equal(h.document.activeElement, h.get('close-detail'), 'opening moves focus to the close button');
  assert.equal(h.get('retry-detail').hidden, false, 'a detail failure exposes its own retry control');
  assert.match(h.get('video-placeholder-text').textContent, /详情加载失败/);

  const dialog = h.get('detail-dialog'), tabbables = dialog.querySelectorAll();
  const first = tabbables[0], last = tabbables.at(-1);
  assert.equal(first, h.get('close-detail'));
  let event = h.document.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() { this.prevented = true; } });
  assert.equal(event.prevented, true);
  assert.equal(h.document.activeElement, last, 'Shift+Tab from the first dialog control wraps to the last');
  event = h.document.dispatch('keydown', { key: 'Tab', preventDefault() { this.prevented = true; } });
  assert.equal(event.prevented, true);
  assert.equal(h.document.activeElement, first, 'Tab from the last dialog control wraps to the first');

  h.get('retry-detail').dispatch('click'); await tick();
  assert.equal(calls, 2);
  assert.equal(h.get('retry-detail').hidden, true, 'successful detail loads clear and hide the retry');
  assert.equal(h.get('detail-title').textContent, '重试成功');
  h.get('close-detail').dispatch('click');
  assert.equal(h.document.activeElement, opener, 'closing restores focus to the connected opener');
  assert.equal(h.get('retry-detail').hidden, true);

  opener.focus(); h.get('quick-open-form').dispatch('submit'); await tick();
  opener.remove(); h.get('close-detail').dispatch('click');
  assert.notEqual(h.document.activeElement, opener, 'a disconnected opener is not refocused');
});

test('stale detail failures cannot replace a newer detail state or reveal its retry button', async () => {
  const h = makeHarness(); let rejectOld, calls = 0;
  h.setDetail((id) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => { rejectOld = reject; });
    return Promise.resolve({ id, title: '较新的剧集', intro: '', tags: [], episodes: EPISODES });
  });
  const input = h.get('quick-open-input'); input.value = '111111'; h.get('quick-open-form').dispatch('submit'); await tick();
  input.value = '222222'; h.get('quick-open-form').dispatch('submit'); await tick();
  assert.equal(h.get('detail-title').textContent, '较新的剧集');
  assert.equal(h.get('retry-detail').hidden, true);
  rejectOld(Error('旧请求失败')); await tick();
  assert.equal(h.get('detail-title').textContent, '较新的剧集');
  assert.equal(h.get('retry-detail').hidden, true, 'the stale rejection cannot reveal a retry for a different series');
});


test('independent fullscreen button toggles container, accessible labels and external exits', async () => {
  const h = makeHarness(); await openSeries(h);
  const d = h.document, frame = h.get('video-frame'), button = h.get('fullscreen-button');
  frame.requestFullscreen = async () => { d.fullscreenElement = frame; d.dispatch('fullscreenchange'); };
  d.exitFullscreen = async () => { d.fullscreenElement = null; d.dispatch('fullscreenchange'); };
  button.dispatch('click'); await tick();
  assert.equal(d.fullscreenElement, frame);
  assert.equal(button.textContent, '退出全屏');
  assert.equal(button.attributes['aria-pressed'], 'true');
  button.dispatch('click'); await tick();
  assert.equal(d.fullscreenElement, null);
  assert.equal(button.textContent, '全屏');
  assert.equal(button.attributes['aria-label'], '进入全屏');
  button.dispatch('click'); await tick();
  await d.exitFullscreen();
  assert.equal(button.textContent, '全屏', 'external exits synchronize the button');
});

test('fullscreen rejection is visible and the button can be retried', async () => {
  const h = makeHarness(); await openSeries(h);
  let calls = 0;
  h.get('video-frame').requestFullscreen = async () => { calls++; throw Error('denied'); };
  const button = h.get('fullscreen-button');
  button.dispatch('click'); await tick();
  assert.match(h.get('toast').textContent, /无法切换全屏/);
  assert.equal(button.attributes['aria-pressed'], 'false');
  button.dispatch('click'); await tick();
  assert.equal(calls, 2);
  assert.equal(h.get('detail-backdrop').hidden, false);
});

test('Escape leaves fullscreen without closing details and close explicitly leaves fullscreen', async () => {
  const h = makeHarness(); await openSeries(h);
  const d = h.document, frame = h.get('video-frame'); let exits = 0;
  d.fullscreenElement = frame;
  d.exitFullscreen = async () => { exits++; d.fullscreenElement = null; d.dispatch('fullscreenchange'); };
  d.dispatch('keydown', { key: 'Escape' }); await tick();
  assert.equal(exits, 1);
  assert.equal(h.get('detail-backdrop').hidden, false);
  d.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.get('detail-backdrop').hidden, false, 'same Escape delivery must not close dialog');
  d.fullscreenElement = frame;
  h.get('close-detail').dispatch('click'); await tick();
  assert.equal(exits, 2);
  assert.equal(h.get('detail-backdrop').hidden, true);
});

test('Tab remains inside the fullscreen element while fullscreen is active', async () => {
  const h = makeHarness(); await openSeries(h);
  const frame = h.get('video-frame'); h.document.fullscreenElement = frame;
  h.get('quick-open-input').focus();
  const event = h.document.dispatch('keydown', { key: 'Tab', preventDefault() { this.prevented = true; } });
  assert.equal(event.prevented, true);
  assert.equal(h.document.activeElement, h.get('fullscreen-button'), 'focus outside the fullscreen subtree moves into it');
});

test('repeated clicks cannot race a pending fullscreen transition', async () => {
  const h = makeHarness(); await openSeries(h);
  let release, calls = 0;
  h.get('video-frame').requestFullscreen = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  h.get('fullscreen-button').dispatch('click');
  h.get('fullscreen-button').dispatch('click');
  assert.equal(calls, 1);
  release(); await tick();
  h.get('fullscreen-button').dispatch('click');
  assert.equal(calls, 2); release(); await tick();
});

test('closing fullscreen waits for browser exit before restoring opener focus', async () => {
  const h = makeHarness();
  const opener = h.get('quick-open-input'); opener.focus();
  await openSeries(h);
  const d = h.document; d.fullscreenElement = h.get('video-frame');
  let completeExit;
  d.exitFullscreen = () => new Promise(resolve => {
    completeExit = () => { d.fullscreenElement = null; h.get('fullscreen-button').focus(); d.dispatch('fullscreenchange'); resolve(); };
  });
  h.get('close-detail').dispatch('click');
  assert.equal(h.get('detail-backdrop').hidden, true);
  assert.notEqual(d.activeElement, opener, 'do not restore focus before browser finishes exiting');
  completeExit(); await tick();
  assert.equal(d.activeElement, opener, 'restore focus after browser has applied its own fullscreen focus');
});
