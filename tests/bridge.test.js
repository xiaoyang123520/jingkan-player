'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSource } = require('../source.js');

const SERIES = '123456';
const EPISODE = '654321';
const OTHER_EPISODE = '654322';

function mediaStream(bytes = 16) {
  const data = Buffer.from(Array.from({ length: bytes }, (_, i) => i % 256));
  return {
    total: data.length,
    async chunk(start, end) { return data.subarray(start, end + 1); },
  };
}

function makeProvider(overrides = {}) {
  const calls = { categoryList: [], search: [], detail: [], stream: [], qualities: [] };
  const provider = {
    async categoryList(...args) {
      calls.categoryList.push(args);
      return { items: [{ id: SERIES, title: '剧名', badge: '更新至 12 集', tags: '都市/甜宠/短剧', extra: true }], totalPages: 3 };
    },
    async search(...args) {
      calls.search.push(args);
      return { items: [{ title: '搜索结果', count: '7', tags: ['悬疑', '反转'] }], pagination: { totalPages: 4 } };
    },
    async detail(...args) {
      calls.detail.push(args);
      return {
        id: args[0], title: '详细剧名', description: '剧情介绍', badge: '共 2 集', tags: '家庭/伦理',
        cover: 'https://image.invalid/cover.jpg', episodes: args[0] === SERIES
          ? [{ id: EPISODE }, { id: OTHER_EPISODE }]
          : [{ id: '777777' }],
        providerOnly: '保留字段',
      };
    },
    async stream(...args) {
      calls.stream.push(args);
      return mediaStream();
    },
    async qualities(...args) {
      calls.qualities.push(args);
      return [{ key: '360P', label: '标清' }, { key: '1080P', label: '高清' }, { key: 'bogus', label: '无效' }];
    },
    ...overrides,
  };
  return { provider, calls };
}

function setup(t, overrides) {
  const { provider, calls } = makeProvider(overrides);
  const source = createSource(provider);
  t.after(async () => source.close());
  return { source, provider, calls };
}

