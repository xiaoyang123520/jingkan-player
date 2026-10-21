'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
test('every update IPC channel rejects foreign contents, subframes and wrong entry URLs', async () => {
  const handlers = new Map(), calls = [];
  let window;
  const app = new EventEmitter(); Object.assign(app, { setName() {}, setPath() {}, getPath: () => '/tmp', requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() {} });
  class BrowserWindow extends EventEmitter {
    constructor() { super(); window = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = { url: pathToFileURL(path.join(root, 'renderer/index.html')).href }; this.webContents.setWindowOpenHandler = () => {}; }
    loadURL() {} isDestroyed() { return false; }
  }
  const source = { configureCompat() {}, async init() {}, async close() {} };
  const updates = Object.fromEntries(['status', 'check', 'download', 'install', 'dispose'].map(name => [name, () => { calls.push(name); return { status: 'unsupported' }; }]));
  const electron = { app, BrowserWindow, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, Menu: { setApplicationMenu() {} }, session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {} } } }, dialog: { showErrorBox() { assert.fail('startup failed'); } } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), { __dirname: root, process: { platform: 'linux' }, require(name) { if (name === 'electron') return electron; if (name === './source') return source; if (name === './updater.cjs') return { createUpdater: () => updates }; return require(name); } });
  await new Promise(resolve => setImmediate(resolve));
  for (const name of ['status', 'check', 'download', 'install']) {
    const handler = handlers.get('update-' + name); assert.equal(typeof handler, 'function');
    const wc = window.webContents, frame = wc.mainFrame;
    assert.throws(() => handler({ sender: {}, senderFrame: frame }), /不可信/);
    assert.throws(() => handler({ sender: wc, senderFrame: { url: frame.url } }), /不可信/);
    const url = frame.url; frame.url = 'https://untrusted.invalid/';
    assert.throws(() => handler({ sender: wc, senderFrame: frame }), /不可信/); frame.url = url;
    assert.equal(handler({ sender: wc, senderFrame: frame }).status, 'unsupported');
  }
  assert.deepEqual(calls, ['status', 'check', 'download', 'install']);
});
test('preload exposes fixed update commands without caller-controlled payloads', async () => {
  let player; const calls = [], events = new EventEmitter();
  const ipc = { invoke: (channel, ...args) => { calls.push([channel, args]); return Promise.resolve({}); }, on: events.on.bind(events), removeListener: events.removeListener.bind(events) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { player = value; } }, ipcRenderer: ipc }) });
  assert.equal(Object.isFrozen(player.updates), true);
  for (const name of ['status', 'check', 'download', 'install']) await player.updates[name]('https://untrusted.invalid/payload.exe');
  assert.deepEqual(calls.map(([name]) => name), ['update-status', 'update-check', 'update-download', 'update-install']);
  assert.equal(calls.every(([, args]) => args.length === 0), true);
  let count = 0; const stop = player.updates.onStatus(() => count++); events.emit('update-state', {}, {}); stop(); events.emit('update-state', {}, {}); assert.equal(count, 1);
});
