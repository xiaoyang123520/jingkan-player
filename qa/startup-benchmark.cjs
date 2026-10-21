'use strict';

// Offline benchmark only: fixed delays simulate per-chunk network latency; this does not
// contact or measure any real media source. Run with: node qa/startup-benchmark.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createCompat } = require('../compat-video.cjs');

const CHUNK_SIZE = 1024 * 1024;
const SAMPLE_SIZE = 16 * CHUNK_SIZE;
const CHUNK_DELAY_MS = 30;

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'compat-benchmark-'));
  const ffmpegPath = path.join(root, 'fake-ffmpeg');
  await fs.promises.writeFile(ffmpegPath, `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst a=process.argv.slice(2);\nfs.copyFileSync(a[a.indexOf('-i')+1], a[a.length-1]);\n`);
  await fs.promises.chmod(ffmpegPath, 0o755);
  const sample = Buffer.alloc(SAMPLE_SIZE, 0x5a);
  const results = [];
  try {
    for (const downloadConcurrency of [1, 3]) {
      const compat = createCompat({ ffmpegPath, cacheDir: path.join(root, `cache-${downloadConcurrency}`), downloadConcurrency,
        provider: { async stream() { return { total: sample.length, async chunk(start, end) {
          await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
          return sample.subarray(start, end + 1);
        } }; } },
      });
      const started = performance.now();
      try {
        const video = await compat.prepare('123456', '720P');
        results.push({ concurrency: downloadConcurrency, seconds: Number(((performance.now() - started) / 1000).toFixed(3)), bytes: video.total });
      } finally { await compat.close(); }
    }
    console.log('Offline simulated-network benchmark (not a real media source):');
    console.log(`Sample: ${(SAMPLE_SIZE / CHUNK_SIZE)} MiB; fixed ${CHUNK_DELAY_MS} ms delay per 1 MiB chunk; same sample/ffmpeg for both runs.`);
    for (const result of results) console.log(`downloadConcurrency=${result.concurrency}: ${result.seconds}s; converted bytes=${result.bytes}`);
    console.log(`Observed elapsed-time ratio (1 / 3): ${(results[0].seconds / results[1].seconds).toFixed(2)}x`);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
