(() => {
  'use strict';

  const STORAGE = { favorites: 'hg-player-favorites-v1', history: 'hg-player-history-v1', progress: 'hg-player-progress-v1' };
  const LIMIT = 200;
  const CATEGORY_KEYS = { '真人剧': 'real-drama', '漫剧': 'comic-drama', 'AI剧': 'ai-drama' };
  const state = { category: '真人剧', page: 1, totalPages: 1, items: [], view: 'discover', series: null, episodeIndex: -1, playbackToken: 0, detailToken: 0, catalogToken: 0, toastTimer: 0, progressTimer: 0, searchKeyword: '', isLoading: false, pendingMetadataToken: 0, activeMediaUrl: '', qualities: [], selectedQuality: '', lastPlay: null };
  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $('catalog-grid'), empty: $('catalog-empty'), filter: $('title-filter'), searchForm: $('catalog-search-form'), searchStatus: $('catalog-status'), pageSummary: $('page-summary'), pageNumber: $('page-number'), prev: $('prev-page'), next: $('next-page'), heading: $('page-heading'), favoriteCount: $('favorite-count'),
    listView: $('list-view'), listGrid: $('list-grid'), listEmpty: $('list-empty'), listTitle: $('list-title'), listEyebrow: $('list-eyebrow'), listDesc: $('list-description'), listEmptyTitle: $('list-empty-title'), discoverView: $('discover-view'), aboutView: $('about-view'),
    backdrop: $('detail-backdrop'), video: $('player-video'), placeholder: $('video-placeholder'), placeholderText: $('video-placeholder-text'), detailTitle: $('detail-title'), detailIntro: $('detail-intro'), detailTags: $('detail-tags'), episodes: $('episode-list'), episodeCount: $('episode-count'), detailError: $('detail-error'), favoriteButton: $('favorite-button'), quality: $('quality-select'), retry: $('retry-play'),
    error: $('global-error'), errorText: $('global-error-text'), toast: $('toast'),
  };

  function readStore(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key) || 'null'); return value === null ? fallback : value; } catch (_) { return fallback; } }
  function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { showError('浏览器无法保存本地数据，请检查存储空间或隐私设置。'); } }
  function capList(list) { return Array.isArray(list) ? list.slice(0, LIMIT) : []; }
  function validRecord(record) { return Boolean(record && typeof record === 'object' && !Array.isArray(record) && (typeof record.id === 'string' && record.id.trim() || typeof record.id === 'number' && Number.isFinite(record.id))); }
  function storedRecords(key) { const value = readStore(key, []); return capList(Array.isArray(value) ? value.filter(validRecord) : []); }
  function favorites() { return storedRecords(STORAGE.favorites); }
  function history() { return storedRecords(STORAGE.history); }
  function progressMap() {
    const value = readStore(STORAGE.progress, {}); if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const entries = Object.entries(value).filter(([key, record]) => key.includes('::') && record && typeof record === 'object' && !Array.isArray(record) && Number.isFinite(Number(record.time)) && Number(record.time) > 0 && Number.isFinite(Number(record.updatedAt)) && Number(record.updatedAt) >= 0);
    entries.sort((a, b) => Number(b[1].updatedAt) - Number(a[1].updatedAt)); return Object.fromEntries(entries.slice(0, LIMIT));
  }
  function normalizeText(value) { return typeof value === 'string' ? value : value == null ? '' : String(value); }
  function safeCover(value) { if (typeof value !== 'string' || !value.trim()) return ''; try { const u = new URL(value); return u.protocol === 'https:' ? u.href : ''; } catch (_) { return ''; } }
  function showError(message) { els.errorText.textContent = message; els.error.hidden = false; }
  function hideError() { els.error.hidden = true; els.errorText.textContent = ''; }
  function showDetailError(message) { els.detailError.textContent = message; els.detailError.hidden = false; }
  function clearDetailError() { els.detailError.textContent = ''; els.detailError.hidden = true; }
  function toast(message) { els.toast.textContent = message; els.toast.classList.add('is-visible'); window.clearTimeout(state.toastTimer); state.toastTimer = window.setTimeout(() => els.toast.classList.remove('is-visible'), 2600); }
  function playerApi() { if (!window.player || typeof window.player.catalog !== 'function' || typeof window.player.detail !== 'function' || typeof window.player.play !== 'function') throw new Error('播放器接口尚未连接。此界面需要由宿主提供 0.2 版 window.player 接口。'); return window.player; }
  function setText(node, value) { node.textContent = normalizeText(value); }
  function addTag(container, value) { const tag = document.createElement('span'); tag.className = 'detail-tag'; tag.textContent = normalizeText(value); container.appendChild(tag); }
  function firstChars(value) { const text = normalizeText(value).trim(); return text ? Array.from(text).slice(0, 2).join('') : '剧'; }
  function makeCard(item) {
    const card = document.createElement('article'); card.className = 'series-card'; card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', `打开剧集：${normalizeText(item.title)}`);
    const cover = document.createElement('div'); cover.className = 'cover-wrap'; const fallback = document.createElement('div'); fallback.className = 'cover-fallback'; fallback.textContent = firstChars(item.title); cover.appendChild(fallback);
    const coverUrl = safeCover(item.cover); if (coverUrl) { const img = document.createElement('img'); img.className = 'cover-image'; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = coverUrl; img.addEventListener('load', () => { fallback.hidden = true; }); img.addEventListener('error', () => { img.remove(); fallback.hidden = false; }); cover.insertBefore(img, fallback); }
    const shade = document.createElement('div'); shade.className = 'cover-shade'; cover.appendChild(shade); const badges = document.createElement('div'); badges.className = 'card-badges'; const tags = Array.isArray(item.tags) ? item.tags.slice(0, 2) : [];
    tags.forEach((tag, index) => { const badge = document.createElement('span'); badge.className = `card-badge${index === 0 ? ' accent' : ''}`; badge.textContent = normalizeText(tag); badges.appendChild(badge); }); if (tags.length) cover.appendChild(badges);
    const count = document.createElement('span'); count.className = 'card-count'; count.textContent = `${Number(item.count) || 0} 集`; cover.appendChild(count); const title = document.createElement('h3'); title.className = 'card-title'; title.textContent = normalizeText(item.title);
    const sub = document.createElement('div'); sub.className = 'card-subtitle'; sub.textContent = tags.map(normalizeText).filter(Boolean).join(' · ') || '剧集信息'; card.append(cover, title, sub);
    const open = () => openSeries(item.id); card.addEventListener('click', open); card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }); return card;
  }
  function renderCards(container, items, emptyNode) { container.replaceChildren(); items.forEach((item) => container.appendChild(makeCard(item))); emptyNode.hidden = items.length > 0 || state.isLoading; }
  function setCatalogLoading(loading, message = '') { state.isLoading = loading; els.searchStatus.textContent = message || (loading ? '正在加载…' : ''); els.searchStatus.hidden = !message && !loading; els.empty.hidden = loading || state.items.length > 0; }
  function positiveInt(value, fallback) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; }
  function errorMessage(error, fallback) { const message = error && typeof error.message === 'string' && error.message ? error.message : fallback; return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, ''); }
  function updatePagination() { els.pageSummary.textContent = `第 ${state.page} 页，共 ${state.totalPages} 页`; els.pageNumber.textContent = String(state.page); els.prev.disabled = state.page <= 1; els.next.disabled = state.page >= state.totalPages; }
  async function loadCatalog() {
    const token = ++state.catalogToken; hideError(); state.items = []; renderCards(els.grid, [], els.empty); setCatalogLoading(true, state.searchKeyword ? '正在全站搜索…' : '正在载入片库…'); updatePagination();
    try {
      let items, pages = 1;
      const response = await playerApi().catalog({ category: CATEGORY_KEYS[state.category], page: state.page, keyword: state.searchKeyword });
      if (token !== state.catalogToken) return;
      if (!response || !Array.isArray(response.items)) throw new Error('目录接口返回的数据格式无效。');
      items = response.items; state.page = positiveInt(response.page, state.page); pages = Math.max(1, positiveInt(response.totalPages, 1));
      if (token !== state.catalogToken) return; state.items = items; state.totalPages = pages; renderCards(els.grid, state.items, els.empty); setCatalogLoading(false, state.searchKeyword ? `全站搜索“${state.searchKeyword}” · 本页 ${items.length} 条结果` : ''); updatePagination();
    } catch (error) { if (token !== state.catalogToken) return; state.items = []; renderCards(els.grid, [], els.empty); setCatalogLoading(false, ''); showError(errorMessage(error, '片库加载失败。')); }
  }
  function activateView(view) { state.view = view; document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view)); els.discoverView.hidden = view !== 'discover'; els.listView.hidden = view !== 'favorites' && view !== 'recent'; els.aboutView.hidden = view !== 'about'; const titles = { discover: '发现好剧', favorites: '我的收藏', recent: '最近播放', about: '使用说明' }; els.heading.textContent = titles[view] || titles.discover; if (view === 'favorites' || view === 'recent') renderLocalList(view); }
  function renderLocalList(view) { const isFav = view === 'favorites', records = isFav ? favorites() : history(); els.listTitle.textContent = isFav ? '我的收藏' : '最近播放'; els.listEyebrow.textContent = isFav ? 'YOUR COLLECTION' : 'PICK UP WHERE YOU LEFT OFF'; els.listDesc.textContent = isFav ? '收藏的故事会保存在这台设备上。' : '最近播放记录与进度仅保存在本地。'; els.listEmptyTitle.textContent = isFav ? '还没有收藏' : '还没有播放记录'; els.listGrid.replaceChildren(); records.forEach((record) => { if (!record || record.id == null) return; els.listGrid.appendChild(makeCard({ id: record.id, title: record.title, cover: record.cover, count: record.count, tags: record.tags })); }); els.listEmpty.hidden = records.length > 0; }
  function updateFavoriteCount() { els.favoriteCount.textContent = String(favorites().length); }
  function hasFavorite(id) { return favorites().some((entry) => String(entry.id) === String(id)); }
  function seriesRecord(detail) { return { id: detail.id, title: normalizeText(detail.title), cover: safeCover(detail.cover), count: Array.isArray(detail.episodes) ? detail.episodes.length : 0, tags: Array.isArray(detail.tags) ? detail.tags.slice(0, 5).map(normalizeText) : [] }; }
  function setFavorite() { const detail = state.series; if (!detail || detail.id == null) return; let list = favorites(); const existed = hasFavorite(detail.id); list = existed ? list.filter((entry) => String(entry.id) !== String(detail.id)) : [seriesRecord(detail), ...list]; writeStore(STORAGE.favorites, capList(list)); updateFavoriteCount(); updateFavoriteButton(); if (state.view === 'favorites') renderLocalList('favorites'); toast(existed ? '已取消收藏' : '已加入收藏'); }
  function updateFavoriteButton() { const on = state.series && hasFavorite(state.series.id); els.favoriteButton.classList.toggle('is-favorite', Boolean(on)); els.favoriteButton.replaceChildren(); const heart = document.createElement('span'); heart.textContent = on ? '♥' : '♡'; els.favoriteButton.append(heart, document.createTextNode(on ? ' 已收藏' : ' 收藏')); }
  async function openSeries(id) {
    if (id == null || id === '') return; saveCurrentProgress(); const token = ++state.detailToken; state.playbackToken++; state.pendingMetadataToken = 0; stopAndClearVideo(); state.series = null; state.qualities = []; state.selectedQuality = ''; updateQualityOptions([]); clearDetailError(); els.detailTitle.textContent = '正在载入详情…'; els.detailIntro.textContent = ''; els.detailTags.replaceChildren(); els.episodes.replaceChildren(); els.episodeCount.textContent = ''; els.placeholderText.textContent = '正在载入剧集详情…'; els.backdrop.hidden = false; document.body.classList.add('modal-open');
    try { const detail = await playerApi().detail(id); if (token !== state.detailToken) return; if (!detail || !Array.isArray(detail.episodes)) throw new Error('剧集详情数据格式无效。'); state.series = detail; els.detailTitle.textContent = normalizeText(detail.title) || '未命名剧集'; els.detailIntro.textContent = normalizeText(detail.intro); if (Array.isArray(detail.tags)) detail.tags.slice(0, 8).forEach((tag) => addTag(els.detailTags, tag)); els.episodeCount.textContent = `${detail.episodes.length} 集`; updateFavoriteButton(); renderEpisodes(detail); els.placeholderText.textContent = '选择可尝试播放的集数开始观看'; }
    catch (error) { if (token === state.detailToken) showDetailError(errorMessage(error, '剧集详情加载失败。')); }
  }
  function renderEpisodes(detail) { els.episodes.replaceChildren(); detail.episodes.forEach((episode, index) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'episode-button'; button.textContent = `第 ${Number(episode.index) || index + 1} 集`; const playable = episode.available === true; if (!playable) button.classList.add('is-unavailable'); button.setAttribute('aria-disabled', String(!playable)); button.title = playable ? '此集可尝试播放' : '此集当前不可尝试播放'; if (index === state.episodeIndex) button.classList.add('is-current'); button.addEventListener('click', () => { if (episode.available !== true) { showDetailError('此集当前不可尝试播放。'); return; } playEpisode(detail, index); }); els.episodes.appendChild(button); }); }
  function stopAndClearVideo() { window.clearInterval(state.progressTimer); state.progressTimer = 0; state.pendingMetadataToken = 0; state.activeMediaUrl = ''; els.video.pause(); els.video.removeAttribute('src'); els.video.load(); els.placeholder.hidden = false; state.episodeIndex = -1; state.qualities = []; state.selectedQuality = ''; state.lastPlay = null; updateQualityOptions([]); }
  function validMediaUrl(value) {
    if (typeof value !== 'string') return '';
    const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/media\/([a-fA-F0-9]{64})\/(\d{6,30})\/(\d{6,30})\/(auto|(?:360|480|540|576|720|1080|1440|2160)P)(?:\/compat)?$/.exec(value);
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return '';
    return value;
  }
  function updateQualityOptions(qualities) { els.quality.replaceChildren(); const list = Array.isArray(qualities) && qualities.length ? [{ key: 'auto', label: '自动' }, ...qualities] : []; if (!list.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '清晰度由引擎选择'; els.quality.appendChild(option); els.quality.disabled = true; return; } list.forEach((q) => { if (!q || typeof q.key !== 'string') return; const option = document.createElement('option'); option.value = q.key; option.textContent = normalizeText(q.label) || q.key; els.quality.appendChild(option); }); els.quality.disabled = els.quality.options.length === 0; if (state.selectedQuality && Array.from(els.quality.options).some((option) => option.value === state.selectedQuality)) els.quality.value = state.selectedQuality; else if (!els.quality.disabled) { state.selectedQuality = els.quality.value; } }
  async function playEpisode(detail, index, options = {}) {
    const episode = detail && detail.episodes[index]; if (!episode) { showDetailError('集数信息已变化，请重新选择。'); return; } if (episode.available !== true) { showDetailError('此集当前不可尝试播放。'); return; }
    saveCurrentProgress(); window.clearInterval(state.progressTimer); state.progressTimer = 0; state.playbackToken++; const token = state.playbackToken; state.pendingMetadataToken = 0; state.activeMediaUrl = ''; els.video.pause(); els.video.removeAttribute('src'); els.video.load(); state.episodeIndex = index; clearDetailError(); state.lastPlay = { seriesId: detail.id, episodeId: episode.id, index }; setEpisodeSelection(index); els.placeholder.hidden = false; els.placeholderText.textContent = options.fresh ? '正在重新获取播放地址…' : ($('compat-mode').checked ? '正在缓存并转换兼容视频，首次载入可能需要几十秒…' : '正在获取播放地址…'); els.retry.disabled = true;
    try {
      const request = { seriesId: detail.id, episodeId: episode.id, compat: $('compat-mode').checked }; const selected = options.quality || state.selectedQuality; if (selected) request.quality = selected; if (options.fresh) request.fresh = true;
      const result = await playerApi().play(request); if (token !== state.playbackToken || state.series !== detail) return;
      const url = validMediaUrl(result && result.url); if (!url) throw new Error('播放接口返回了不符合本地媒体地址规范的 URL。');
      state.qualities = Array.isArray(result.qualities) ? result.qualities : []; state.selectedQuality = result.quality || selected || ''; updateQualityOptions(state.qualities); if (result.quality && els.quality.options.length && Array.from(els.quality.options).some((o) => o.value === result.quality)) els.quality.value = result.quality;
      state.activeMediaUrl = url; state.pendingMetadataToken = token; els.video.src = url; els.video.playbackRate = Number($('playback-rate').value) || 1; els.placeholderText.textContent = '正在载入媒体…'; els.placeholder.hidden = false;
      updateHistory(detail, episode); window.clearInterval(state.progressTimer); state.progressTimer = window.setInterval(saveCurrentProgress, 5000); setEpisodeSelection(index);
    } catch (error) { if (token !== state.playbackToken) return; showDetailError(errorMessage(error, '播放请求失败，可尝试重新获取地址。')); els.placeholderText.textContent = '播放失败，请检查后重试'; els.placeholder.hidden = false; }
    finally { if (token === state.playbackToken) els.retry.disabled = false; }
  }
  function handlePlaybackProgress(status) {
    if (!status || !state.lastPlay || els.backdrop.hidden || !els.retry.disabled || !$('compat-mode').checked || String(status.episodeId) !== String(state.lastPlay.episodeId)) return;
    const requested = state.selectedQuality && state.selectedQuality !== 'auto' ? state.selectedQuality : '720P';
    if (status.quality !== requested) return;
    if (status.stage === 'source') els.placeholderText.textContent = '正在获取片源…';
    else if (status.stage === 'download') els.placeholderText.textContent = `正在缓存视频 ${Math.max(0, Math.min(100, Number(status.percent) || 0)).toFixed(0)}%…`;
    else if (status.stage === 'convert') els.placeholderText.textContent = `正在转换兼容视频，已用 ${Math.max(0, Math.floor(Number(status.elapsedSeconds) || 0))} 秒；较慢设备请耐心等待…`;
    else if (status.stage === 'ready') els.placeholderText.textContent = '视频已就绪，正在启动播放…';
  }
  function handleLoadedMetadata() { const token = state.pendingMetadataToken; if (!token || token !== state.playbackToken || els.video.currentSrc !== state.activeMediaUrl) return; state.pendingMetadataToken = 0; const detail = state.series, index = state.episodeIndex; if (!detail || !detail.episodes[index]) return; const key = progressKey(detail.id, detail.episodes[index].id), saved = progressMap()[key], duration = Number(els.video.duration) || 0; if (saved && Number(saved.time) > 0 && (!duration || Number(saved.time) < duration - 2)) { try { els.video.currentTime = Number(saved.time); toast('已从上次进度继续播放'); } catch (_) {} } els.placeholder.hidden = true; els.video.play().catch(() => { if (token === state.playbackToken) showDetailError('片源已载入，请点击播放器播放按钮。'); }); }
  function handleMediaError() { const token = state.playbackToken; if (token && state.activeMediaUrl && els.video.currentSrc === state.activeMediaUrl && (state.pendingMetadataToken === token || state.lastPlay)) { state.pendingMetadataToken = 0; if (!els.backdrop.hidden) { showDetailError('媒体加载失败，片源可能暂时不可用；可尝试“重新获取”。'); els.placeholderText.textContent = '媒体暂不可用'; els.placeholder.hidden = false; } } }
  function setEpisodeSelection(index) { Array.from(els.episodes.children).forEach((button, i) => button.classList.toggle('is-current', i === index)); }
  function progressKey(seriesId, episodeId) { return `${String(seriesId)}::${String(episodeId)}`; }
  function saveCurrentProgress() { const detail = state.series, index = state.episodeIndex; if (!detail || index < 0 || !detail.episodes[index] || !state.activeMediaUrl || els.video.currentSrc !== state.activeMediaUrl) return; const time = Number(els.video.currentTime); if (!Number.isFinite(time) || time <= 0) return; const map = progressMap(), key = progressKey(detail.id, detail.episodes[index].id); map[key] = { time, updatedAt: Date.now() }; const sorted = Object.entries(map).sort((a, b) => Number(b[1] && b[1].updatedAt || 0) - Number(a[1] && a[1].updatedAt || 0)).slice(0, LIMIT); writeStore(STORAGE.progress, Object.fromEntries(sorted)); }
  function updateHistory(detail, episode) { const record = seriesRecord(detail); record.episodeId = episode.id; record.episodeIndex = episode.index; record.updatedAt = Date.now(); const list = history().filter((entry) => String(entry.id) !== String(detail.id)); list.unshift(record); writeStore(STORAGE.history, capList(list)); if (state.view === 'recent') renderLocalList('recent'); }
  async function changeEpisode(delta) { const detail = state.series; if (!detail || state.episodeIndex < 0) return; let index = state.episodeIndex + delta; while (index >= 0 && index < detail.episodes.length) { if (detail.episodes[index].available === true) { await playEpisode(detail, index); return; } index += delta; } showDetailError('前后没有可尝试播放的集数。'); }
  async function onSearch(event) { event.preventDefault(); const keyword = els.filter.value.trim(); state.searchKeyword = keyword; state.page = 1; if (keyword) activateView('discover'); await loadCatalog(); }
  async function onQuickOpen(event) { event.preventDefault(); hideError(); const raw = $('quick-open-input').value.trim(); if (!raw) { showError('请输入剧集 ID。'); return; } if (/^https?:\/\//i.test(raw)) { let u; try { u = new URL(raw); } catch (_) { showError('链接格式无效。'); return; } if (u.protocol !== 'https:' || u.hostname !== 'hongguoduanju.com' || u.username || u.password) { showError('仅支持红果官网 HTTPS 剧集链接。'); return; } const sid = u.searchParams.get('series_id') || u.pathname.match(/^\/player\/(\d{6,30})(?:\/|$)/)?.[1]; if (!sid || !/^\d{6,30}$/.test(sid)) { showError('链接中未找到剧集编号。'); return; } await openSeries(sid); return; } if (/\s/.test(raw) || raw.length > 200) { showError('剧集 ID 格式无效。'); return; } await openSeries(raw); }

  document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => activateView(button.dataset.view)));
  document.querySelectorAll('.category-tab').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('.category-tab').forEach((tab) => { const selected = tab === button; tab.classList.toggle('is-selected', selected); tab.setAttribute('aria-selected', String(selected)); }); state.category = button.dataset.category; state.searchKeyword = ''; els.filter.value = ''; state.page = 1; activateView('discover'); loadCatalog(); }));
  $('quick-open-form').addEventListener('submit', onQuickOpen); els.searchForm.addEventListener('submit', onSearch);
  els.prev.addEventListener('click', () => { if (state.page > 1) { state.page--; loadCatalog(); } }); els.next.addEventListener('click', () => { if (state.page < state.totalPages) { state.page++; loadCatalog(); } });
  $('browse-button').addEventListener('click', () => document.querySelector('.catalog-section').scrollIntoView({ behavior: 'smooth' })); $('dismiss-error').addEventListener('click', hideError);
  $('close-detail').addEventListener('click', () => { saveCurrentProgress(); state.detailToken++; state.playbackToken++; state.pendingMetadataToken = 0; stopAndClearVideo(); state.series = null; clearDetailError(); els.backdrop.hidden = true; document.body.classList.remove('modal-open'); });
  els.backdrop.addEventListener('click', (event) => { if (event.target === els.backdrop) $('close-detail').click(); }); $('previous-episode').addEventListener('click', () => changeEpisode(-1)); $('next-episode').addEventListener('click', () => changeEpisode(1));
  $('playback-rate').addEventListener('change', (event) => { els.video.playbackRate = Number(event.target.value) || 1; }); els.favoriteButton.addEventListener('click', setFavorite);
  els.quality.addEventListener('change', () => { state.selectedQuality = els.quality.value; if (state.series && state.episodeIndex >= 0) playEpisode(state.series, state.episodeIndex, { quality: state.selectedQuality }); });
  $('compat-mode').addEventListener('change', () => { if (state.series && state.episodeIndex >= 0) playEpisode(state.series, state.episodeIndex); });
  els.retry.addEventListener('click', () => { if (state.series && state.episodeIndex >= 0) playEpisode(state.series, state.episodeIndex, { fresh: true, quality: state.selectedQuality }); });
  els.video.addEventListener('loadedmetadata', handleLoadedMetadata); els.video.addEventListener('error', handleMediaError); els.video.addEventListener('timeupdate', () => { if (Math.floor(els.video.currentTime) % 10 === 0) saveCurrentProgress(); }); els.video.addEventListener('pause', saveCurrentProgress); els.video.addEventListener('ended', () => { saveCurrentProgress(); if (!$('auto-next').checked) return; changeEpisode(1); });
  $('detail-backdrop').addEventListener('keydown', (event) => { if (event.key === 'Escape') $('close-detail').click(); }); document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !els.backdrop.hidden) $('close-detail').click(); });
  if (window.player && typeof window.player.onProgress === 'function') window.player.onProgress(handlePlaybackProgress);
  updateFavoriteCount(); updatePagination(); loadCatalog();
})();
