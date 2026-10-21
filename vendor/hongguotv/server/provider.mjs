import fs from "node:fs";
import vm from "node:vm";
import crypto from "../../../crypto-compat.cjs";
import axios from "axios";
import { AsyncLocalStorage } from "node:async_hooks";
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import categoryContract from '../shared/category-contract.cjs';

// c-ares queries do not occupy the OS getaddrinfo/libuv worker pool. On Windows,
// an unresolved CDN hostname can otherwise delay even a healthy backup lookup.
export function createMediaLookup(resolver = new Resolver({ timeout: 800, tries: 1 }), alternative = null) {
  const pending = new Map(), cache = new Map();
  return (hostname, options, callback) => {
    const family = Number(options?.family) === 6 ? 6 : 4;
    const key = `${hostname}:${family}`;
    const cached = cache.get(key);
    let work = cached && cached.until > Date.now() ? Promise.resolve(cached.addresses) : pending.get(key);
    if (!work) {
      const query = async source => {
        const rows = await (family === 6 ? source.resolve6(hostname, { ttl: true }) : source.resolve4(hostname, { ttl: true }));
        if (!rows.length) throw Object.assign(new Error('No CDN DNS addresses'), { code: 'ENODATA' });
        return rows;
      };
      // A single configured resolver can itself queue for several seconds.
      // Race independent DNS paths, accepting only successful nonempty answers.
      const queries = [query(resolver)];
      if (alternative) queries.push(query(alternative));
      work = Promise.any(queries).catch(error => { throw error.errors?.[0] || error; }).then(rows => {
        const addresses = rows.map(row => ({ address: row.address, family }));
        const ttl = Math.min(60, ...rows.map(row => Number(row.ttl) || 1));
        cache.set(key, { until: Date.now() + ttl * 1000, addresses });
        if (cache.size > 64) cache.delete(cache.keys().next().value);
        return addresses;
      });
      pending.set(key, work);
      const cleanup = () => { if (pending.get(key) === work) pending.delete(key); };
      work.then(cleanup, cleanup);
    }
    work.then(addresses => options?.all ? callback(null, addresses) : callback(null, addresses[0].address, family), error => callback(error));
  };
}
const mediaDnsServers = process.env.HG_MEDIA_DNS_SERVERS || '119.29.29.29,223.5.5.5';
const mediaDnsAlternative = mediaDnsServers === 'system' ? null : new Resolver({ timeout: 500, tries: 1 });
if (mediaDnsAlternative) mediaDnsAlternative.setServers(mediaDnsServers.split(',').map(value => value.trim()).filter(Boolean));
export const mediaLookup = createMediaLookup(undefined, mediaDnsAlternative);
// Node normally waits 250ms before each alternate address. A few unreachable
// addresses can consume most of the first-frame budget before TLS even starts.
export function createContentTransport() {
  const options = { keepAlive: true, maxSockets: 32, maxFreeSockets: 8,
    autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 50 };
  return { httpAgent: new http.Agent(options), httpsAgent: new https.Agent(options) };
}
export const contentTransport = createContentTransport();
const requestContext = new AsyncLocalStorage();
export const upstreamRequestSignal = () => requestContext.getStore();
const resourcePending = new Map();
const detailRefreshes = new Map();

