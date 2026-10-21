'use strict';
const { app, BrowserWindow, ipcMain, session, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const source = require('./source');
const { createUpdater } = require('./updater.cjs');
const ENTRY = pathToFileURL(path.join(__dirname, 'renderer/index.html')).href;
app.setName('净看');
// Keep the old profile directory so favorites and playback progress survive upgrades.
app.setPath('userData', path.join(app.getPath('appData'), 'JingkanPublicPlayer'));
let win, updates;
let quitting = false, cleanupStarted = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    source.configureCompat({ffmpegPath: process.platform === 'win32' ? path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname,'tools'),'ffmpeg','ffmpeg.exe') : '/usr/bin/ffmpeg', cacheDir:path.join(app.getPath('userData'),'video-cache'), onProgress: status => {
      if (win && !win.isDestroyed()) win.webContents.send('playback-progress', status);
    }});
    await source.init();
    session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', e => e.preventDefault());
    const rendererRoot=pathToFileURL(path.join(__dirname,'renderer')+path.sep).href;
    session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
      let allowed = false;
      try {
        const u = new URL(details.url);
        allowed = details.url.startsWith(rendererRoot) ||
          (details.resourceType === 'media' && source.isMediaUrl(details.url)) ||
          (details.resourceType === 'image' && u.protocol === 'https:' && !u.username && !u.password && /(?:^|\.)(?:byteimg\.com|douyinpic\.com|fqnovelpic\.com)$/.test(u.hostname));
      } catch {}
      cb({ cancel: !allowed });
    });
    function handle(channel, fn) {
      ipcMain.handle(channel, (event, arg) => {
        if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== ENTRY) throw new Error('不可信调用来源');
        return fn(arg);
      });
    }
    handle('catalog', source.catalog); handle('detail', source.detail); handle('play', source.play);
    updates = createUpdater({
      app, getWindow: () => win,
      send: state => { if (win && !win.isDestroyed()) win.webContents.send('update-state', state); },
      beforeInstall: async () => { await source.close(); quitting = true; }
    });
    handle('update-status', () => updates.status());
    handle('update-check', () => updates.check());
    handle('update-download', () => updates.download());
    handle('update-install', () => updates.install());
    handle('external', async raw => {
      if (typeof raw !== 'string' || raw.length > 2048) throw new Error('链接无效');
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.username || u.password || !['hongguoduanju.com', 'apps.microsoft.com'].includes(u.hostname)) throw new Error('仅允许打开官方网页');
      await shell.openExternal(u.href);
    });
    win = new BrowserWindow({ width: 1240, height: 840, minWidth: 880, minHeight: 600, backgroundColor: '#101115', title: '净看 0.2.4 · 独立播放器',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.webContents.on('will-attach-webview', e => e.preventDefault());
    win.loadURL(ENTRY);
    win.on('closed', () => { win = null; });
  }).catch(() => { require('electron').dialog.showErrorBox('净看启动失败','本地播放服务未能启动，请关闭程序后重试。'); app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    if (updates) updates.dispose();
    Promise.resolve().then(() => source.close()).catch(() => {}).finally(() => {
      quitting = true;
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
