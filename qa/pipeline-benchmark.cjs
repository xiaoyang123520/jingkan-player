'use strict';
// Offline synthetic network + real HEVC decode/H264 encode. Not a Windows benchmark.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createCompat } = require('../compat-video.cjs');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jingkan-pipeline-bench-'));
  const results = [];
  try {
    const input = path.join(dir, 'input.mp4');
    console.log('Generating offline HEVC sample...');
    execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=496x880:rate=25', '-t', '14', '-c:v', 'libx265', '-preset', 'ultrafast', '-crf', '18', '-x265-params', 'pools=2:frame-threads=2:log-level=error', '-movflags', '+faststart', input], { stdio: ['ignore', 'ignore', 'ignore'] });
    const data = fs.readFileSync(input);
    const source = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', input], { encoding: 'utf8' }));
    for (const pipelined of [false, true, false, true]) {
      let downloadedAt = 0, convertingAt = 0;
      const started = performance.now();
      const compat = createCompat({ ffmpegPath: '/usr/bin/ffmpeg', cacheDir: path.join(dir, 'cache-' + results.length), provider: {
        async stream() { return { total: data.length, pipeable: pipelined, async chunk(start, end) {
          await new Promise(resolve => setTimeout(resolve, 300));
          return data.subarray(start, end + 1);
        } }; },
      }, onProgress(event) {
        if (event.stage === 'convert' && !convertingAt) convertingAt = performance.now() - started;
        if (event.stage === 'download' && event.percent === 100) downloadedAt = performance.now() - started;
      } });
      try {
        const result = await compat.prepare('123456', '720P');
        const elapsedMs = performance.now() - started;
        const file = path.join(dir, 'cache-' + results.length, fs.readdirSync(path.join(dir, 'cache-' + results.length)).find(name => /^[a-f0-9]{64}\.mp4$/.test(name)));
        const decoded = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file], {encoding:'utf8'}));
        if (decoded.streams[0].codec_name !== 'h264' || Number(decoded.streams[0].nb_read_frames) !== 350) throw Error('incomplete transcoded output');
        execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-ss', '7', '-i', file, '-frames:v', '1', '-f', 'null', '-'], {stdio:'ignore'});
        results.push({ pipelined, elapsedMs: Math.round(elapsedMs), downloadConsumedMs: Math.round(downloadedAt), encoderProcessStartedMs: Math.round(convertingAt), outputBytes: result.total });
        console.log(JSON.stringify(results.at(-1)));
      } finally { await compat.close(); }
    }
    const average = pipeline => results.filter(row => row.pipelined === pipeline).reduce((sum, row) => sum + row.elapsedMs, 0) / 2;
    const result = { environment: 'Linux; offline synthetic 300ms per 1MiB network request; real system ffmpeg; two alternating runs per mode; not Windows or live CDN timing', source: { codec: source.streams[0].codec_name, bytes: data.length, durationSeconds: Number(source.streams[0].duration), width: source.streams[0].width, height: source.streams[0].height }, downloadConcurrency: 3, results, meanSequentialMs: average(false), meanPipelinedMs: average(true), observedReductionPercent: Math.round((1 - average(true) / average(false)) * 1000) / 10 };
    fs.writeFileSync(path.join(__dirname, 'pipeline-benchmark-result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
