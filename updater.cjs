'use strict';

const fsDefault = require('node:fs');
const pathDefault = require('node:path');

/**
 * Create an opt-in electron-updater controller.
 *
 * Required: app (Electron app), send(plainStatusObject), getWindow() (for a parented
 * confirmation dialog). Optional injections: updater, dialog, platform,
 * resourcesPath, fs, path, isInstalled (an additional veto; never bypasses the
 * Windows/packaged/uninstaller checks), and beforeInstall (async playback cleanup).
 *
 * The packaged resources/app-update.yml is only checked for presence here;
 * electron-updater itself reads its contents. No feed URL or repository is
 * synthesized. ZIP/unpacked builds are never treated as installable.
 *
 * Returns status(), check(), download(), install(), dispose(). All action methods
 * resolve to a plain status snapshot. install() only proceeds after an explicit
 * dialog confirmation and a successful beforeInstall callback.
 */
function createUpdater(options = {}) {
  const {
    app,
    send,
    getWindow = () => null,
    updater: injectedUpdater,
    dialog: injectedDialog,
    beforeInstall = async () => {},
    platform = process.platform,
    resourcesPath = process.resourcesPath,
    fs = fsDefault,
    path = pathDefault,
    isInstalled,
  } = options;

  if (!app || typeof app !== 'object') throw new TypeError('createUpdater requires app');
  if (typeof send !== 'function') throw new TypeError('createUpdater requires send(status)');
  if (typeof getWindow !== 'function') throw new TypeError('getWindow must be a function');
  if (typeof beforeInstall !== 'function') throw new TypeError('beforeInstall must be a function');

  const snapshot = (state) => ({
    status: state.status,
    message: state.message,
    version: state.version == null ? null : state.version,
    progress: state.progress == null ? null : state.progress,
    ...(state.bytesPerSecond == null ? {} : { bytesPerSecond: state.bytesPerSecond }),
    ...(state.transferred == null ? {} : { transferred: state.transferred }),
    ...(state.total == null ? {} : { total: state.total }),
  });
  let state = { status: 'idle', message: '尚未检查更新。', version: null, progress: null };
  let disposed = false;
  let updater = injectedUpdater || null;
  let updaterInitialized = false;
  let dialog = injectedDialog || null;
  let trustedUpdateAvailable = false;
  let trustedUpdateDownloaded = false;
  let downloadCancelled = false;
  let checkPromise = null;
  let downloadPromise = null;
  let installPromise = null;
  const listeners = [];

  function publish(next, message, extra = {}) {
    state = {
      status: next,
      message,
      version: extra.version === undefined ? state.version : extra.version,
      progress: extra.progress === undefined ? null : extra.progress,
      bytesPerSecond: extra.bytesPerSecond,
      transferred: extra.transferred,
      total: extra.total,
    };
    const safe = snapshot(state);
    try { send(safe); } catch { /* UI/window teardown must not break updater state. */ }
    return safe;
  }

  function installedGate() {
    if (platform !== 'win32' || app.isPackaged !== true) return false;
    let exe;
    try { exe = app.getPath('exe'); } catch { return false; }
    if (typeof exe !== 'string' || !exe) return false;
    let uninstaller;
    try { uninstaller = path.join(path.dirname(exe), 'Uninstall Jingkan.exe'); } catch { return false; }
    try {
      if (!fs || typeof fs.existsSync !== 'function' || !fs.existsSync(uninstaller)) return false;
      // This optional hook can only reject an otherwise-valid installation.
      if (isInstalled && (typeof isInstalled !== 'function' || isInstalled(app) !== true)) return false;
    } catch { return false; }
    return true;
  }

  function configExists() {
    if (typeof resourcesPath !== 'string' || !resourcesPath) return false;
    try { return fs.existsSync(path.join(resourcesPath, 'app-update.yml')); } catch { return false; }
  }

  function gateStatus() {
    if (!installedGate()) return { status: 'unsupported', message: '在线更新仅支持 Windows NSIS 安装版。' };
    if (!configExists()) return { status: 'unconfigured', message: '此安装包未配置更新源。' };
    return null;
  }

  function gateOrPublish() {
    const blocked = gateStatus();
    if (blocked) {
      trustedUpdateAvailable = false;
      trustedUpdateDownloaded = false;
      return publish(blocked.status, blocked.message, { version: null });
    }
    return null;
  }

  function safeVersion(info) {
    const value = info && typeof info.version === 'string' ? info.version : null;
    return value && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(value) ? value : null;
  }

  function availableMessage(version) {
    return version ? `发现可用更新（版本 ${version}），可选择下载。` : '发现可用更新，可选择下载。';
  }

  function safeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  function detachListeners() {
    for (const [event, handler] of listeners.splice(0)) {
      try {
        if (typeof updater?.off === 'function') updater.off(event, handler);
        else updater?.removeListener?.(event, handler);
      } catch { /* best effort */ }
    }
  }

  function bind(event, handler) {
    if (typeof updater?.on === 'function') {
      updater.on(event, handler);
      listeners.push([event, handler]);
    }
  }

  function handleError(error) {
    if (disposed) return;
    // Never forward provider error payloads or release-notes HTML to the renderer.
    publish('error', '更新操作失败，请稍后重试。', { version: state.version });
    return error;
  }

  function getDialog() {
    if (dialog) return dialog;
    try {
      dialog = require('electron').dialog;
      return dialog;
    } catch { return null; }
  }

  function initUpdater() {
    if (updaterInitialized) return updater;
    updaterInitialized = true;
    try {
      if (!updater) {
        const electronUpdater = require('electron-updater');
        updater = electronUpdater.autoUpdater;
      }
      if (!updater) throw new Error('electron-updater autoUpdater unavailable');
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = false;
      updater.allowPrerelease = false;
      updater.allowDowngrade = false;
      bind('checking-for-update', () => {
        if (!disposed) publish('checking', '正在检查更新。', { version: null });
      });
      bind('update-available', info => {
        if (disposed) return;
        trustedUpdateAvailable = true;
        trustedUpdateDownloaded = false;
        const version = safeVersion(info);
        publish('available', availableMessage(version), { version });
      });
      bind('update-not-available', info => {
        if (disposed) return;
        trustedUpdateAvailable = false;
        trustedUpdateDownloaded = false;
        publish('not-available', '当前已是最新版本。', { version: safeVersion(info) });
      });
      bind('download-progress', progress => {
        if (disposed) return;
        const percent = safeNumber(progress?.percent);
        publish('downloading', '正在下载更新。', {
          version: state.version,
          progress: percent === undefined ? null : Math.max(0, Math.min(100, percent)),
          bytesPerSecond: safeNumber(progress?.bytesPerSecond),
          transferred: safeNumber(progress?.transferred),
          total: safeNumber(progress?.total),
        });
      });
      bind('update-downloaded', info => {
        if (disposed) return;
        trustedUpdateDownloaded = true;
        trustedUpdateAvailable = true;
        publish('downloaded', '更新已下载，安装前将请求确认并清理播放资源。', {
          version: safeVersion(info) || state.version,
        });
      });
      bind('update-cancelled', () => {
        if (disposed) return;
        downloadCancelled = true;
        trustedUpdateDownloaded = false;
        if (trustedUpdateAvailable) publish('available', '更新下载已取消，可稍后重试。', { version: state.version });
        else publish('error', '更新下载已取消。', { version: state.version });
      });
      bind('error', handleError);
      return updater;
    } catch (error) {
      detachListeners();
      updaterInitialized = false;
      handleError(error);
      return null;
    }
  }

  // Publish an initial, actionable state without attempting any network access.
  const blockedAtStart = gateStatus();
  if (blockedAtStart) publish(blockedAtStart.status, blockedAtStart.message, { version: null });

  function status() {
    return snapshot(state);
  }

  async function check() {
    if (disposed) return publish('error', '更新服务已关闭。');
    const blocked = gateOrPublish();
    if (blocked) return blocked;
    if (checkPromise) return checkPromise;
    if (state.status === 'downloading' || state.status === 'downloaded') return status();

    const service = initUpdater();
    if (!service) return status();
    trustedUpdateAvailable = false;
    trustedUpdateDownloaded = false;
    publish('checking', '正在检查更新。', { version: null });
    const running = (async () => {
      try {
        const result = await service.checkForUpdates();
        if (!disposed && state.status === 'checking') {
          const info = result && result.updateInfo;
          if (result?.isUpdateAvailable === false) {
            trustedUpdateAvailable = false;
            publish('not-available', '当前已是最新版本。', { version: safeVersion(info) });
          } else if (result?.isUpdateAvailable === true || info) {
            trustedUpdateAvailable = true;
            const version = safeVersion(info);
            publish('available', availableMessage(version), { version });
          } else {
            publish('error', '未能确认更新状态，请稍后重试。', { version: null });
          }
        }
      } catch (error) {
        if (!disposed) handleError(error);
      }
      return status();
    })();
    checkPromise = running;
    try { return await running; }
    finally { if (checkPromise === running) checkPromise = null; }
  }

  async function download() {
    if (disposed) return publish('error', '更新服务已关闭。');
    const blocked = gateOrPublish();
    if (blocked) return blocked;
    if (downloadPromise) return downloadPromise;
    if (state.status === 'downloading') return status();
    if (!trustedUpdateAvailable || trustedUpdateDownloaded || !['available', 'error'].includes(state.status)) {
      return status(); // Crucially, no download call without a trusted availability result.
    }
    const service = initUpdater();
    if (!service || typeof service.downloadUpdate !== 'function') return status();
    downloadCancelled = false;
    publish('downloading', '正在下载更新。', { version: state.version, progress: 0 });
    const running = (async () => {
      try {
        const files = await service.downloadUpdate();
        if (!disposed && !trustedUpdateDownloaded && !downloadCancelled && Array.isArray(files) &&
            files.length > 0 && files.every(file => typeof file === 'string' && file.trim().length > 0)) {
          // A non-empty path list or update-downloaded event is completion evidence.
          trustedUpdateDownloaded = true;
          publish('downloaded', '更新已下载，安装前将请求确认并清理播放资源。', { version: state.version });
        } else if (!disposed && !trustedUpdateDownloaded && !downloadCancelled) {
          publish('error', '更新未能完整下载，请稍后重试。', { version: state.version });
        }
        return status();
      } catch (error) {
        if (!disposed) handleError(error);
        return status();
      }
    })();
    downloadPromise = running;
    try { return await running; }
    finally { if (downloadPromise === running) downloadPromise = null; }
  }

  async function install() {
    if (disposed) return publish('error', '更新服务已关闭。');
    const blocked = gateOrPublish();
    if (blocked) return blocked;
    if (installPromise) return installPromise;
    if (!trustedUpdateDownloaded || !['downloaded', 'error'].includes(state.status)) return status();
    const service = initUpdater();
    if (!service || typeof service.quitAndInstall !== 'function') return status();

    const running = (async () => {
      try {
        const confirmDialog = getDialog();
        if (!confirmDialog || typeof confirmDialog.showMessageBox !== 'function') {
          return handleError(new Error('confirmation dialog unavailable')) && status();
        }
        const window = (() => { try { return getWindow(); } catch { return null; } })();
        const options = {
          type: 'question',
          title: '安装更新',
          message: state.version ? `版本 ${state.version} 已下载。现在重启并安装吗？` : '更新已下载。现在重启并安装吗？',
          detail: '继续前将先清理当前播放资源。',
          buttons: ['取消', '重启并安装'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        };
        const response = window && !(typeof window.isDestroyed === 'function' && window.isDestroyed())
          ? await confirmDialog.showMessageBox(window, options)
          : await confirmDialog.showMessageBox(options);
        if (disposed) return status();
        if (response?.response !== 1) {
          return publish('downloaded', '已取消安装；更新文件仍保留。', { version: state.version });
        }
        await beforeInstall();
        if (disposed) return status();
        publish('downloaded', '正在重启并安装更新。', { version: state.version });
        service.quitAndInstall(false, true);
        return status();
      } catch (error) {
        if (!disposed) handleError(error);
        return status();
      }
    })();
    installPromise = running;
    try { return await running; }
    finally { if (installPromise === running) installPromise = null; }
  }

  function dispose() {
    if (!disposed) {
      disposed = true;
      detachListeners();
    }
    return status();
  }

  return { status, check, download, install, dispose };
}

module.exports = { createUpdater };