function request(url, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('catalog maps provider categories/search results and validates parameters', async t => {
  const { source, calls } = setup(t);
  const catalog = await source.catalog({ category: 'comic-drama', page: 2 });
  assert.deepEqual(calls.categoryList, [['comic-drama', '', 2]]);
  assert.deepEqual(catalog, {
    items: [{ id: SERIES, title: '剧名', badge: '更新至 12 集', tags: ['都市', '甜宠', '短剧'], extra: true, count: 12 }],
    page: 2,
    totalPages: 3,
  });

  const searched = await source.catalog({ category: 'ai-drama', page: 3, keyword: '  测试词  ' });
  assert.deepEqual(calls.search, [['测试词', 3]]);
  assert.equal(searched.page, 3);
  assert.equal(searched.totalPages, 4);
  assert.deepEqual(searched.items[0], { title: '搜索结果', count: 7, tags: ['悬疑', '反转'] });

  for (const options of [null, 'x', { category: 'unknown' }, { page: 0 }, { page: -1 }, { page: 10001 }, { page: 1.5 }, { keyword: 'x'.repeat(81) }]) {
    await assert.rejects(source.catalog(options), /目录参数无效|搜索关键词不能超过80字/);
  }
});

test('detail normalizes fields and binds episodes to their series', async t => {
  const { source, calls } = setup(t);
  const result = await source.detail(SERIES);
  assert.deepEqual(calls.detail, [[SERIES]]);
  assert.equal(result.id, SERIES);
  assert.equal(result.title, '详细剧名');
  assert.equal(result.intro, '剧情介绍');
  assert.equal(result.accessible, true);
  assert.equal(result.count, 2);
  assert.deepEqual(result.tags, ['家庭', '伦理']);
  assert.equal(result.providerOnly, '保留字段');
  assert.deepEqual(result.episodes, [
    { id: EPISODE, index: 1, available: true },
    { id: OTHER_EPISODE, index: 2, available: true },
  ]);

  await assert.rejects(source.play({ seriesId: SERIES, episodeId: '999999' }), /分集不属于当前剧集/);
  await assert.rejects(source.play({ seriesId: '111111', episodeId: EPISODE }), /分集不属于当前剧集/);
  for (const badId of [undefined, 123456, '12345', '1234567890123456789012345678901', '12-456']) {
    await assert.rejects(source.detail(badId), /剧集编号无效/);
  }
});

test('play validates URL and quality, and passes fresh/quality to provider', async t => {
  const { source, calls } = setup(t);
  const result = await source.play({ seriesId: SERIES, episodeId: EPISODE, fresh: true, quality: '720P' });
  assert.equal(result.quality, '720P');
  assert.deepEqual(result.qualities, [{ key: '360P', label: '标清' }, { key: '1080P', label: '高清' }]);
  assert.deepEqual(calls.stream, [[EPISODE, true, '720P']]);
  assert.deepEqual(calls.qualities, [[EPISODE]]);
  assert.equal(source.isMediaUrl(result.url), true);
  for (const invalid of [
    result.url + '?x=1', result.url + '#fragment', result.url.replace('/media/', '/other/'),
    result.url.replace('127.0.0.1', 'localhost'), result.url.replace(/\/720P$/, '/bad'),
    result.url.replace(/\/720P$/, '/1080p'), 'https://example.invalid/media/123',
  ]) assert.equal(source.isMediaUrl(invalid), false, invalid);
  for (const quality of ['bad', '1080p', '240P', 720]) {
    await assert.rejects(source.play({ seriesId: SERIES, episodeId: EPISODE, quality }), /不支持的清晰度/);
  }
  await assert.rejects(source.play({ seriesId: 'x', episodeId: EPISODE }), /剧集编号无效/);
});

test('play maps known playback codes to safe Chinese errors and keeps unknown errors generic', async t => {
  const secret = 'https://private-origin.invalid/secret?token=hidden; stderr: private diagnostic';
  let failure;
  const { source } = setup(t, {
    async stream() { throw Object.assign(new Error(secret), failure || {}); },
  });
  const expected = {
    SOURCE_UNAVAILABLE: '片源暂不可用，请重试或切换画质。',
    DOWNLOAD_FAILED: '视频获取失败，请稍后重试或切换画质。',
    CONVERT_UNAVAILABLE: '兼容转换组件无法启动，请重新完整解压程序，并检查 ffmpeg.exe 是否被拦截。',
    CONVERT_TIMEOUT: '视频转换超过10分钟，请降低画质或关闭兼容模式后重试。',
    CONVERT_FAILED: '视频转换失败，请重试或切换画质。',
    CACHE_FAILED: '无法写入视频缓存，请检查磁盘剩余空间和目录写入权限。',
    INPUT_TOO_LARGE: '视频文件过大，无法使用当前播放方式。',
    CANCELLED: '播放已取消，请重新尝试。',
  };
  for (const [playbackCode, message] of Object.entries(expected)) {
    failure = { playbackCode };
    await assert.rejects(source.play({ seriesId: SERIES, episodeId: EPISODE }), error => {
      assert.equal(error.message, message);
      assert.equal(error.message.includes('private-origin.invalid'), false);
      assert.equal(error.message.includes('private diagnostic'), false);
      return true;
    });
  }

  failure = { playbackCode: 'UNRECOGNIZED' };
  await assert.rejects(source.play({ seriesId: SERIES, episodeId: EPISODE }), error => {
    assert.equal(error.message, '片源暂不可用，请稍后重试或切换画质');
    assert.equal(error.message.includes('网络、地区'), false);
    assert.equal(error.message.includes('private-origin.invalid'), false);
    assert.equal(error.message.includes('private diagnostic'), false);
    return true;
  });
  failure = undefined;
  await assert.rejects(source.play({ seriesId: SERIES, episodeId: EPISODE }), /片源暂不可用/);
});

test('qualities lookup failure does not fail an available playback and falls back to requested quality', async t => {
  let qualityCalls = 0;
  const { source, calls } = setup(t, {
    async qualities() { qualityCalls++; throw new Error('private qualities failure'); },
  });
  const result = await source.play({ seriesId: SERIES, episodeId: EPISODE, quality: '1080P' });
  assert.equal(result.quality, '1080P');
  assert.deepEqual(result.qualities, [{ key: '1080P', label: '1080P' }]);
  assert.equal(source.isMediaUrl(result.url), true);
  assert.deepEqual(calls.stream, [[EPISODE, false, '1080P']]);
  assert.equal(qualityCalls, 1);
});

test('local media server supports GET, byte ranges, HEAD, and rejects unsatisfiable ranges', async t => {
  const { source } = setup(t, {
    async stream() { return mediaStream(16); },
  });
  const { url } = await source.play({ seriesId: SERIES, episodeId: EPISODE });
  const full = await request(url);
  assert.equal(full.status, 200);
  assert.equal(full.body.length, 16);
  assert.equal(full.headers['content-type'], 'video/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-length'], '16');
  assert.equal(full.headers['cache-control'], 'no-store');
  assert.equal(full.headers['x-content-type-options'], 'nosniff');

  const partial = await request(url, { headers: { Range: 'bytes=2-5' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers['content-range'], 'bytes 2-5/16');
  assert.deepEqual(partial.body, Buffer.from([2, 3, 4, 5]));
  const suffix = await request(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], 'bytes 13-15/16');
  assert.deepEqual(suffix.body, Buffer.from([13, 14, 15]));

  const head = await request(url, { method: 'HEAD', headers: { Range: 'bytes=1-3' } });
  assert.equal(head.status, 206);
  assert.equal(head.headers['content-range'], 'bytes 1-3/16');
  assert.equal(head.headers['content-length'], '3');
  assert.equal(head.body.length, 0);

  const impossible = await request(url, { headers: { Range: 'bytes=16-' } });
  assert.equal(impossible.status, 416);
  assert.equal(impossible.headers['content-range'], 'bytes */16');
  assert.equal(impossible.body.length, 0);
});

test('media server rejects altered tokens, wrong hosts, and methods other than GET/HEAD', async t => {
  const { source } = setup(t);
  const { url } = await source.play({ seriesId: SERIES, episodeId: EPISODE });
  const badToken = url.replace(/\/media\/[^/]+\//, '/media/not-the-token/');
  const wrongToken = await request(badToken);
  assert.equal(wrongToken.status, 403);
  const wrongHost = await request(url, { headers: { Host: 'attacker.invalid' } });
  assert.equal(wrongHost.status, 403);
  const post = await request(url, { method: 'POST' });
  assert.equal(post.status, 405);
});

test('provider stream failures become generic 502 responses without exposing sensitive URLs', async t => {
  const secret = 'https://private-origin.invalid/secret/path?signature=very-secret';
  let failStream = false;
  const { source } = setup(t, {
    async stream() {
      if (failStream) throw new Error(`upstream failed: ${secret}`);
      return mediaStream();
    },
  });
  const { url } = await source.play({ seriesId: SERIES, episodeId: EPISODE });
  failStream = true;
  const response = await request(url);
  assert.equal(response.status, 502);
  const body = response.body.toString('utf8');
  assert.match(body, /片源暂不可用/);
  assert.equal(body.includes(secret), false);
  assert.equal(body.includes('private-origin.invalid'), false);
});

test('large local media is chunked in bounded provider reads', async t => {
  const chunks = [];
  const bytes = 65536;
  const { source } = setup(t, {
    async stream() {
      const data = Buffer.alloc(bytes, 7);
      return { total: bytes, async chunk(start, end) { chunks.push([start, end]); return data.subarray(start, end + 1); } };
    },
  });
  const { url } = await source.play({ seriesId: SERIES, episodeId: EPISODE });
  const response = await request(url);
  assert.equal(response.status, 200);
  assert.equal(response.body.length, bytes);
  assert.deepEqual(chunks, [[0, bytes - 1]]);
});

test('concurrent identical play requests are deduplicated; close releases the server', async t => {
  let release;
  let streamCalls = 0;
  let announceEntered;
  const entered = new Promise(resolve => { announceEntered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { source, calls } = setup(t, {
    async stream(...args) { streamCalls++; announceEntered(); await gate; return mediaStream(); },
  });
  const first = source.play({ seriesId: SERIES, episodeId: EPISODE, quality: '480P' });
  const second = source.play({ seriesId: SERIES, episodeId: EPISODE, quality: '480P' });
  await entered;
  assert.equal(streamCalls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.url, b.url);
  assert.equal(streamCalls, 1);
  await source.close();
  await source.init();
});
