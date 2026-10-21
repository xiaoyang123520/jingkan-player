'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const turn = () => new Promise(resolve => setImmediate(resolve));

async function capturePermissionHandlers() {
  const app = new EventEmitter();
  app.setName = app.setPath = () => {};
  app.getPath = () => '/tmp';
  app.requestSingleInstanceLock = () => true;
  app.whenReady = async () => {};
  app.quit = () => {};

  let window;
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.getURL = () => entry;
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.mainFrame = {};
      this.isDestroyed = () => false;
      window = this;
    }
    loadURL() {}
  }

  let requestHandler, checkHandler;
  const defaultSession = {
    setPermissionRequestHandler(handler) { requestHandler = handler; },
    setPermissionCheckHandler(handler) { checkHandler = handler; },
    on() {},
    webRequest: { onBeforeRequest() {} },
  };
  const electron = {
    app,
    BrowserWindow,
    ipcMain: { handle() {} },
    Menu: { setApplicationMenu() {} },
    session: { defaultSession },
    shell: { openExternal() {} },
    dialog: { showErrorBox() { assert.fail('startup failed'); } },
  };
  const root = path.resolve(__dirname, '..');
  const entry = pathToFileURL(path.join(root, 'renderer/index.html')).href;
  const source = { configureCompat() {}, async init() {}, async close() {}, catalog() {}, detail() {}, play() {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require(name) {
      if (name === 'electron') return electron;
      if (name === './source') return source;
      if (name === './updater.cjs') return { createUpdater: () => ({ dispose() {}, status() {}, check() {}, download() {}, install() {} }) };
      return require(name);
    },
    __dirname: root,
    process: { platform: 'linux' },
  });
  await turn();
  assert.ok(window, 'main window should be created after startup');
  assert.equal(typeof requestHandler, 'function', 'request permission handler should be installed');
  assert.equal(typeof checkHandler, 'function', 'check permission handler should be installed');
  return { entry, contents: window.webContents, requestHandler, checkHandler };
}

test('only the trusted main frame may request or check fullscreen permission', async () => {
  const { entry, contents, requestHandler, checkHandler } = await capturePermissionHandlers();
  const otherContents = { getURL: () => entry };
  const cases = [
    { label: 'trusted main-frame fullscreen', contents, permission: 'fullscreen', details: { isMainFrame: true, requestingUrl: entry }, expected: true },
    { label: 'fullscreen without optional details', contents, permission: 'fullscreen', details: {}, expected: true },
    { label: 'other webContents', contents: otherContents, permission: 'fullscreen', details: { isMainFrame: true, requestingUrl: entry }, expected: false },
    { label: 'other current URL', contents: { getURL: () => 'file:///untrusted.html' }, permission: 'fullscreen', details: { isMainFrame: true, requestingUrl: entry }, expected: false },
    { label: 'other requesting URL', contents, permission: 'fullscreen', details: { isMainFrame: true, requestingUrl: 'https://untrusted.example/' }, expected: false },
    { label: 'subframe', contents, permission: 'fullscreen', details: { isMainFrame: false, requestingUrl: entry }, expected: false },
    ...['camera', 'microphone', 'geolocation'].map(permission => ({ label: `${permission} permission`, contents, permission, details: { isMainFrame: true, requestingUrl: entry }, expected: false })),
  ];

  for (const check of cases) {
    let callbackCalls = 0;
    let callbackResult;
    requestHandler(check.contents, check.permission, result => { callbackCalls++; callbackResult = result; }, check.details);
    assert.equal(callbackCalls, 1, `${check.label}: request callback should run once`);
    assert.equal(callbackResult, check.expected, `${check.label}: request handler`);
    assert.equal(checkHandler(check.contents, check.permission, entry, check.details), check.expected, `${check.label}: check handler`);
  }
});