// A cancelled speculative subscriber must not abort a foreground subscriber.
export function sharedResource(key, load, { signal = upstreamRequestSignal() } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let entry = resourcePending.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, subscribers: 0 };
    resourcePending.set(key, entry);
    try { entry.promise = Promise.resolve(requestContext.run(controller.signal, load)); }
    catch (error) { entry.promise = Promise.reject(error); }
    const cleanup = () => { if (resourcePending.get(key) === entry) resourcePending.delete(key); };
    entry.promise.then(cleanup, cleanup);
  }
  entry.subscribers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      entry.subscribers--; callback(value);
    };
    const abort = () => {
      finish(reject, signal.reason);
      if (!entry.subscribers) {
        if (resourcePending.get(key) === entry) resourcePending.delete(key);
        entry.controller.abort();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export function createPrefetchQueue(load, { enabled = true, concurrency = 1 } = {}) {
  const batches = new Map(), tasks = new Map();
  let running = 0, foreground = 0, scheduled = false, closed = false;
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; pump(); });
  };
  const pump = () => {
    if (closed || foreground) return;
    for (const task of tasks.values()) {
      if (running >= Math.max(1, Math.min(2, concurrency))) break;
      if (task.state !== 'queued') continue;
      task.state = 'running'; running++;
      Promise.resolve().then(() => requestContext.run(task.controller.signal, () => load(task.target, task.controller.signal)))
        .then(result => { if (task.state !== 'cancelled') { task.state = 'done'; task.result = result; } }, () => { if (task.state !== 'cancelled') task.state = 'failed'; })
        .finally(() => {
          running--; if (tasks.get(task.key) === task) tasks.delete(task.key);
          for (const batch of task.batches) if (batch.tasks.every(row => !['queued', 'running'].includes(row.state))) batch.finishedAt = Date.now();
          schedule();
        });
    }
  };
  const status = id => {
    const batch = batches.get(id);
    if (!batch) return null;
    return { id, enabled, state: batch.cancelled ? 'cancelled' : batch.tasks.some(row => ['queued', 'running'].includes(row.state)) ? 'pending' : 'complete',
      targets: batch.tasks.map(row => ({ ...row.target, state: row.state, ...(row.result === undefined ? {} : { result: row.result }) })) };
  };
  const cancel = id => {
    const batch = batches.get(id);
    if (!batch) return null;
    batch.cancelled = true; batch.finishedAt = Date.now();
    for (const task of batch.tasks) {
      task.batches.delete(batch);
      if (!task.batches.size && ['queued', 'running'].includes(task.state)) {
        task.state = 'cancelled'; task.controller.abort();
        if (tasks.get(task.key) === task) tasks.delete(task.key);
      }
    }
    schedule(); return status(id);
  };
  return {
    submit(targets) {
      if (closed) throw Object.assign(new Error('预取服务已关闭'), { status: 503 });
      if (!Array.isArray(targets) || !targets.length || targets.length > 8) throw Object.assign(new Error('每次预取需包含 1–8 个目标'), { status: 400 });
      const normalized = targets.map(target => {
        if (!target || !['detail', 'qualities', 'stream'].includes(target.kind)) throw Object.assign(new Error('不支持的预取类型'), { status: 400 });
        if (typeof target.id !== 'string' || !/^\d{1,30}$/.test(target.id) || (target.seriesId !== undefined && (typeof target.seriesId !== 'string' || !/^\d{1,30}$/.test(target.seriesId)))) throw Object.assign(new Error('ID 必须是数字字符串'), { status: 400 });
        if (target.kind === 'stream' && (target.level !== undefined && !['l1', 'l2'].includes(target.level) || target.quality !== undefined && (typeof target.quality !== 'string' || !/^(auto|\d{3,4}P)$/i.test(target.quality)))) throw Object.assign(new Error('不支持的预缓存级别或画质'), { status: 400 });
        return { kind: target.kind, id: target.id, ...(target.seriesId ? { seriesId: target.seriesId } : {}), ...(target.kind === 'stream' ? { level: target.level || 'l1', quality: target.quality?.toLowerCase() === 'auto' ? 'auto' : target.quality?.toUpperCase() || '1080P' } : {}) };
      });
      if (!enabled) return { enabled: false, id: null, state: 'disabled', targets: [] };
      for (const [id, batch] of batches) if (batch.finishedAt && Date.now() - batch.finishedAt > 60000) batches.delete(id);
      if (batches.size >= 64) for (const [id, batch] of batches) { if (batch.finishedAt) batches.delete(id); if (batches.size < 64) break; }
      const targetKey = target => `${target.kind}:${target.id}${target.kind === 'stream' ? `:${target.quality}:${target.level}` : ''}`;
      const additional = new Set(normalized.map(targetKey).filter(key => !tasks.has(key))).size;
      if (tasks.size + additional > 32 || batches.size >= 64) throw Object.assign(new Error('预取队列已满'), { status: 429 });
      const batch = { id: crypto.randomUUID(), tasks: [], cancelled: false };
      for (const target of normalized) {
        const key = targetKey(target);
        let task = tasks.get(key);
        if (!task) { task = { key, target, state: 'queued', batches: new Set(), controller: new AbortController() }; tasks.set(key, task); }
        task.batches.add(batch); if (!batch.tasks.includes(task)) batch.tasks.push(task);
      }
      batches.set(batch.id, batch); schedule(); return status(batch.id);
    },
    status, cancel,
    async foreground(work) { foreground++; try { return await work(); } finally { foreground--; schedule(); } },
    close() { closed = true; for (const id of batches.keys()) cancel(id); batches.clear(); },
  };
}

