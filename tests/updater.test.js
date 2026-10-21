'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater } = require('../updater.cjs');

const exePath = '/fake/install/Jingkan.exe';
const uninstallerPath = '/fake/install/Uninstall Jingkan.exe';
const updateConfigPath = '/fake/resources/app-update.yml';
const updateInfo = {
  version: '0.3.0',
  releaseNotes: '<img src=x onerror=alert(1)>remote release notes must never reach UI',
};

function fakeUpdater(overrides = {}) {
  const instance = new EventEmitter();
  instance.checkCalls = 0;
  instance.downloadCalls = 0;
  instance.installCalls = [];
  instance.checkForUpdates = async function () {
    this.checkCalls++;
    this.emit('update-available', updateInfo);
    return { isUpdateAvailable: true, updateInfo };
  };
  instance.downloadUpdate = async function () {
    this.downloadCalls++;
    this.emit('download-progress', { percent: 37.5, bytesPerSecond: 1200, transferred: 375, total: 1000 });
    this.emit('update-downloaded', updateInfo);
    return ['installer.exe'];
  };
  instance.quitAndInstall = function (...args) { this.installCalls.push(args); };
  Object.assign(instance, overrides);
  return instance;
}

function setup({ updater = fakeUpdater(), configured = true, installed = true, platform = 'win32', appPackaged = true,
  dialog, beforeInstall, isInstalled, getWindow } = {}) {
  const sent = [];
  const exists = new Set();
  if (installed) exists.add(uninstallerPath);
  if (configured) exists.add(updateConfigPath);
  const app = { isPackaged: appPackaged, getPath: name => {
    assert.equal(name, 'exe');
    return exePath;
  }, getVersion: () => '0.2.3' };
  const controller = createUpdater({
    app,
    send: state => sent.push(state),
    getWindow: getWindow || (() => null),
    updater,
    dialog,
    beforeInstall,
    platform,
    resourcesPath: '/fake/resources',
    fs: { existsSync: file => exists.has(file) },
    isInstalled,
  });
  return { controller, updater, sent, app };
}

async function makeAvailable(controller) {
  const state = await controller.check();
  assert.equal(state.status, 'available');
}

async function makeDownloaded(controller) {
  await makeAvailable(controller);
  const state = await controller.download();
  assert.equal(state.status, 'downloaded');
}

test('manual update flow publishes safe status/progress and sets electron-updater safety flags', async () => {
  const updater = fakeUpdater();
  const { controller, sent } = setup({ updater });

  assert.equal(controller.status().status, 'idle');
  const checked = await controller.check();
  assert.equal(checked.status, 'available');
  assert.equal(checked.version, '0.3.0');
  assert.match(checked.message, /0\.3\.0/);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.downloadCalls, 0, 'checking must not trigger download');

  const downloaded = await controller.download();
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(updater.downloadCalls, 1);
  assert.ok(sent.some(state => state.status === 'downloading' && state.progress === 37.5));
  for (const state of sent) {
    assert.equal(Object.getPrototypeOf(state), Object.prototype);
    assert.equal(Object.hasOwn(state, 'releaseNotes'), false);
    assert.equal(JSON.stringify(state).includes('onerror'), false);
  }
  controller.dispose();
  assert.equal(updater.listenerCount('update-available'), 0);
});

test('download cannot start before a trusted update-available/check result', async () => {
  const updater = fakeUpdater();
  const { controller } = setup({ updater });
  const initial = await controller.download();
  assert.equal(initial.status, 'idle');
  assert.equal(updater.downloadCalls, 0);
  controller.dispose();
});

test('check errors are recoverable and a later explicit retry can discover an update', async () => {
  const updater = fakeUpdater();
  updater.checkForUpdates = async function () {
    this.checkCalls++;
    if (this.checkCalls === 1) throw new Error('<html>private provider response</html>');
    this.emit('update-available', updateInfo);
    return { isUpdateAvailable: true, updateInfo };
  };
  const { controller, sent } = setup({ updater });

  assert.equal((await controller.check()).status, 'error');
  assert.equal((await controller.check()).status, 'available');
  assert.equal(updater.checkCalls, 2);
  assert.equal(sent.some(state => JSON.stringify(state).includes('private provider response')), false);
  controller.dispose();
});

test('updater setup failure clears partial listeners and a later check retries initialization', async () => {
  const updater = fakeUpdater();
  const originalOn = updater.on.bind(updater);
  let failFirstSubscription = true;
  updater.on = (event, handler) => {
    if (failFirstSubscription) {
      failFirstSubscription = false;
      throw new Error('temporary event setup failure');
    }
    return originalOn(event, handler);
  };
  const { controller } = setup({ updater });

  assert.equal((await controller.check()).status, 'error');
  assert.equal(updater.listenerCount('update-available'), 0);
  assert.equal((await controller.check()).status, 'available');
  assert.equal(updater.checkCalls, 1);
  assert.equal(updater.listenerCount('update-available'), 1);
  controller.dispose();
});

test('concurrent checks share one in-flight request', async () => {
  let finishCheck;
  const updater = fakeUpdater();
  updater.checkForUpdates = function () {
    this.checkCalls++;
    return new Promise(resolve => { finishCheck = resolve; });
  };
  const { controller } = setup({ updater });

  const first = controller.check();
  const second = controller.check();
  assert.equal(updater.checkCalls, 1);
  updater.emit('update-available', updateInfo);
  finishCheck({ isUpdateAvailable: true, updateInfo });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'available');
  assert.equal(b.status, 'available');
  assert.equal(updater.checkCalls, 1);
  controller.dispose();
});

