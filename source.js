'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const CATEGORIES = new Set(['real-drama', 'comic-drama', 'ai-drama']);
const ID = /^\d{6,30}$/;
const QUALITY = /^(auto|(?:360|480|540|576|720|1080|1440|2160)P)$/;
const PLAYBACK_ERRORS = Object.freeze({
  SOURCE_UNAVAILABLE: '片源暂不可用，请重试或切换画质。',
  DOWNLOAD_FAILED: '视频获取失败，请稍后重试或切换画质。',
  CONVERT_UNAVAILABLE: '兼容转换组件无法启动，请重新完整解压程序，并检查 ffmpeg.exe 是否被拦截。',
  CONVERT_TIMEOUT: '视频转换超过10分钟，请降低画质或关闭兼容模式后重试。',
  CONVERT_FAILED: '视频转换失败，请重试或切换画质。',
  CACHE_FAILED: '无法写入视频缓存，请检查磁盘剩余空间和目录写入权限。',
  INPUT_TOO_LARGE: '视频文件过大，无法使用当前播放方式。',
  CANCELLED: '播放已取消，请重新尝试。',
});
function playbackErrorMessage(error) {
  const code = error && typeof error.playbackCode === 'string' ? error.playbackCode : '';
  return Object.hasOwn(PLAYBACK_ERRORS, code)
    ? PLAYBACK_ERRORS[code]
    : '片源暂不可用，请稍后重试或切换画质';
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw new Error('剧集编号无效'); return value; }
function byteRange(value, total) {
  if (!value) return [0, total - 1];
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2]) || (!m[1] && Number(m[2]) === 0)) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < total ? [start, end] : null;
}
function normalizeCard(row) {
  return { ...row, count: Number(row.count || String(row.badge || '').match(/\d+/)?.[0]) || 0,
    tags: Array.isArray(row.tags) ? row.tags : String(row.tags || '').split('/').filter(Boolean).slice(0, 5) };
}
function createSource(provider, {compat} = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  let server, base = '', starting, activeStreams = 0;
  const allowed = new Map(), pending = new Map();
  let waitingPlay = null, playSequence = 0;
  function newLifetime() {
    let cancel;
    const signal = new Promise(resolve => { cancel = resolve; });
    return { closed: false, signal, cancel };
  }
  let lifetime = newLifetime(), closing;
  const cancelled = () => Object.assign(new Error('cancelled'), { playbackCode: 'CANCELLED' });
  function checkLifetime(current) { if (current.closed) throw cancelled(); }
  async function openStream(eid, fresh, quality) {
    const current = lifetime;
    for (let attempt = 0; attempt < 3; attempt++) {
      checkLifetime(current);
      try { return await provider.stream(eid, fresh, quality); }
      catch (error) { if (attempt === 2) throw error; }
    }
  }
  function isMediaUrl(raw) {
    try { const u = new URL(raw); return Boolean(base) && u.origin === base && !u.search && !u.hash && !u.username && !u.password && new RegExp(`^/media/${token}/\\d{6,30}/\\d{6,30}/(?:auto|(?:360|480|540|576|720|1080|1440|2160)P)(?:/compat)?$`).test(u.pathname); } catch { return false; }
  }
  async function init() {
    if (closing) await closing;
    if (lifetime.closed) lifetime = newLifetime();
    if (base) return;
    if (starting) return starting;
    const current = lifetime;
    starting = new Promise((resolve, reject) => {
      server = http.createServer(async (req, res) => {
        const fail = (code, message) => { if (res.headersSent) { res.destroy(); return; } res.writeHead(code, { 'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-store' }); res.end(message); };
        if (!['GET', 'HEAD'].includes(req.method)) return fail(405, '不支持的请求');
        if (req.headers.host !== new URL(base).host) return fail(403, '非法主机');
        if (!isMediaUrl(base + req.url)) return fail(403, '播放会话无效');
        const [, , , sid, eid, quality, mode] = new URL(base + req.url).pathname.split('/');
        const registered = allowed.get(sid);
        if (!registered?.episodes.has(eid)) return fail(403, '播放会话无效，请重新打开剧集');
        if (activeStreams >= 4) return fail(503, '播放请求过多，请稍后重试');
        activeStreams++;
        let compatStream;
        try {
          // Revalidate membership after a long pause instead of expiring an
          // otherwise valid local media URL in the middle of playback.
          if (Date.now() - registered.at > 3600000) {
            await detail(sid);
            if (!allowed.get(sid)?.episodes.has(eid)) return fail(403, '分集已不可用，请重新打开剧集');
          }
          const stream = mode === 'compat' && compat
            ? (compatStream = await compat.prepare(eid, quality, false, true))
            : await openStream(eid, false, quality);
          if (res.destroyed) return;
          if (!stream || !Number.isSafeInteger(stream.total) || stream.total <= 0 || typeof stream.chunk !== 'function') {
            throw Object.assign(new Error('invalid stream'), { playbackCode: 'SOURCE_UNAVAILABLE' });
          }
          const readChunk = async (start, end) => {
            for (let attempt = 0; attempt < 3; attempt++) {
              if (res.destroyed) throw Object.assign(new Error('cancelled'), { playbackCode: 'CANCELLED' });
              try {
                const chunk = Buffer.from(await stream.chunk(start, end));
                if (chunk.length !== end - start + 1) throw new Error('short read');
                return chunk;
              } catch (error) {
                if (res.destroyed || attempt === 2) throw Object.assign(new Error('range unavailable'), { playbackCode: 'DOWNLOAD_FAILED' });
              }
            }
          };
          const range = byteRange(req.headers.range, stream.total);
          if (!range) { res.writeHead(416, { 'Content-Range':`bytes */${stream.total}` }); return res.end(); }
          const [start, end] = range;
          const headers = { 'Content-Type':'video/mp4', 'Accept-Ranges':'bytes', 'Content-Length':end-start+1, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' };
          if (req.headers.range) headers['Content-Range'] = `bytes ${start}-${end}/${stream.total}`;
          const size = 1024*1024;
          const first = req.method === 'HEAD' ? null : await readChunk(start, Math.min(start+size-1,end));
          if (res.destroyed) return;
          res.writeHead(req.headers.range ? 206 : 200, headers);
          if (req.method === 'HEAD') return res.end();
          for (let offset=start; offset<=end && !res.destroyed; offset+=size) {
            const chunk=offset===start ? first : await readChunk(offset,Math.min(offset+size-1,end));
            if (res.destroyed) break;
            if (!res.write(chunk)) await new Promise(resolve => {
              const done=()=>{ res.off('drain',done); res.off('close',done); resolve(); };
              res.once('drain',done); res.once('close',done);
            });
          }
          res.end();
        } catch (error) { fail(502,playbackErrorMessage(error)); }
        finally { compatStream?.release?.(); activeStreams--; }
      });
      server.requestTimeout=120000; server.headersTimeout=15000;
      server.once('error', reject);
      const listeningServer = server;
      server.listen(0,'127.0.0.1',()=>{
        if (current.closed) { listeningServer.close(); reject(cancelled()); return; }
        base=`http://127.0.0.1:${listeningServer.address().port}`; resolve();
      });
    });
    starting = Promise.race([starting, current.signal.then(() => { throw cancelled(); })]);
    try { await starting; } catch (e) { starting=null; throw e; }
  }
  async function catalog(options = {}) {
    if (!options || typeof options !== 'object') throw new Error('目录参数无效');
    const category=options.category || 'real-drama', page=Number(options.page ?? 1);
    if (!CATEGORIES.has(category) || !Number.isSafeInteger(page) || page<1 || page>10000) throw new Error('目录参数无效');
    const keyword=String(options.keyword || '').trim();
    if (keyword.length>80) throw new Error('搜索关键词不能超过80字');
    const data=keyword ? await provider.search(keyword,page) : await provider.categoryList(category,'',page);
    const items=Array.from(data.items || [], normalizeCard);
    return { items, page, totalPages: Math.max(page, Number(data.totalPages || data.pagination?.totalPages) || (items.length ? page+1 : page)) };
  }
  async function detail(seriesId) {
    id(seriesId);
    const current = lifetime;
    const raw=await provider.detail(seriesId);
    checkLifetime(current);
    const episodes=Array.from(raw.episodes || []).slice(0,2000).map((e,i)=>({id:id(String(e.id)),index:i+1,available:true}));
    if (!episodes.length) throw new Error('暂无可尝试播放的分集，请稍后重试');
    allowed.delete(seriesId); allowed.set(seriesId,{episodes:new Set(episodes.map(e=>e.id)),at:Date.now()});
    while(allowed.size>100) allowed.delete(allowed.keys().next().value);
    const card=normalizeCard(raw);
    return {...card,id:seriesId,intro:raw.description || raw.intro || '',accessible:true,episodes};
  }
  async function play(options = {}) {
    if (lifetime.closed) throw new Error(PLAYBACK_ERRORS.CANCELLED);
    if (!options || typeof options !== 'object') throw new Error('播放参数无效');
    const current = lifetime;
    const sid=id(options.seriesId), eid=id(options.episodeId), compatible=options.compat===true, quality=compatible && (!options.quality || options.quality === 'auto') ? '720P' : options.quality || 'auto';
    if(compatible && !compat) throw new Error('兼容播放组件未就绪，请关闭兼容模式或重新解压完整程序');
    if (typeof quality!=='string' || !QUALITY.test(quality)) throw new Error('不支持的清晰度');
    const key=`${sid}/${eid}/${quality}/${Boolean(options.fresh)}/${compatible}`;
    if (pending.has(key)) return pending.get(key);
    const sequence = ++playSequence;
    while (pending.size >= 4) {
      // Keep just one queued selection. Older queued clicks cannot consume
      // another conversion slot or prevent the user's latest click playing.
      if (waitingPlay) waitingPlay.reject(new Error('播放请求已被新的选集替代'));
      await new Promise((resolve, reject) => { waitingPlay = { resolve, reject }; });
      if (current.closed) throw new Error(PLAYBACK_ERRORS.CANCELLED);
      if (sequence !== playSequence) throw new Error('播放请求已被新的选集替代');
    }
    const operation=(async()=>{
      let entry=allowed.get(sid);
      if (!entry || Date.now()-entry.at>3600000) { await detail(sid); entry=allowed.get(sid); }
      checkLifetime(current);
      if (!entry.episodes.has(eid)) throw new Error('分集不属于当前剧集');
      await init();
      checkLifetime(current);
      // Optional quality labels should neither run after conversion nor hold
      // an otherwise ready video hostage when the metadata endpoint is slow.
      const fallback = [{key:quality,label:quality==='auto'?'自动':quality}];
      let readyQualities = fallback;
      (async () => {
        try {
          const rows = await provider.qualities(eid);
          const list = Array.from(rows,q=>({key:q.key,label:q.label})).filter(q=>QUALITY.test(q.key));
          if (list.length) readyQualities = list;
        } catch { /* Optional metadata never blocks ready playback. */ }
      })();
      const mediaReady = compatible ? compat.prepare(eid,quality,options.fresh===true)
        : openStream(eid, options.fresh===true, quality);
      await mediaReady;
      // Use labels if they are already ready; metadata is optional and must
      // add no latency to cached playback or a ready native stream.
      const qualities = readyQualities;
      checkLifetime(current);
      return {url:`${base}/media/${token}/${sid}/${eid}/${quality}${compatible ? '/compat' : ''}`,qualities,quality};
    })();
    // Store only the sanitized shared promise: duplicate callers must never
    // bypass the error boundary and receive provider URLs or diagnostics.
    const work = Promise.race([operation, current.signal.then(() => { throw cancelled(); })]).catch(e => {
      if (/分集不属于/.test(e?.message || '')) throw e;
      throw new Error(playbackErrorMessage(e));
    });
    pending.set(key,work);
    try { return await work; } finally {
      if (pending.get(key) === work) pending.delete(key);
      const waiting = waitingPlay; waitingPlay = null;
      waiting?.resolve();
    }
  }
  async function close() {
    if (closing) return closing;
    lifetime.closed = true; lifetime.cancel();
    const waiting = waitingPlay; waitingPlay = null;
    waiting?.reject(new Error(PLAYBACK_ERRORS.CANCELLED));
    pending.clear();
    const oldServer = server; server = null; base = ''; starting = null;
    closing = (async () => {
      const stopped = oldServer ? new Promise(resolve => { oldServer.closeAllConnections(); oldServer.close(resolve); }) : Promise.resolve();
      await Promise.all([stopped, compat?.close()]);
    })();
    try { await closing; } finally { closing = null; }
  }
  return {catalog,detail,play,init,close,isMediaUrl};
}
let runtime, readyRuntime, runtimeOptions;
async function getRuntime() {
  if (!runtime) runtime=import('./vendor/hongguotv/server/provider.mjs').then(({provider})=>(readyRuntime=createSource(provider, runtimeOptions ? {compat:require('./compat-video.cjs').createCompat({...runtimeOptions,provider})} : {})));
  return runtime;
}
module.exports={ createSource,byteRange, configureCompat:options=>{if(runtime) throw new Error('内容引擎已经初始化');runtimeOptions=options;}, catalog:async o=>(await getRuntime()).catalog(o), detail:async id=>(await getRuntime()).detail(id), play:async o=>(await getRuntime()).play(o),
  init:async()=>(await getRuntime()).init(), close:async()=>runtime && (await runtime).close(), isMediaUrl:url=>Boolean(readyRuntime?.isMediaUrl(url))};
