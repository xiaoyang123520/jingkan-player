'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INPUT_LIMIT = 150 * 1024 * 1024;
const INPUT_CHUNK = 1024 * 1024;
const TIMEOUT_MS = 600_000;
const CHUNK_RETRIES = 2;
const DEFAULT_DOWNLOAD_CONCURRENCY = 3;
const ID_RE = /^\d{6,30}$/;
const QUALITY_RE = /^(?:auto|(?:360|480|540|576|720|1080|1440|2160)P)$/;
const GENERIC_ERROR = '视频兼容转换失败';

function playbackError(code) {
  const error = new Error(GENERIC_ERROR);
  error.playbackCode = code;
  return error;
}

function coded(error, fallback = 'CACHE_FAILED') {
  return error?.playbackCode ? error : playbackError(fallback);
}

function createCompat({ ffmpegPath, cacheDir, provider, maxBytes = 512 * 1024 * 1024,
  timeoutMs = TIMEOUT_MS, downloadConcurrency = DEFAULT_DOWNLOAD_CONCURRENCY, onProgress } = {}) {
  if (typeof ffmpegPath !== 'string' || !ffmpegPath || typeof cacheDir !== 'string' || !cacheDir ||
      !provider || typeof provider.stream !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isInteger(downloadConcurrency) || downloadConcurrency < 1 || downloadConcurrency > 4 ||
      (onProgress !== undefined && typeof onProgress !== 'function')) {
    throw new TypeError('兼容转换器参数无效');
  }

  const cache = new Map();
  const pending = new Map();
  const children = new Set();
  const cancelChildren = new Set();
  const tempPaths = new Set();
  const handles = new Set();
  const operations = new Set();
  const chunkOperations = new Set();
  let closed = false;
  let closing;
  let cacheReady;
  let cancelResolve;
  const closedSignal = new Promise((resolve) => { cancelResolve = resolve; });
  const untilClose = (operation) => Promise.race([
    operation,
    closedSignal.then(() => { throw playbackError('CANCELLED'); }),
  ]);

  const report = (event) => {
    try { onProgress?.(event); } catch { /* Progress observers must not affect playback. */ }
  };
  const hashFor = (eid, quality) => crypto.createHash('sha256').update(`${eid}|${quality}`).digest('hex');
  const tempPath = (kind) => path.join(cacheDir, `${crypto.randomBytes(16).toString('hex')}.${kind}`);
  async function ensureCache() {
    if (!cacheReady) cacheReady = (async () => {
      try {
        await fs.promises.mkdir(cacheDir, { recursive: true });
        for (const name of await fs.promises.readdir(cacheDir)) {
          if (/^[a-f0-9]{32}\.(?:input\.tmp|partial\.mp4)$/.test(name)) {
            try {
              const stalePath = path.join(cacheDir, name);
              const stat = await fs.promises.lstat(stalePath);
              if (stat.isFile() || stat.isSymbolicLink()) await fs.promises.unlink(stalePath);
            }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            continue;
          }
          if (!/^[a-f0-9]{64}\.mp4$/.test(name)) continue;
          try {
            const file = path.join(cacheDir, name);
            const stat = await fs.promises.stat(file);
            if (stat.isFile() && stat.size > 0) cache.set(name.slice(0, -4), { file, size: stat.size, used: stat.mtimeMs, active: 0, leases: 0, idleWaiters: new Set() });
            else if (stat.isFile()) await fs.promises.unlink(file);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        await trimCache();
      } catch (error) { throw coded(error); }
    })();
    const current = cacheReady;
    try { return await current; }
    catch (error) {
      if (cacheReady === current) cacheReady = undefined;
      throw error;
    }
  }
  async function trimCache(protectKey) {
    let bytes = 0;
    for (const entry of cache.values()) bytes += entry.size;
    for (const [key, entry] of [...cache].sort((a, b) => a[1].used - b[1].used)) {
      if (bytes <= maxBytes) break;
      if (key === protectKey || entry.active || entry.leases) continue;
      try { await fs.promises.unlink(entry.file); } catch (error) { if (error.code !== 'ENOENT') throw coded(error); }
      cache.delete(key);
      bytes -= entry.size;
    }
  }
  async function removeTemp(file) {
    tempPaths.delete(file);
    try { await fs.promises.unlink(file); } catch (error) { if (error.code !== 'ENOENT') { /* Best-effort cleanup. */ } }
  }
  async function closeHandle(handle) {
    if (!handle) return;
    handles.delete(handle);
    try { await handle.close(); } catch { /* It may already have been closed by close(). */ }
  }
  function notifyIdle(entry) {
    if (entry.active || entry.leases) return;
    for (const resolve of entry.idleWaiters) resolve();
    entry.idleWaiters.clear();
  }

  function runFfmpeg(input, output, eid, quality) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(playbackError('CANCELLED'));
      const piped = typeof input === 'function';
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', piped ? 'pipe:0' : input,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy', '-movflags', '+faststart', '-f', 'mp4', output];
      let child;
      try { child = spawn(ffmpegPath, args, { stdio: [piped ? 'pipe' : 'ignore', 'ignore', 'ignore'], windowsHide: true }); }
      catch (error) {
        return reject(playbackError(error?.code === 'ENOENT' || error?.code === 'EACCES' ? 'CONVERT_UNAVAILABLE' : 'CONVERT_FAILED'));
      }
      children.add(child);
      let settled = false;
      let feedComplete = !piped;
      const started = Date.now();
      const tick = () => report({ episodeId: eid, quality, stage: 'convert', elapsedSeconds: Math.floor((Date.now() - started) / 1000), ...(piped ? { pipelined: true } : {}) });
      // episodeId/quality are supplied by the run closure below.
      tick();
      const progressTimer = setInterval(tick, 1000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(progressTimer);
        cancelChildren.delete(cancel);
        error ? reject(error) : resolve();
      };
      let terminalError;
      const cancel = () => {
        terminalError = playbackError('CANCELLED');
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
      };
      cancelChildren.add(cancel);
      const timer = setTimeout(() => {
        terminalError = playbackError('CONVERT_TIMEOUT');
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
      }, timeoutMs);
      child.once('error', (error) => {
        terminalError = playbackError(error?.code === 'ENOENT' || error?.code === 'EACCES' ? 'CONVERT_UNAVAILABLE' : 'CONVERT_FAILED');
      });
      if (piped) {
        // Keep a listener even after the feed completes: an encoder exit can
        // emit EPIPE asynchronously. The close event remains authoritative.
        child.stdin.on('error', () => {});
        const stopped = new AbortController();
        child.once('close', () => stopped.abort());
        Promise.resolve().then(() => input(child.stdin, stopped.signal)).then(() => {
          feedComplete = true;
          if (!stopped.signal.aborted) child.stdin.end();
        }, error => {
          if (stopped.signal.aborted) return;
          terminalError = coded(error, 'DOWNLOAD_FAILED');
          try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        });
      }
      child.once('close', (code) => {
        children.delete(child);
        finish(terminalError || (closed ? playbackError('CANCELLED') : (code === 0 && feedComplete ? null : playbackError('CONVERT_FAILED'))));
      });
    });
  }

  async function pipeDownload(source, writable, signal, eid, quality) {
    let stoppedResolve;
    const stopped = new Promise(resolve => { stoppedResolve = resolve; });
    const abort = () => stoppedResolve({ error: playbackError('CANCELLED') });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let nextStart = 0, completed = 0;
    const queue = [];
    const request = start => (async () => {
      const end = Math.min(start + INPUT_CHUNK - 1, source.total - 1);
      for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
        if (closed || signal.aborted) throw playbackError('CANCELLED');
        try {
          const data = await untilClose(source.chunk(start, end, signal));
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buffer.length !== end - start + 1) throw new Error('short read');
          return { buffer };
        } catch (error) {
          if (closed || signal.aborted) throw playbackError('CANCELLED');
          if (attempt === CHUNK_RETRIES) throw playbackError('DOWNLOAD_FAILED');
        }
      }
    })().catch(error => ({ error }));
    const fill = () => {
      while (queue.length < downloadConcurrency && nextStart < source.total && !signal.aborted && !closed) {
        queue.push(request(nextStart)); nextStart += INPUT_CHUNK;
      }
    };
    try {
      report({ episodeId: eid, quality, stage: 'download', percent: 0, pipelined: true });
      fill();
      while (queue.length) {
        const result = await Promise.race([queue[0], stopped]);
        if (result.error) throw result.error;
        if (closed || signal.aborted) throw playbackError('CANCELLED');
        // Await the write callback, not just drain: this bounds both downloaded
        // buffers and the pipe's internal queue even on a slow Windows CPU.
        await Promise.race([new Promise((resolve, reject) => {
          writable.write(result.buffer, error => error ? reject(playbackError('CONVERT_FAILED')) : resolve());
        }), stopped.then(result => { throw result.error; })]);
        completed += result.buffer.length;
        queue.shift(); fill();
        report({ episodeId: eid, quality, stage: 'download', percent: Math.floor(completed * 100 / source.total), pipelined: true });
      }
    } finally {
      signal.removeEventListener('abort', abort);
      // Pending network reads are bounded and catch their own rejection. They
      // never touch a file/pipe after cancellation or keep close() waiting.
    }
  }

  async function build(eid, quality, fresh, key) {
    let input, output, inputHandle;
    try {
      await ensureCache();
      if (closed) throw playbackError('CANCELLED');
      input = tempPath('input.tmp');
      output = tempPath('partial.mp4');
      tempPaths.add(input); tempPaths.add(output);
      report({ episodeId: eid, quality, stage: 'source' });
      let source;
      try { source = await untilClose(provider.stream(eid, fresh, quality)); }
      catch (error) { throw coded(error, 'SOURCE_UNAVAILABLE'); }
      if (closed) throw playbackError('CANCELLED');
      if (!source || !Number.isSafeInteger(source.total) || source.total <= 0 || typeof source.chunk !== 'function') {
        throw playbackError('SOURCE_UNAVAILABLE');
      }
      if (source.total > INPUT_LIMIT) throw playbackError('INPUT_TOO_LARGE');
      if (source.pipeable === true) {
        // prepareHeader verified front-loaded MP4 metadata. Decode ordered
        // decrypted chunks immediately; retain the finished seekable cache.
        await runFfmpeg((writable, signal) => pipeDownload(source, writable, signal, eid, quality), output, eid, quality);
      } else {
      try {
        inputHandle = await fs.promises.open(input, 'wx');
        handles.add(inputHandle);
      } catch (error) { throw coded(error); }
      let completed = 0;
      report({ episodeId: eid, quality, stage: 'download', percent: 0 });
      let nextStart = 0;
      let workerError;
      const downloadWorker = async () => {
        while (!workerError) {
          if (closed) { workerError = playbackError('CANCELLED'); return; }
          const start = nextStart;
          if (start >= source.total) return;
          nextStart += INPUT_CHUNK;
          const end = Math.min(start + INPUT_CHUNK - 1, source.total - 1);
          let buffer;
          for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
            if (closed) { workerError = playbackError('CANCELLED'); return; }
            try {
              const data = await untilClose(source.chunk(start, end));
              buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
              if (buffer.length !== end - start + 1) throw new Error('short read');
              break;
            } catch (error) {
              if (closed) { workerError = playbackError('CANCELLED'); return; }
              if (attempt === CHUNK_RETRIES) { workerError = playbackError('DOWNLOAD_FAILED'); return; }
            }
          }
          if (!buffer) { workerError = playbackError('DOWNLOAD_FAILED'); return; }
          let offset = 0;
          try {
            while (offset < buffer.length) {
              const { bytesWritten } = await inputHandle.write(buffer, offset, buffer.length - offset, start + offset);
              if (!bytesWritten) throw new Error('short write');
              offset += bytesWritten;
            }
          } catch (error) { workerError = coded(error); return; }
          completed += buffer.length;
          report({ episodeId: eid, quality, stage: 'download', percent: Math.floor(completed * 100 / source.total) });
        }
      };
      // allSettled is intentional: never unlink/close the input while another worker can still write to it.
      await Promise.allSettled(Array.from({ length: Math.min(downloadConcurrency, Math.ceil(source.total / INPUT_CHUNK)) }, downloadWorker));
      if (workerError) throw workerError;
      await closeHandle(inputHandle); inputHandle = null;
      if (closed) throw playbackError('CANCELLED');
      await runFfmpeg(input, output, eid, quality);
      }
      if (closed) throw playbackError('CANCELLED');
      let stat;
      try { stat = await fs.promises.stat(output); } catch (error) { throw coded(error); }
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw playbackError('CONVERT_FAILED');
      const previous = cache.get(key);
      if (previous && (previous.active || previous.leases)) {
        while (previous.active || previous.leases) await new Promise((resolve) => previous.idleWaiters.add(resolve));
      }
      if (closed) throw playbackError('CANCELLED');
      const target = path.join(cacheDir, `${key}.mp4`);
      try { await fs.promises.rename(output, target); } catch (error) { throw coded(error); }
      tempPaths.delete(output); output = null;
      const entry = { file: target, size: stat.size, used: Date.now(), active: 0, leases: 0, idleWaiters: new Set() };
      cache.delete(key); cache.set(key, entry);
      try { await trimCache(key); } catch (error) { throw coded(error); }
      return entry;
    } catch (error) {
      throw coded(error, 'CONVERT_FAILED');
    } finally {
      await closeHandle(inputHandle);
      if (input) await removeTemp(input);
      if (output) await removeTemp(output);
    }
  }

  async function prepareInternal(eid, quality, fresh = false, lease = false) {
    if (closed) throw playbackError('CANCELLED');
    if (typeof eid !== 'string' || !ID_RE.test(eid) || typeof quality !== 'string' || !QUALITY_RE.test(quality) || typeof fresh !== 'boolean' || typeof lease !== 'boolean') {
      throw new TypeError('剧集编号或清晰度无效');
    }
    try {
      await ensureCache();
      if (closed) throw playbackError('CANCELLED');
      const key = hashFor(eid, quality);
      let entry = cache.get(key);
      if (!fresh && entry) {
        try {
          const stat = await fs.promises.stat(entry.file);
          if (!stat.isFile()) throw new Error('not file');
          if (stat.size <= 0 || stat.size !== entry.size) {
            cache.delete(key); entry = null;
          } else {
            entry.used = Date.now();
            cache.delete(key); cache.set(key, entry);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw coded(error);
          cache.delete(key); entry = null;
        }
      } else if (fresh) entry = null;
      let work = pending.get(key);
      if (fresh && work && !work.fresh) {
        const previous = work;
        // Serialize refresh after the in-flight ordinary build. Never publish
        // two conversions concurrently to the same final cache filename.
        work = previous.catch(() => {}).then(() => build(eid, quality, true, key));
        work.fresh = true;
        pending.set(key, work);
        work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => {});
      } else if (!work && !entry) {
        work = build(eid, quality, fresh, key);
        work.fresh = fresh;
        pending.set(key, work);
        work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => {});
      }
      if (!entry) entry = await work;
      if (closed) throw playbackError('CANCELLED');
      if (lease) entry.leases++;
      report({ episodeId: eid, quality, stage: 'ready' });
      let released = false;
      return {
        total: entry.size,
        release: () => {
          if (!lease || released) return;
          released = true;
          entry.leases--;
          notifyIdle(entry);
          return trimCache().catch(() => {});
        },
        chunk: (start, end) => {
          const operation = readChunk(entry, start, end);
          chunkOperations.add(operation);
          operation.finally(() => chunkOperations.delete(operation)).catch(() => {});
          return operation;
        },
      };
    } catch (error) {
      const safeError = coded(error);
      report({ episodeId: eid, quality, stage: 'error', code: safeError.playbackCode });
      throw safeError;
    }
  }

  async function readChunk(entry, start, end) {
    if (closed || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= entry.size) {
      throw new RangeError('视频字节范围无效');
    }
    entry.active++;
    try {
      let handle;
      try { handle = await fs.promises.open(entry.file, 'r'); handles.add(handle); } catch (error) { throw coded(error); }
      try {
        if (closed) throw playbackError('CANCELLED');
        const buffer = Buffer.allocUnsafe(end - start + 1);
        let offset = 0;
        while (offset < buffer.length) {
          let bytesRead;
          try { ({ bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset)); }
          catch (error) { throw coded(error); }
          if (!bytesRead) throw playbackError('CACHE_FAILED');
          offset += bytesRead;
        }
        entry.used = Date.now();
        return buffer;
      } finally { await closeHandle(handle); }
    } finally {
      entry.active--;
      notifyIdle(entry);
      try { await trimCache(); } catch (error) { throw coded(error); }
    }
  }

  function prepare(eid, quality, fresh = false, lease = false) {
    const operation = prepareInternal(eid, quality, fresh, lease);
    operations.add(operation);
    operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    cancelResolve();
    for (const cancel of [...cancelChildren]) cancel();
    for (const child of children) { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
    const cacheInitialization = cacheReady;
    const closingHandles = [...handles].map(closeHandle);
    closing = (async () => {
      await Promise.allSettled(closingHandles);
      await Promise.allSettled([...operations, ...chunkOperations, ...(cacheInitialization ? [cacheInitialization] : [])]);
      await Promise.allSettled([...handles].map(closeHandle));
      await Promise.all([...tempPaths].map(removeTemp));
    })();
    return closing;
  }

  return { prepare, close };
}

module.exports = { createCompat };
