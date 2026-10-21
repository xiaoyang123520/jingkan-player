'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createSource } = require('../source');
const { createCompat } = require('../compat-video.cjs');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jingkan-offline-'));
app.setPath('appData', profile);
// The ALSA null sink drains audio faster than wall time. Use video-only media
// for state timing checks; this suite does not validate audible output.
const data = fs.readFileSync(path.join(__dirname, 'fixtures/test-video-silent.mp4'));
const SID = '123456', episodes = [{ id: '654321' }, { id: '654322' }];
const card = { id: SID, title: '离线回归样片', count: 2, tags: ['测试'] };
const provider = {
  async categoryList() { return { items: [card], totalPages: 1 }; },
  async search() { return { items: [card], totalPages: 1 }; },
  async detail() { return { ...card, episodes }; },
  async stream() { return { total: data.length, async chunk(s, e) { return data.subarray(s, e + 1); } }; },
  async qualities() { return [{ key: '720P', label: '720P' }, { key: '360P', label: '360P' }]; },
};
let runtime, cleaned = false;
const bridge = {
  configureCompat(options) { runtime = createSource(provider, { compat: createCompat({ ...options, provider }) }); },
  init: () => runtime.init(), close: async () => { await runtime.close(); cleaned = true; },
  catalog: o => runtime.catalog(o), detail: id => runtime.detail(id), play: o => runtime.play(o),
  isMediaUrl: url => runtime.isMediaUrl(url),
};
require.cache[require.resolve('../source')].exports = bridge;
const result = { version: require('../package.json').version, environment: 'Linux Electron, offline generated video-only sample; not audible output, Windows acceptance or upstream availability test', checks: [], pass: false };
const output = path.join(__dirname, 'offline-integration-result.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function save() { fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }
require('../main');
app.on('quit', () => { result.checks.push({ name: 'exit awaited local service cleanup', ok: cleaned }); result.pass = result.pass && cleaned; save(); });
async function run() {
  let w;
  for (let i = 0; i < 100; i++) { w = BrowserWindow.getAllWindows()[0]; if (w) break; await sleep(100); }
  if (!w) throw Error('No window');
  const js = code => w.webContents.executeJavaScript(code);
  const check = (name, ok) => { result.checks.push({ name, ok: Boolean(ok) }); if (!ok) throw Error(name); console.log('PASS', name); };
  async function wait(code, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { if (await js(code)) return; await sleep(100); } result.diagnostics = await js(`(()=>{const v=document.querySelector('video');return {src:v.currentSrc,paused:v.paused,time:v.currentTime,duration:v.duration,ready:v.readyState,error:v.error?.message,detailError:document.querySelector('#detail-error').textContent,placeholder:document.querySelector('#video-placeholder-text').textContent,progress:localStorage.getItem('hg-player-progress-v1'),trace:window.__mediaTrace}})()`); throw Error('Timeout: ' + code); }
  await wait("document.querySelectorAll('#catalog-grid .series-card').length===1");
  await js(`window.__mediaTrace=[];['loadedmetadata','play','playing','pause','seeking','seeked','emptied','ended','error'].forEach(name=>document.querySelector('video').addEventListener(name,()=>{const v=document.querySelector('video');window.__mediaTrace.push({event:name,at:performance.now(),time:v.currentTime,paused:v.paused,src:v.currentSrc,progress:localStorage.getItem('hg-player-progress-v1')})}))`);
  check('catalog loads through sandboxed bridge', true);
  await js("document.querySelector('#auto-next').checked=false;document.querySelector('#catalog-grid .series-card').click()");
  await wait("document.querySelectorAll('.episode-button').length===2");
  await js("document.querySelector('.episode-button').click()");
  await wait("document.querySelector('video').currentTime>0.3 && document.querySelector('video').videoWidth===320");
  check('actual compatibility conversion and video decode', await js("document.querySelector('video').currentSrc.endsWith('/720P/compat')"));
  await js("document.querySelector('video').currentTime=3;document.querySelector('video').pause()");
  await wait("document.querySelector('video').currentTime>=3");
  await js("document.querySelector('#close-detail').click();document.querySelector('[data-view=recent]').click()");
  check('history persists after closing details', await js("document.querySelectorAll('#list-grid .series-card').length===1"));
  check('progress persists', await js("JSON.parse(localStorage.getItem('hg-player-progress-v1'))['123456::654321'].time>=3"));
  await js("document.querySelector('#list-grid .series-card').click()");
  await wait("document.querySelectorAll('.episode-button').length===2");
  await js("window.__mediaTrace=[];document.querySelector('.episode-button').click()");
  await wait("window.__mediaTrace.some(e=>e.event==='loadedmetadata' && e.time>=3 && !e.paused)");
  check('resume hides loading placeholder', await js("document.querySelector('#video-placeholder').hidden"));
  check('resume from saved position', true);
  await js("window.__mediaTrace=[];document.querySelector('#quality-select').value='360P';document.querySelector('#quality-select').dispatchEvent(new Event('change'))");
  await wait("window.__mediaTrace.some(e=>e.event==='loadedmetadata' && e.src.endsWith('/360P/compat') && e.time>=3 && !e.paused)");
  check('quality switch retains position', true);
  await js("document.querySelector('#next-episode').click()");
  await wait("document.querySelector('video').currentSrc.includes('/654322/') && document.querySelector('video').currentTime>0.2");
  check('next episode is not assigned previous episode progress', await js("!JSON.parse(localStorage.getItem('hg-player-progress-v1'))['123456::654322'] || JSON.parse(localStorage.getItem('hg-player-progress-v1'))['123456::654322'].time<3"));
  await js("document.querySelector('#favorite-button').click();document.querySelector('#close-detail').click();document.querySelector('[data-view=favorites]').click()");
  check('favorites render', await js("document.querySelectorAll('#list-grid .series-card').length===1"));
  await js("localStorage.setItem('hg-player-favorites-v1',JSON.stringify([null,{},42,{id:'123456',title:'有效记录'}]));document.querySelector('[data-view=favorites]').click()");
  check('corrupt favorite records do not break list rendering', await js("document.querySelectorAll('#list-grid .series-card').length===1"));
  await js("document.querySelector('[data-view=about]').click()");
  await wait("document.querySelector('#update-check').disabled");
  check('update bridge reports unsupported on Linux development runtime', await js("window.player.updates.status().then(s=>s.status==='unsupported')"));
  check('update UI does not offer download or install on unsupported runtime', await js("document.querySelector('#update-download').hidden && document.querySelector('#update-install').hidden"));
  check('renderer stays sandboxed with update bridge', await js("typeof window.require==='undefined' && typeof window.process==='undefined' && Object.isFrozen(window.player.updates)"));
  result.pass = result.checks.every(c => c.ok);
}
app.whenReady().then(run).catch(error => { result.error = error.message; result.pass = false; console.error(error); }).finally(() => { save(); app.quit(); });
setTimeout(() => { result.error = 'offline QA outer timeout'; result.pass = false; save(); app.exit(1); }, 90000).unref();