const upstreamClient = axios.create({ ...contentTransport, maxContentLength: 16 * 1024 * 1024, maxBodyLength: 1024 * 1024 });
upstreamClient.interceptors.request.use(config => {
  const signal = upstreamRequestSignal();
  if (signal) config.signal = config.signal ? AbortSignal.any([config.signal, signal]) : signal;
  return config;
});

// Trusted, pinned GPL source. This is a compatibility wrapper, not a sandbox for user scripts.
const source = fs.readFileSync(
  fs.existsSync(new URL("../shared/content-core/hongguo.js", import.meta.url)) ? new URL("../shared/content-core/hongguo.js", import.meta.url) : new URL("./vendor/hongguo.cjs", import.meta.url),
  "utf8"
);
const context = vm.createContext({
  require: (name) => {
    if (name === "node:crypto") return crypto;
    throw new Error("Unsupported module");
  },
  Buffer,
  URL,
  URLSearchParams,
  AbortController,
  mediaLookup,
  axios: upstreamClient,
});
vm.runInContext(
  source +
    "\nthis.api = {categoryPage, categoryData, itemToCard, appSearchPage, routerData, resolveStream, prepareHeader, remoteRange, decryptPartial, streamCache, videoInfoCache, pageCache, appSearchCache, fetchVideoInfo, qualityLabel};",
  context,
  { timeout: 5000 }
);
const api = context.api;
const SITE = "https://hongguoduanju.com";
const card = (row) => ({
  id: String(row.url),
  title: row.title,
  cover: row.img || "",
  description: row.content || "",
  badge: row.desc || "",
  tags: row.tname || "",
});
const cards = (rows) =>
  Array.from(rows)
    .filter((r) => /^\d+$/.test(String(r.url)) && r.title)
    .map(card);

