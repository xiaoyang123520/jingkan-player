(() => {
  'use strict';
  const status = document.getElementById('update-status');
  const check = document.getElementById('update-check');
  const download = document.getElementById('update-download');
  const install = document.getElementById('update-install');
  const progress = document.getElementById('update-progress');
  if (!status || !window.player || !window.player.updates) return;
  const api = window.player.updates;
  let current = {};
  function render(value) {
    current = value || {};
    const version = typeof current.version === 'string' ? `（版本 ${current.version}）` : '';
    status.textContent = (current.message || '可以检查新版本。') + version;
    const busy = ['checking', 'downloading', 'installing'].includes(current.status);
    check.disabled = busy || ['unsupported', 'unconfigured', 'downloaded'].includes(current.status);
    download.hidden = current.status !== 'available';
    install.hidden = current.status !== 'downloaded';
    download.disabled = install.disabled = busy;
    progress.hidden = current.status !== 'downloading';
    progress.value = Math.min(100, Math.max(0, Number(current.progress) || 0));
  }
  async function run(action) {
    try { render(await api[action]()); }
    catch (_) { render({ status: 'error', message: '更新操作失败，请稍后重试；当前版本仍可使用。' }); }
  }
  check.addEventListener('click', () => run('check'));
  download.addEventListener('click', () => run('download'));
  install.addEventListener('click', () => run('install'));
  const unsubscribe = api.onStatus(render);
  window.addEventListener('beforeunload', () => unsubscribe(), { once: true });
  api.status().then(value => { render(value); if (value.status === 'idle') run('check'); }).catch(() => render({ status: 'error', message: '更新服务尚未就绪。' }));
})();
