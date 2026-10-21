'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const fail of [false, true]) test(`main waits for cleanup once before quit (cleanup rejects=${fail})`, async () => {
  const app = new EventEmitter(); let quitCalls = 0, closeCalls = 0, finish;
  app.setName = app.setPath = () => {};
  app.getPath = () => '/tmp';
  app.requestSingleInstanceLock = () => true;
  app.whenReady = async () => {};
  app.quit = () => { quitCalls++; };
  const source = { configureCompat() {}, async init() {}, close() { closeCalls++; return new Promise((resolve, reject) => { finish = fail ? () => reject(Error('cleanup failed')) : resolve; }); } };
  class BrowserWindow extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = () => {}; }
    loadURL() {}
  }
  const electron = { app, BrowserWindow, ipcMain: { handle() {} }, Menu: { setApplicationMenu() {} }, session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {} } } }, dialog: { showErrorBox() { assert.fail('startup failed'); } } };
  const root = path.resolve(__dirname, '..');
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require(name) { if (name === 'electron') return electron; if (name === './source') return source; if (name === './updater.cjs') return { createUpdater: () => ({ dispose() {} }) }; return require(name); },
    __dirname: root, process: { platform: 'linux' },
  });
  await turn();
  let prevented = 0;
  app.emit('before-quit', { preventDefault() { prevented++; } });
  app.emit('before-quit', { preventDefault() { prevented++; } });
  await turn();
  assert.equal(prevented, 2);
  assert.equal(closeCalls, 1);
  assert.equal(quitCalls, 0);
  finish(); await turn();
  assert.equal(quitCalls, 1);
  app.emit('before-quit', { preventDefault() { assert.fail('completed cleanup must allow quit'); } });
});