export const provider = {
  async categoryMetadata(type='real-drama') {
    if(!categoryContract.types.some(row=>row.id===type)){const error=new Error('不支持的分类类型');error.status=400;throw error;}
    const data=await api.routerData(`${SITE}/category/${type}`);
    const {types,tags,sourceUrl}=categoryContract.officialCategory(data,type);
    return {types,type,tags,sourceUrl};
  },
  async category(type, tag = '', page = 1) {
    if(!['real-drama','comic-drama','ai-drama'].includes(type)||!/^[-a-z]*$/.test(tag))throw new Error('Unsupported category');
    const data=await api.routerData(`${SITE}/category/${type}${tag?`/${tag}`:''}${page>1?`?page=${page}`:''}`);
    const result=categoryContract.officialCategory(data,type,tag,page);
    return cards(result.rows.map(api.itemToCard)).map(row=>({...row,contentType:type}));
  },
  async categoryList(type,tag='',page=1) {
    const metadata=await this.categoryMetadata(type);
    if(tag&&!metadata.tags.some(row=>row.id===tag)){const error=new Error('当前类型不支持该题材');error.status=400;throw error;}
    const data=await api.routerData(`${SITE}/category/${type}${tag?`/${tag}`:''}${page>1?`?page=${page}`:''}`);
    const {rows,...result}=categoryContract.officialCategory(data,type,tag,page);
    return {...result,items:cards(rows.map(api.itemToCard)).map(row=>({...row,contentType:type}))};
  },
  async home(page = 1) {
    const data = await api.categoryPage("tab=1&sort_type=1", page);
    const pageData =
      data?.loaderData?.category_page || data?.loaderData?.["category_$"];
    if (!Array.isArray(pageData?.recommendList))
      throw new Error("首页数据结构已变化");
    return { items: cards(pageData.recommendList.map(api.itemToCard)), page };
  },
  async search(keyword, page = 1) {
    const fetchApp = async () => {
      const result = await api.appSearchPage(keyword, 11, page, 20);
      return Array.isArray(result.list) ? cards(result.list) : [];
    };
    const fetchWeb = async () => {
      const data = await api.routerData(
        `${SITE}/search/${encodeURIComponent(keyword)}?page=${page}`
      );
      const pageData =
        data?.loaderData?.["search_(keyword)/page"] ||
        data?.loaderData?.search_page;
      if (!Array.isArray(pageData?.searchList)) throw new Error("搜索数据不可用");
      return cards(pageData.searchList.map(api.itemToCard));
    };

    const timers = [];
    const timeout = (ms) => new Promise((_, reject) => { timers.push(setTimeout(() => reject(new Error("搜索请求超时，请稍后重试")), ms)); });
    try {
      const [appRes, webRes] = await Promise.allSettled([
        Promise.race([fetchApp(), timeout(15000)]),
        Promise.race([fetchWeb(), timeout(15000)]),
      ]);

      const items = [];
      const seen = new Set();
      const addItem = (item) => {
        if (item && item.id && !seen.has(String(item.id))) {
          seen.add(String(item.id));
          items.push(item);
        }
      };

      if (appRes.status === "fulfilled" && Array.isArray(appRes.value)) {
        appRes.value.forEach(addItem);
      }
      if (webRes.status === "fulfilled" && Array.isArray(webRes.value)) {
        webRes.value.forEach(addItem);
      }

      if (!items.length) {
        if (appRes.status === "rejected" && webRes.status === "rejected") {
          throw (webRes.reason?.message !== "搜索请求超时" ? webRes.reason : appRes.reason);
        }
      }
      return { items, page };
    } finally {
      for (const timer of timers) clearTimeout(timer);
    }
  },
  detailCacheStatus(id) {
    if (detailRefreshes.has(id)) return 'MISS';
    return api.pageCache.get(`${SITE}/detail?series_id=${id}`) ? 'HIT' : 'MISS';
  },
  async detail(id, { fresh = false, signal = upstreamRequestSignal() } = {}) {
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw Object.assign(new Error('剧集 ID 必须是数字字符串'), { status: 400 });
    if (signal?.aborted) throw signal.reason;
    let refreshKey = detailRefreshes.get(id);
    if (fresh && !refreshKey) {
      refreshKey = `detail:${id}:fresh:${crypto.randomUUID()}`;
      detailRefreshes.set(id, refreshKey);
    }
    const key = refreshKey || `detail:${id}`;
    const result = sharedResource(key, async () => {
    if (refreshKey) {
      const old = resourcePending.get(`detail:${id}`);
      if (old) await old.promise.catch(() => {});
      upstreamRequestSignal()?.throwIfAborted();
      api.pageCache.delete(`${SITE}/detail?series_id=${id}`);
    }
    const data = await api.routerData(`${SITE}/detail?series_id=${id}`);
    const series = data?.loaderData?.detail_page?.seriesDetail;
    if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length)
      throw new Error("剧集不存在或分集暂不可用");
    const episodes = Array.from(series.vid_list, (vid, index) => ({
      id: String(vid),
      title: `第 ${index + 1} 集`,
      number: index + 1,
    }));
    if (
      episodes.some((e) => !/^\d+$/.test(e.id)) ||
      new Set(episodes.map((e) => e.id)).size !== episodes.length
    )
      throw new Error("分集数据异常");
    return { ...card(api.itemToCard(series)), id, episodes };
    }, { signal });
    if (refreshKey) {
      const clear = () => { if (detailRefreshes.get(id) === refreshKey) detailRefreshes.delete(id); };
      resourcePending.get(key)?.promise.then(clear, clear);
    }
    return result;
  },
  async qualities(id) {
    const info = await api.fetchVideoInfo(id);
    return Array.from(info.rows, row => ({ key: api.qualityLabel(row.quality || row.key), label: api.qualityLabel(row.quality || row.key) }));
  },
  async stream(id, fresh = false, quality = "auto") {
    if (fresh) {
      api.streamCache.delete(`${id}|${quality}`);
      api.videoInfoCache.delete(id);
    }
    const stream = await api.resolveStream(id, quality);
    const prepared = await api.prepareHeader(stream);
    return {
      total: prepared.total,
      chunk: async (start, end) =>
        api.decryptPartial(
          (await api.remoteRange(stream, start, end)).data,
          start,
          stream.key,
          prepared
        ),
    };
  },
};

// Limit the pinned upstream's otherwise unbounded caches during long-lived home use.
setInterval(() => {
  for (const cache of [
    api.streamCache,
    api.videoInfoCache,
    api.pageCache,
    api.appSearchCache,
  ]) {
    for (const [key, value] of cache)
      if (Date.now() - value.time > 300000) cache.delete(key);
    while (cache.size > 100) cache.delete(cache.keys().next().value);
  }
}, 60000).unref();