test('non-Windows, unpackaged, or missing-uninstaller builds are unsupported', async t => {
  for (const variant of [
    { name: 'non-Windows', platform: 'linux' },
    { name: 'unpackaged', appPackaged: false },
    { name: 'missing NSIS uninstaller', installed: false },
  ]) {
    await t.test(variant.name, async () => {
      const updater = fakeUpdater();
      const { controller } = setup({ ...variant, updater });
      assert.equal(controller.status().status, 'unsupported');
      assert.equal((await controller.check()).status, 'unsupported');
      assert.equal(updater.checkCalls, 0);
      controller.dispose();
    });
  }
});

test('absence of resources/app-update.yml is unconfigured and never checks a made-up feed', async () => {
  const updater = fakeUpdater();
  const { controller } = setup({ updater, configured: false });
  assert.equal(controller.status().status, 'unconfigured');
  assert.equal((await controller.check()).status, 'unconfigured');
  assert.equal(updater.checkCalls, 0);
  controller.dispose();
});

test('empty and cancelled download results are not installable, while an explicit retry can complete', async () => {
  const updater = fakeUpdater();
  let attempt = 0;
  updater.downloadUpdate = async function () {
    this.downloadCalls++;
    attempt++;
    if (attempt === 1) return [];
    if (attempt === 2) {
      this.emit('update-cancelled', updateInfo);
      return [];
    }
    this.emit('update-downloaded', updateInfo);
    return [];
  };
  const { controller } = setup({ updater, dialog: { showMessageBox: async () => ({ response: 1 }) } });
  await makeAvailable(controller);

  assert.equal((await controller.download()).status, 'error');
  assert.equal((await controller.install()).status, 'error');
  assert.equal((await controller.download()).status, 'available');
  assert.equal((await controller.install()).status, 'available');
  assert.equal((await controller.download()).status, 'downloaded');
  assert.equal(updater.downloadCalls, 3);
  controller.dispose();
});

test('install cancellation preserves downloaded state and skips cleanup/restart', async () => {
  let cleanupCalls = 0;
  const updater = fakeUpdater();
  const dialog = { showMessageBox: async options => {
    assert.deepEqual(options.buttons, ['取消', '重启并安装']);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.equal(options.detail.includes('播放资源'), true);
    return { response: 0 };
  } };
  const { controller } = setup({ updater, dialog, beforeInstall: async () => { cleanupCalls++; } });
  await makeDownloaded(controller);

  const result = await controller.install();
  assert.equal(result.status, 'downloaded');
  assert.equal(cleanupCalls, 0);
  assert.deepEqual(updater.installCalls, []);
  controller.dispose();
});

test('confirmed installation awaits playback cleanup before quitAndInstall', async () => {
  const order = [];
  const updater = fakeUpdater();
  const window = { isDestroyed: () => false };
  const dialog = { showMessageBox: async (parent, options) => {
    assert.equal(parent, window);
    assert.match(options.message, /0\.3\.0/);
    order.push('confirmed');
    return { response: 1 };
  } };
  const { controller } = setup({
    updater,
    dialog,
    getWindow: () => window,
    beforeInstall: async () => { order.push('cleanup-start'); await Promise.resolve(); order.push('cleanup-done'); },
  });
  await makeDownloaded(controller);

  const result = await controller.install();
  assert.equal(result.status, 'downloaded');
  assert.deepEqual(order, ['confirmed', 'cleanup-start', 'cleanup-done']);
  assert.deepEqual(updater.installCalls, [[false, true]]);
  controller.dispose();
});

test('failed playback cleanup is recoverable and never installs until a retry succeeds', async () => {
  let cleanupCalls = 0;
  const updater = fakeUpdater();
  const dialog = { showMessageBox: async () => ({ response: 1 }) };
  const { controller } = setup({
    updater,
    dialog,
    beforeInstall: async () => {
      cleanupCalls++;
      if (cleanupCalls === 1) throw new Error('temporary cleanup failure');
    },
  });
  await makeDownloaded(controller);

  assert.equal((await controller.install()).status, 'error');
  assert.deepEqual(updater.installCalls, []);
  assert.equal((await controller.install()).status, 'downloaded');
  assert.equal(cleanupCalls, 2);
  assert.deepEqual(updater.installCalls, [[false, true]]);
  controller.dispose();
});

test('dispose during confirmation or cleanup prevents later install side effects', async t => {
  await t.test('confirmation is still pending', async () => {
    let finishDialog;
    let cleanupCalls = 0;
    const updater = fakeUpdater();
    const dialog = { showMessageBox: () => new Promise(resolve => { finishDialog = resolve; }) };
    const { controller } = setup({ updater, dialog, beforeInstall: async () => { cleanupCalls++; } });
    await makeDownloaded(controller);

    const installing = controller.install();
    await new Promise(resolve => setImmediate(resolve));
    controller.dispose();
    finishDialog({ response: 1 });
    await installing;
    assert.equal(cleanupCalls, 0);
    assert.deepEqual(updater.installCalls, []);
  });

  await t.test('cleanup is still pending', async () => {
    let finishCleanup;
    const updater = fakeUpdater();
    const dialog = { showMessageBox: async () => ({ response: 1 }) };
    const { controller } = setup({
      updater,
      dialog,
      beforeInstall: () => new Promise(resolve => { finishCleanup = resolve; }),
    });
    await makeDownloaded(controller);

    const installing = controller.install();
    await new Promise(resolve => setImmediate(resolve));
    controller.dispose();
    finishCleanup();
    await installing;
    assert.deepEqual(updater.installCalls, []);
  });
});
