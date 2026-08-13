/* ==========================================================================
   Video Gallery
   - 動画（Instagram / YouTube / TikTok / Vimeo / X）の URL を登録して一覧表示
   - データは localStorage。公開用は data/videos.json（シード）
   ========================================================================== */

'use strict';

const STORE_KEY = 'video-gallery:items:v1';
const PREF_KEY = 'video-gallery:prefs:v1';
const GH_KEY = 'video-gallery:github:v1'; // トークンを含む。書き出す JSON には絶対に混ぜない
const SEED_URL = 'data/videos.json';
const SYNC_DELAY = 2500; // 連続編集を 1 コミットにまとめる待ち時間

/* --------------------------------------------------------------------------
   プラットフォーム定義
   -------------------------------------------------------------------------- */

const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    color: ['#833ab4', '#fd1d1d'],
    ratio: '4 / 5',
    match(url) {
      const m = url.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
      if (!m) return null;
      const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
      return { id: m[2], kind };
    },
    embed(ref) {
      return `https://www.instagram.com/${ref.kind}/${ref.id}/embed/captioned/`;
    },
    canonical(ref) {
      return `https://www.instagram.com/${ref.kind}/${ref.id}/`;
    },
    thumb() { return ''; },
  },
  youtube: {
    label: 'YouTube',
    color: ['#ff0000', '#c4302b'],
    ratio: '16 / 9',
    match(url) {
      let m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i);
      if (m) return { id: m[1], kind: 'video' };
      m = url.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/i);
      if (m) return { id: m[1], kind: 'shorts' };
      return null;
    },
    embed(ref) { return `https://www.youtube-nocookie.com/embed/${ref.id}`; },
    canonical(ref) { return `https://www.youtube.com/watch?v=${ref.id}`; },
    thumb(ref) { return `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg`; },
  },
  tiktok: {
    label: 'TikTok',
    color: ['#25f4ee', '#fe2c55'],
    ratio: '9 / 16',
    match(url) {
      const m = url.match(/tiktok\.com\/(?:@[^/]+\/video\/|v\/)(\d+)/i);
      return m ? { id: m[1], kind: 'video' } : null;
    },
    embed(ref) { return `https://www.tiktok.com/embed/v2/${ref.id}`; },
    canonical(ref) { return `https://www.tiktok.com/video/${ref.id}`; },
    thumb() { return ''; },
  },
  vimeo: {
    label: 'Vimeo',
    color: ['#1ab7ea', '#0d7ea8'],
    ratio: '16 / 9',
    match(url) {
      const m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
      return m ? { id: m[1], kind: 'video' } : null;
    },
    embed(ref) { return `https://player.vimeo.com/video/${ref.id}`; },
    canonical(ref) { return `https://vimeo.com/${ref.id}`; },
    thumb() { return ''; },
  },
  x: {
    label: 'X / Twitter',
    color: ['#1d1f23', '#4a4f57'],
    ratio: '4 / 5',
    match(url) {
      const m = url.match(/(?:twitter|x)\.com\/([^/]+)\/status\/(\d+)/i);
      return m ? { id: m[2], kind: 'status', user: m[1] } : null;
    },
    // X は iframe 埋め込みに制限があるため、リンクカードとして扱う
    embed() { return ''; },
    canonical(ref) { return `https://x.com/${ref.user || 'i'}/status/${ref.id}`; },
    thumb() { return ''; },
  },
  other: {
    label: 'その他',
    color: ['#5b6472', '#39404b'],
    ratio: '16 / 9',
    match() { return null; },
    embed() { return ''; },
    canonical(ref) { return ref.raw; },
    thumb() { return ''; },
  },
};

/** URL からプラットフォームと ID を判定する。 */
function detect(url) {
  const raw = (url || '').trim();
  for (const key of ['instagram', 'youtube', 'tiktok', 'vimeo', 'x']) {
    const ref = PLATFORMS[key].match(raw);
    if (ref) return { platform: key, ref: { ...ref, raw } };
  }
  return { platform: 'other', ref: { id: '', kind: '', raw } };
}

function embedUrlOf(item) {
  const p = PLATFORMS[item.platform] || PLATFORMS.other;
  return p.embed(item.ref || { raw: item.url });
}

function ratioOf(item) {
  return (PLATFORMS[item.platform] || PLATFORMS.other).ratio;
}

/* --------------------------------------------------------------------------
   状態
   -------------------------------------------------------------------------- */

const state = {
  items: [],
  search: '',
  sort: 'manual',
  view: 'grid',
  favOnly: false,
  platform: '',
  tags: new Set(),
  selectMode: false,
  selected: new Set(),
  editingId: null,
  undo: null,
  randomSeed: 1,
  lightboxIds: [],
  lightboxIndex: 0,
};

const prefs = {
  theme: 'auto',
  view: 'grid',
  sort: 'manual',
  autoEmbed: false,
  showDesc: true,
};

/** GitHub 連携の設定。token はこのブラウザの localStorage にのみ置く。 */
const gh = {
  owner: '',
  repo: '',
  branch: 'main',
  path: 'data/videos.json',
  token: '',
  sha: null,      // 最後に読み書きした blob の SHA（更新時に必須）
  dirty: false,   // 未反映の変更があるか（リロードをまたいで保持する）
};

const sync = {
  status: 'idle', // idle | syncing | synced | error | conflict
  message: '',
  busy: false,
  timer: null,
  booting: true,
  remote: null,   // 競合時に取得した GitHub 側の内容
};

/* --------------------------------------------------------------------------
   ユーティリティ
   -------------------------------------------------------------------------- */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function uid() {
  return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function parseTags(text) {
  return String(text || '')
    .split(/[,、\n]/)
    .map((t) => t.trim().replace(/^#/, ''))
    .filter(Boolean)
    .filter((t, i, a) => a.indexOf(t) === i)
    .slice(0, 20);
}

/* --------------------------------------------------------------------------
   永続化
   -------------------------------------------------------------------------- */

function loadPrefs() {
  try {
    Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}'));
  } catch { /* 壊れていたら既定値のまま */ }
  state.view = prefs.view || 'grid';
  state.sort = prefs.sort || 'manual';
}

function savePrefs() {
  prefs.view = state.view;
  prefs.sort = state.sort;
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 容量超過は無視 */ }
}

/** localStorage にだけ書く（GitHub へは送らない）。 */
function saveLocal() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: 1, items: state.items }));
  } catch {
    toast('保存に失敗しました（ブラウザの容量制限の可能性）');
  }
}

/** 通常の保存。GitHub 連携中なら反映も予約する。 */
function save() {
  saveLocal();
  if (sync.booting || !ghReady()) return;
  gh.dirty = true;
  saveGh();
  scheduleSync();
  renderSync();
}

/* --------------------------------------------------------------------------
   GitHub 連携
   Contents API で data/videos.json を直接コミットする。
   ブラウザから api.github.com を叩く（CORS 許可済み）。
   -------------------------------------------------------------------------- */

function ghReady() {
  return Boolean(gh.owner && gh.repo && gh.token);
}

function loadGh() {
  try {
    Object.assign(gh, JSON.parse(localStorage.getItem(GH_KEY) || '{}'));
  } catch { /* 壊れていたら未設定として扱う */ }
}

function saveGh() {
  try { localStorage.setItem(GH_KEY, JSON.stringify(gh)); } catch { /* noop */ }
}

/** UTF-8 を安全に base64 化する（btoa は Latin-1 しか受け付けない）。 */
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** GitHub が返す base64 は改行入りなので、空白を落としてからデコードする。 */
function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function ghUrl() {
  const path = gh.path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/${path}`;
}

function ghHeaders() {
  return {
    'Authorization': `Bearer ${gh.token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function ghErrorMessage(status) {
  switch (status) {
    case 401: return 'トークンが無効か、期限が切れています';
    case 403: return 'アクセスが拒否されました（トークンの権限、またはレート制限）';
    case 404: return 'リポジトリまたはファイルが見つかりません（トークンの対象リポジトリを確認）';
    case 409:
    case 422: return 'GitHub 側が更新されているため反映できません';
    default: return `GitHub からエラーが返りました（HTTP ${status}）`;
  }
}

/** 現在のファイルを取得する。存在しなければ null。 */
async function ghFetchFile() {
  const url = `${ghUrl()}?ref=${encodeURIComponent(gh.branch || 'main')}&t=${Date.now()}`;
  const res = await fetch(url, { headers: ghHeaders(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(ghErrorMessage(res.status));

  const body = await res.json();
  if (!body.content && body.size > 0) {
    throw new Error('ファイルが大きすぎて Contents API で読めません（1MB 超）');
  }
  return { sha: body.sha, text: body.content ? fromBase64(body.content) : '' };
}

async function ghPutFile(text, sha, message) {
  const res = await fetch(ghUrl(), {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: toBase64(text),
      branch: gh.branch || 'main',
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.status === 409 || res.status === 422) return { conflict: true };
  if (!res.ok) throw new Error(ghErrorMessage(res.status));

  const body = await res.json();
  return { sha: body.content?.sha || null };
}

function parseItemsJson(text) {
  if (!text.trim()) return [];
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.items;
  return Array.isArray(list) ? list.map(normalize) : [];
}

/** GitHub の内容をこの端末に取り込む。 */
async function pullFromGitHub({ silent = false } = {}) {
  if (!ghReady()) return false;
  setSync('syncing', 'GitHub から読み込み中…');
  try {
    const file = await ghFetchFile();
    if (!file) {
      setSync('synced', 'GitHub にはまだファイルがありません');
      gh.sha = null;
      saveGh();
      return true;
    }
    state.items = parseItemsJson(file.text);
    gh.sha = file.sha;
    gh.dirty = false;
    sync.remote = null;
    saveGh();
    saveLocal();
    render();
    setSync('synced', '');
    if (!silent) toast(`GitHub から ${state.items.length}件を読み込みました`);
    return true;
  } catch (e) {
    setSync('error', e.message);
    if (!silent) toast(`読み込み失敗：${e.message}`);
    return false;
  }
}

/** この端末の内容を GitHub にコミットする。 */
async function pushToGitHub({ force = false, silent = false } = {}) {
  if (!ghReady() || sync.busy) return false;
  if (!force && !gh.dirty) { setSync('synced', ''); return true; }

  clearTimeout(sync.timer);
  sync.busy = true;
  setSync('syncing', 'GitHub に反映中…');

  const payload = exportPayload();
  const message = `動画一覧を更新（${state.items.length}件）`;

  try {
    let result = await ghPutFile(payload, gh.sha, message);

    if (result.conflict) {
      // SHA がずれている。GitHub 側が実際に変わったのか確認する。
      const remote = await ghFetchFile();
      const remoteItems = remote ? parseItemsJson(remote.text) : [];
      const changedElsewhere = remote && !sameItems(remoteItems, state.items) && !force;

      if (changedElsewhere) {
        sync.remote = { items: remoteItems, sha: remote.sha };
        sync.busy = false;
        setSync('conflict', 'GitHub 側が更新されています');
        if (!silent) {
          toast('GitHub 側が更新されています', '確認する', () => openGhDialog());
        }
        return false;
      }
      // 中身は同じ（または明示的な上書き）なので、新しい SHA で送り直す
      result = await ghPutFile(payload, remote ? remote.sha : null, message);
      if (result.conflict) throw new Error('反映できませんでした。もう一度お試しください');
    }

    gh.sha = result.sha;
    gh.dirty = false;
    sync.remote = null;
    saveGh();
    setSync('synced', '');
    if (!silent) toast('GitHub に反映しました');
    return true;
  } catch (e) {
    setSync('error', e.message);
    if (!silent) toast(`反映失敗：${e.message}`);
    return false;
  } finally {
    sync.busy = false;
    renderSync();
  }
}

/** 反映すべき差分があるかの判定（順序も含めて比較する）。 */
function sameItems(a, b) {
  const key = (list) => JSON.stringify(
    list.slice().sort((x, y) => x.order - y.order)
      .map(({ ref, updatedAt, ...rest }) => rest),
  );
  return key(a) === key(b);
}

function scheduleSync() {
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => pushToGitHub({ silent: true }), SYNC_DELAY);
}

function setSync(status, message) {
  sync.status = status;
  sync.message = message || '';
  renderSync();
}

function renderSync() {
  const btn = $('#syncBtn');
  if (!btn) return;

  btn.hidden = !ghReady();
  if (!ghReady()) return;

  const label = {
    idle: gh.dirty ? '未反映' : '同期',
    syncing: '反映中…',
    synced: '同期済み',
    error: 'エラー',
    conflict: '要確認',
  }[sync.status] || '同期';

  const icon = {
    idle: gh.dirty ? '●' : '✓',
    syncing: '⟳',
    synced: '✓',
    error: '!',
    conflict: '!',
  }[sync.status] || '✓';

  btn.dataset.state = sync.status === 'idle' && gh.dirty ? 'dirty' : sync.status;
  btn.innerHTML = `<span class="sync-icon">${icon}</span><span class="sync-label">${label}</span>`;
  btn.title = sync.message || `${gh.owner}/${gh.repo} の ${gh.path}`;
}

/** 保存形式・シード形式の両方を受け取って正規化する。 */
function normalize(raw, index) {
  const url = String(raw.url || '').trim();
  const det = detect(url);
  const now = new Date().toISOString();
  return {
    id: raw.id || uid(),
    url,
    platform: raw.platform && PLATFORMS[raw.platform] ? raw.platform : det.platform,
    ref: det.ref,
    title: String(raw.title || '').trim(),
    description: String(raw.description || '').trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : parseTags(raw.tags),
    thumbnail: String(raw.thumbnail || '').trim(),
    favorite: Boolean(raw.favorite),
    rating: Math.max(0, Math.min(5, Number(raw.rating) || 0)),
    publishedAt: String(raw.publishedAt || '').slice(0, 10),
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || now,
    order: Number.isFinite(raw.order) ? raw.order : index,
  };
}

async function boot() {
  loadPrefs();
  loadGh();
  applyTheme();

  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { /* noop */ }

  if (stored && Array.isArray(stored.items)) {
    state.items = stored.items.map(normalize);
  } else {
    state.items = await loadSeed();
    saveLocal();
  }

  bindEvents();
  syncControls();
  render();
  renderSync();

  sync.booting = false;

  if (ghReady()) {
    if (gh.dirty) {
      // 前回の編集が未反映のまま閉じられている。GitHub の内容で上書きせず、送る。
      setSync('idle', '未反映の変更があります');
      pushToGitHub({ silent: true });
    } else {
      pullFromGitHub({ silent: true });
    }
  }
}

async function loadSeed() {
  try {
    const res = await fetch(SEED_URL, { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.items;
    return Array.isArray(list) ? list.map(normalize) : [];
  } catch {
    return []; // file:// で開いた場合など
  }
}

/* --------------------------------------------------------------------------
   絞り込み・並び替え
   -------------------------------------------------------------------------- */

function visibleItems() {
  const q = state.search.trim().toLowerCase();
  let list = state.items.filter((it) => {
    if (state.favOnly && !it.favorite) return false;
    if (state.platform && it.platform !== state.platform) return false;
    if (state.tags.size && !Array.from(state.tags).every((t) => it.tags.includes(t))) return false;
    if (q) {
      const hay = `${it.title} ${it.description} ${it.tags.join(' ')} ${it.url}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const byText = (a, b) => (a || '').localeCompare(b || '', 'ja');
  const sorters = {
    'manual': (a, b) => a.order - b.order,
    'added-desc': (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
    'added-asc': (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
    'published-desc': (a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''),
    'published-asc': (a, b) => (a.publishedAt || '￿').localeCompare(b.publishedAt || '￿'),
    'title-asc': (a, b) => byText(a.title || a.url, b.title || b.url),
    'title-desc': (a, b) => byText(b.title || b.url, a.title || a.url),
    'rating-desc': (a, b) => b.rating - a.rating || a.order - b.order,
  };

  if (state.sort === 'random') {
    let seed = state.randomSeed;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    list = list.map((it) => ({ it, k: rnd() })).sort((a, b) => a.k - b.k).map((x) => x.it);
  } else {
    list.sort(sorters[state.sort] || sorters.manual);
  }
  return list;
}

/* --------------------------------------------------------------------------
   描画
   -------------------------------------------------------------------------- */

function render() {
  const list = visibleItems();
  const gallery = $('#gallery');

  gallery.className = `gallery view-${state.view}`;
  gallery.innerHTML = list.map(cardHtml).join('');

  $('#emptyState').hidden = state.items.length > 0;
  $('#noResult').hidden = !(state.items.length > 0 && list.length === 0);
  gallery.hidden = list.length === 0;

  renderStats();
  renderTagRow();
  renderPlatformFilter();
  renderBulkbar();

  if (prefs.autoEmbed) {
    gallery.querySelectorAll('.card-media[data-embed]').forEach((el) => mountEmbed(el));
  }
}

function renderStats() {
  const total = state.items.length;
  const fav = state.items.filter((i) => i.favorite).length;
  const tags = new Set(state.items.flatMap((i) => i.tags)).size;
  const shown = visibleItems().length;
  const filtered = shown !== total ? `${shown} / ` : '';
  $('#stats').textContent = total === 0
    ? '動画を追加してください'
    : `${filtered}${total} 本 ・ ★${fav} ・ タグ ${tags}`;
}

function tagCounts() {
  const map = new Map();
  state.items.forEach((it) => it.tags.forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
}

function renderTagRow() {
  const row = $('#tagRow');
  const counts = tagCounts();
  row.hidden = counts.length === 0;
  row.innerHTML = counts.map(([tag, n]) => `
    <button type="button" class="chip" data-tag="${escapeHtml(tag)}"
      aria-pressed="${state.tags.has(tag)}">#${escapeHtml(tag)}<span class="n">${n}</span></button>
  `).join('');

  const dl = $('#tagSuggest');
  dl.innerHTML = counts.map(([tag]) => `<option value="${escapeHtml(tag)}">`).join('');
}

function renderPlatformFilter() {
  const sel = $('#platformFilter');
  const used = Array.from(new Set(state.items.map((i) => i.platform)));
  const current = state.platform;
  sel.innerHTML = '<option value="">すべての種類</option>' + used.map((p) => {
    const n = state.items.filter((i) => i.platform === p).length;
    return `<option value="${p}">${escapeHtml(PLATFORMS[p]?.label || p)}（${n}）</option>`;
  }).join('');
  sel.value = current;
}

function renderBulkbar() {
  const bar = $('#bulkbar');
  bar.hidden = !state.selectMode;
  $('#bulkCount').textContent = `${state.selected.size}件を選択中`;
}

function cardHtml(item) {
  const p = PLATFORMS[item.platform] || PLATFORMS.other;
  const embed = embedUrlOf(item);
  const thumb = item.thumbnail || p.thumb(item.ref || {});
  const link = p.canonical(item.ref || { raw: item.url }) || item.url;
  const title = item.title || '(タイトル未設定)';
  const stars = item.rating ? '★'.repeat(item.rating) : '';

  const media = thumb
    ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="placeholder" style="--ph-a:${p.color[0]};--ph-b:${p.color[1]}">
         <div><span>${item.platform === 'instagram' ? '📸' : '🎬'}</span>${escapeHtml(title).slice(0, 40)}</div>
       </div>`;

  const playable = Boolean(embed);

  return `
  <article class="card${state.selected.has(item.id) ? ' is-selected' : ''}" data-id="${item.id}"
      ${state.sort === 'manual' && !state.selectMode ? 'draggable="true"' : ''}>
    ${state.selectMode ? `<input type="checkbox" class="card-check" data-act="select" ${state.selected.has(item.id) ? 'checked' : ''} aria-label="選択">` : ''}
    <div class="card-media" style="--ratio:${p.ratio}" ${playable ? `data-embed="${escapeHtml(embed)}"` : ''}>
      ${media}
      <span class="badge-platform">${escapeHtml(p.label)}</span>
      ${playable
        ? `<button type="button" class="play-overlay" data-act="play" aria-label="再生"><span class="play-icon">▶</span></button>`
        : `<a class="play-overlay" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" aria-label="開く"><span class="play-icon">↗</span></a>`}
      ${state.sort === 'manual' && !state.selectMode ? '<button type="button" class="drag-handle" data-act="drag" aria-label="並び替え">⋮⋮</button>' : ''}
    </div>
    <div class="card-body">
      <h2 class="card-title">${escapeHtml(title)}</h2>
      ${prefs.showDesc && item.description ? `<p class="card-desc">${escapeHtml(item.description)}</p>` : ''}
      ${item.tags.length ? `<div class="card-tags">${item.tags.map((t) =>
        `<button type="button" class="card-tag" data-act="tag" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}</div>` : ''}
      <div class="card-meta">
        ${stars ? `<span class="card-rating">${stars}</span>` : ''}
        <span>${escapeHtml(formatDate(item.publishedAt) || formatDate(item.createdAt))}</span>
        <span class="card-actions">
          <button type="button" class="fav${item.favorite ? ' is-on' : ''}" data-act="fav" title="お気に入り">${item.favorite ? '★' : '☆'}</button>
          <button type="button" data-act="expand" title="拡大表示">⛶</button>
          <button type="button" data-act="share" title="リンクをコピー">🔗</button>
          <button type="button" data-act="edit" title="編集">✏️</button>
          <button type="button" data-act="delete" title="削除">🗑️</button>
        </span>
      </div>
    </div>
  </article>`;
}

/** サムネイルを iframe に差し替える。 */
function mountEmbed(mediaEl) {
  if (!mediaEl || mediaEl.dataset.mounted) return;
  const src = mediaEl.dataset.embed;
  if (!src) return;
  mediaEl.dataset.mounted = '1';
  mediaEl.classList.add('is-playing'); // 再生中はプラットフォーム本来の縦横比に戻す
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.loading = 'lazy';
  frame.allow = 'autoplay; clipboard-write; encrypted-media; picture-in-picture; fullscreen';
  frame.allowFullscreen = true;
  frame.referrerPolicy = 'no-referrer-when-downgrade';
  frame.title = '埋め込み動画';
  mediaEl.appendChild(frame);
  mediaEl.querySelector('.play-overlay')?.remove();
}

/* --------------------------------------------------------------------------
   CRUD
   -------------------------------------------------------------------------- */

function findItem(id) {
  return state.items.find((i) => i.id === id);
}

function nextOrder() {
  return state.items.length ? Math.max(...state.items.map((i) => i.order)) + 1 : 0;
}

function addItem(data) {
  const item = normalize({ ...data, order: nextOrder() }, state.items.length);
  state.items.push(item);
  return item;
}

function removeItems(ids) {
  const removed = state.items.filter((i) => ids.includes(i.id));
  const positions = removed.map((r) => state.items.indexOf(r));
  state.items = state.items.filter((i) => !ids.includes(i.id));
  state.undo = { items: removed, positions };
  save();
  render();
  toast(
    removed.length === 1 ? '1件を削除しました' : `${removed.length}件を削除しました`,
    '元に戻す',
    () => {
      state.undo.items.forEach((it, i) => state.items.splice(state.undo.positions[i], 0, it));
      state.undo = null;
      save();
      render();
    },
  );
}

function duplicateItem(id) {
  const src = findItem(id);
  if (!src) return;
  const copy = normalize({
    ...src,
    id: uid(),
    title: `${src.title || '(タイトル未設定)'} のコピー`,
    createdAt: new Date().toISOString(),
    order: src.order + 0.5,
  }, 0);
  state.items.push(copy);
  reindexOrder();
  save();
  render();
  toast('複製しました');
}

/** dragId のカードを targetId の直前／直後へ移動する（手動並び順）。 */
function reorder(dragId, targetId, after) {
  const ordered = state.items.slice().sort((a, b) => a.order - b.order);
  const from = ordered.findIndex((i) => i.id === dragId);
  if (from < 0) return;

  const [moved] = ordered.splice(from, 1);
  const target = ordered.findIndex((i) => i.id === targetId);
  if (target < 0) return;

  ordered.splice(target + (after ? 1 : 0), 0, moved);
  ordered.forEach((it, i) => { it.order = i; });
  save();
  render();
}

function reindexOrder() {
  state.items
    .slice()
    .sort((a, b) => a.order - b.order)
    .forEach((it, i) => { it.order = i; });
}

/* --------------------------------------------------------------------------
   ダイアログ（追加・編集）
   -------------------------------------------------------------------------- */

function openItemDialog(id) {
  state.editingId = id || null;
  const it = id ? findItem(id) : null;

  $('#dialogTitle').textContent = it ? '動画を編集' : '動画を追加';
  $('#fUrl').value = it?.url || '';
  $('#fTitle').value = it?.title || '';
  $('#fDesc').value = it?.description || '';
  $('#fTags').value = (it?.tags || []).join(', ');
  $('#fDate').value = it?.publishedAt || '';
  $('#fRating').value = String(it?.rating || 0);
  $('#fThumb').value = it?.thumbnail || '';
  $('#fFav').checked = Boolean(it?.favorite);
  $('#deleteBtn').hidden = !it;

  updateUrlHint();
  $('#itemDialog').showModal();
  setTimeout(() => $(it ? '#fTitle' : '#fUrl').focus(), 60);
}

function updateUrlHint() {
  const url = $('#fUrl').value.trim();
  const hint = $('#urlHint');
  const slot = $('#formPreview');
  slot.hidden = true;
  slot.innerHTML = '';

  if (!url) {
    hint.className = 'field-hint';
    hint.textContent = 'Instagram / YouTube / TikTok / Vimeo / X の URL';
    return;
  }

  const { platform, ref } = detect(url);
  const p = PLATFORMS[platform];

  const dup = state.items.find((i) => i.url === url && i.id !== state.editingId);
  if (dup) {
    hint.className = 'field-hint ng';
    hint.textContent = `⚠ 同じ URL が既に登録されています：${dup.title || '(タイトル未設定)'}`;
    return;
  }

  if (platform === 'other') {
    hint.className = 'field-hint ng';
    hint.textContent = '対応外の URL です。リンクカードとして登録されます。';
    return;
  }

  hint.className = 'field-hint ok';
  hint.textContent = `✓ ${p.label} として認識しました`;

  const embed = p.embed(ref);
  if (embed) {
    slot.hidden = false;
    slot.style.aspectRatio = p.ratio;
    slot.innerHTML = `<iframe src="${escapeHtml(embed)}" loading="lazy" title="プレビュー"
      allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  }
}

function submitItemForm(e) {
  e.preventDefault();
  const url = $('#fUrl').value.trim();
  if (!url) return;

  const data = {
    url,
    title: $('#fTitle').value.trim(),
    description: $('#fDesc').value.trim(),
    tags: parseTags($('#fTags').value),
    publishedAt: $('#fDate').value,
    rating: Number($('#fRating').value),
    thumbnail: $('#fThumb').value.trim(),
    favorite: $('#fFav').checked,
  };

  if (state.editingId) {
    const it = findItem(state.editingId);
    Object.assign(it, normalize({ ...it, ...data }, 0), { order: it.order, id: it.id, createdAt: it.createdAt });
    it.updatedAt = new Date().toISOString();
    toast('更新しました');
  } else {
    addItem(data);
    toast('追加しました');
  }

  save();
  render();
  $('#itemDialog').close();
}

/* --------------------------------------------------------------------------
   ライトボックス
   -------------------------------------------------------------------------- */

function openLightbox(id) {
  state.lightboxIds = visibleItems().map((i) => i.id);
  state.lightboxIndex = Math.max(0, state.lightboxIds.indexOf(id));
  paintLightbox();
  $('#lightbox').showModal();
}

function paintLightbox() {
  const id = state.lightboxIds[state.lightboxIndex];
  const it = findItem(id);
  if (!it) return;
  const p = PLATFORMS[it.platform] || PLATFORMS.other;
  const embed = embedUrlOf(it);
  const link = p.canonical(it.ref || { raw: it.url }) || it.url;

  $('#lightboxInner').innerHTML = embed
    ? `<iframe src="${escapeHtml(embed)}" style="--ratio:${p.ratio}" title="${escapeHtml(it.title || '動画')}"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`
    : `<p>このプラットフォームは埋め込みに対応していません。</p>`;

  $('#lightboxMeta').innerHTML = `
    <h3>${escapeHtml(it.title || '(タイトル未設定)')}</h3>
    ${it.description ? `<p>${escapeHtml(it.description)}</p>` : ''}
    <p><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">元の投稿を開く ↗</a>
       ・ ${state.lightboxIndex + 1} / ${state.lightboxIds.length}</p>`;

  const only = state.lightboxIds.length < 2;
  $('#lbPrev').hidden = only;
  $('#lbNext').hidden = only;
}

function moveLightbox(delta) {
  if (!state.lightboxIds.length) return;
  const n = state.lightboxIds.length;
  state.lightboxIndex = (state.lightboxIndex + delta + n) % n;
  paintLightbox();
}

/* --------------------------------------------------------------------------
   インポート / エクスポート
   -------------------------------------------------------------------------- */

function exportPayload() {
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    items: state.items
      .slice()
      .sort((a, b) => a.order - b.order)
      .map(({ ref, ...rest }) => rest),
  }, null, 2);
}

function exportJson() {
  const blob = new Blob([exportPayload()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'videos.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('videos.json を書き出しました');
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(exportPayload());
    toast('JSON をコピーしました');
  } catch {
    toast('コピーできませんでした');
  }
}

function importJson(text, mode) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    toast('JSON として読み込めませんでした');
    return;
  }
  const list = Array.isArray(data) ? data : data.items;
  if (!Array.isArray(list)) {
    toast('items が見つかりませんでした');
    return;
  }

  const incoming = list.map(normalize);
  if (mode === 'replace') {
    state.items = incoming;
  } else {
    const known = new Set(state.items.map((i) => i.url));
    const fresh = incoming.filter((i) => !known.has(i.url));
    fresh.forEach((i) => { i.order = nextOrder(); state.items.push(i); });
  }
  reindexOrder();
  save();
  render();
  toast(`${incoming.length}件を読み込みました`);
}

/* --------------------------------------------------------------------------
   GitHub 連携ダイアログ
   -------------------------------------------------------------------------- */

function openGhDialog() {
  // Pages で公開している場合は owner / repo を URL から推測して初期値にする
  const guess = guessRepoFromLocation();

  $('#ghOwner').value = gh.owner || guess.owner;
  $('#ghRepo').value = gh.repo || guess.repo;
  $('#ghBranch').value = gh.branch || 'main';
  $('#ghPath').value = gh.path || 'data/videos.json';
  $('#ghToken').value = gh.token;
  $('#ghDisconnect').hidden = !ghReady();

  $('#ghConflict').hidden = sync.status !== 'conflict' || !sync.remote;
  showGhStatus(sync.status === 'error' ? sync.message : '', sync.status === 'error' ? 'ng' : '');

  $('#ghDialog').showModal();
}

function guessRepoFromLocation() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  if (!m) return { owner: '', repo: '' };
  const seg = location.pathname.split('/').filter(Boolean)[0] || `${m[1]}.github.io`;
  return { owner: m[1], repo: seg };
}

function showGhStatus(text, kind) {
  const el = $('#ghStatus');
  el.hidden = !text;
  el.textContent = text;
  el.className = `gh-status${kind ? ` ${kind}` : ''}`;
}

function readGhForm() {
  return {
    owner: $('#ghOwner').value.trim(),
    repo: $('#ghRepo').value.trim().replace(/\.git$/, ''),
    branch: $('#ghBranch').value.trim() || 'main',
    path: $('#ghPath').value.trim().replace(/^\/+/, '') || 'data/videos.json',
    token: $('#ghToken').value.trim(),
  };
}

/* --------------------------------------------------------------------------
   トースト
   -------------------------------------------------------------------------- */

let toastTimer = null;
function toast(msg, actionLabel, onAction) {
  const el = $('#toast');
  const btn = $('#toastAction');
  $('#toastMsg').textContent = msg;
  el.hidden = false;

  if (actionLabel) {
    btn.hidden = false;
    btn.textContent = actionLabel;
    btn.onclick = () => { el.hidden = true; onAction?.(); };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 8000 : 2600);
}

/* --------------------------------------------------------------------------
   テーマ
   -------------------------------------------------------------------------- */

function applyTheme() {
  const dark = prefs.theme === 'dark'
    || (prefs.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#themeBtn').textContent = dark ? '☀️' : '🌙';
}

/* --------------------------------------------------------------------------
   コントロールの同期
   -------------------------------------------------------------------------- */

function syncControls() {
  $('#sort').value = state.sort;
  $('#optAutoEmbed').checked = prefs.autoEmbed;
  $('#optShowDesc').checked = prefs.showDesc;
  $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === state.view));
  $('#favFilter').setAttribute('aria-pressed', String(state.favOnly));
  $('#selectModeBtn').setAttribute('aria-pressed', String(state.selectMode));
}

/* --------------------------------------------------------------------------
   イベント
   -------------------------------------------------------------------------- */

function bindEvents() {
  /* --- ヘッダ / ツールバー --- */
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    prefs.theme = dark ? 'light' : 'dark';
    savePrefs();
    applyTheme();
  });

  $('#menuBtn').addEventListener('click', () => $('#menuDialog').showModal());
  $('#addBtn').addEventListener('click', () => openItemDialog());
  $('#fabAdd').addEventListener('click', () => openItemDialog());
  $('#emptyAddBtn').addEventListener('click', () => openItemDialog());

  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value;
    $('#searchClear').hidden = !state.search;
    render();
  });
  $('#searchClear').addEventListener('click', () => {
    state.search = '';
    $('#search').value = '';
    $('#searchClear').hidden = true;
    render();
  });

  $('#sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    if (state.sort === 'random') state.randomSeed = Date.now() % 100000;
    savePrefs();
    render();
  });

  $$('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    savePrefs();
    syncControls();
    render();
  }));

  $('#platformFilter').addEventListener('change', (e) => {
    state.platform = e.target.value;
    render();
  });

  $('#favFilter').addEventListener('click', (e) => {
    state.favOnly = !state.favOnly;
    e.currentTarget.setAttribute('aria-pressed', String(state.favOnly));
    render();
  });

  $('#selectModeBtn').addEventListener('click', () => toggleSelectMode());

  $('#tagRow').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tag]');
    if (!btn) return;
    toggleTag(btn.dataset.tag);
  });

  $('#resetFilterBtn').addEventListener('click', () => {
    state.search = '';
    $('#search').value = '';
    $('#searchClear').hidden = true;
    state.favOnly = false;
    state.platform = '';
    state.tags.clear();
    syncControls();
    render();
  });

  /* --- カード --- */
  const gallery = $('#gallery');

  gallery.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;

    if (state.selectMode && (!act || act === 'select')) {
      toggleSelected(id);
      return;
    }

    switch (act) {
      case 'play':
        mountEmbed(card.querySelector('.card-media'));
        break;
      case 'expand':
        openLightbox(id);
        break;
      case 'fav': {
        const it = findItem(id);
        it.favorite = !it.favorite;
        it.updatedAt = new Date().toISOString();
        save();
        render();
        break;
      }
      case 'share':
        shareItem(id);
        break;
      case 'edit':
        openItemDialog(id);
        break;
      case 'delete':
        removeItems([id]);
        break;
      case 'tag':
        toggleTag(actEl.dataset.tag);
        break;
      default:
        break;
    }
  });

  gallery.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card && !state.selectMode) openItemDialog(card.dataset.id);
  });

  /* --- ドラッグ並び替え（手動ソート時のみ） --- */
  let dragId = null;
  gallery.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card || state.sort !== 'manual') { e.preventDefault(); return; }
    dragId = card.dataset.id;
    card.classList.add('is-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  gallery.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest('.card');
    gallery.querySelectorAll('.drop-before, .drop-after').forEach((c) => c.classList.remove('drop-before', 'drop-after'));
    if (!card || card.dataset.id === dragId) return;
    const r = card.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });
  gallery.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest('.card');
    if (card && card.dataset.id !== dragId) {
      const r = card.getBoundingClientRect();
      const after = (e.clientX - r.left) > r.width / 2;
      reorder(dragId, card.dataset.id, after);
    }
    cleanupDrag();
  });
  gallery.addEventListener('dragend', cleanupDrag);

  function cleanupDrag() {
    dragId = null;
    gallery.querySelectorAll('.is-dragging, .drop-before, .drop-after')
      .forEach((c) => c.classList.remove('is-dragging', 'drop-before', 'drop-after'));
  }

  /* --- フォーム --- */
  $('#itemForm').addEventListener('submit', submitItemForm);
  $('#fUrl').addEventListener('input', debounce(updateUrlHint, 400));
  $('#fUrl').addEventListener('paste', () => setTimeout(updateUrlHint, 50));
  $('#deleteBtn').addEventListener('click', () => {
    const id = state.editingId;
    $('#itemDialog').close();
    if (id) removeItems([id]);
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  });

  $('#itemDialog').addEventListener('close', () => {
    $('#formPreview').innerHTML = '';
    state.editingId = null;
  });
  $('#lightbox').addEventListener('close', () => { $('#lightboxInner').innerHTML = ''; });

  /* --- 一括操作 --- */
  $('#bulkAll').addEventListener('click', () => {
    const list = visibleItems();
    const all = list.every((i) => state.selected.has(i.id));
    list.forEach((i) => (all ? state.selected.delete(i.id) : state.selected.add(i.id)));
    render();
  });
  $('#bulkFav').addEventListener('click', () => {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    const targets = ids.map(findItem).filter(Boolean);
    const allFav = targets.every((i) => i.favorite);
    targets.forEach((i) => { i.favorite = !allFav; });
    save();
    render();
  });
  $('#bulkTag').addEventListener('click', () => {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    const input = prompt('追加するタグ（カンマ区切り）');
    if (!input) return;
    const tags = parseTags(input);
    ids.map(findItem).filter(Boolean).forEach((it) => {
      it.tags = Array.from(new Set([...it.tags, ...tags])).slice(0, 20);
    });
    save();
    render();
    toast(`${ids.length}件にタグを追加しました`);
  });
  $('#bulkDelete').addEventListener('click', () => {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    state.selected.clear();
    removeItems(ids);
  });

  /* --- メニュー --- */
  $('#mBulkAdd').addEventListener('click', () => {
    $('#menuDialog').close();
    $('#bulkUrls').value = '';
    $('#bulkAddDialog').showModal();
  });
  $('#bulkAddRun').addEventListener('click', () => {
    const urls = $('#bulkUrls').value.split(/\s*\n\s*/).map((s) => s.trim()).filter(Boolean);
    const known = new Set(state.items.map((i) => i.url));
    let n = 0;
    urls.forEach((url) => {
      if (known.has(url)) return;
      addItem({ url });
      known.add(url);
      n += 1;
    });
    save();
    render();
    $('#bulkAddDialog').close();
    toast(n ? `${n}件を追加しました` : '追加できる URL がありませんでした');
  });

  $('#mExport').addEventListener('click', () => { $('#menuDialog').close(); exportJson(); });
  $('#mCopy').addEventListener('click', () => { $('#menuDialog').close(); copyJson(); });
  $('#mImport').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = '';
    $('#menuDialog').close();
    const mode = state.items.length && !confirm('現在のデータを置き換えますか？\n［キャンセル］を選ぶと追記します。')
      ? 'merge' : 'replace';
    importJson(text, mode);
  });

  $('#mSeed').addEventListener('click', async () => {
    if (!confirm('公開データ（data/videos.json）を読み込み直します。現在の変更は失われます。')) return;
    state.items = await loadSeed();
    save();
    render();
    $('#menuDialog').close();
    toast('公開データを再読み込みしました');
  });

  $('#mClear').addEventListener('click', () => {
    if (!state.items.length) return;
    if (!confirm(`${state.items.length}件をすべて削除します。よろしいですか？`)) return;
    removeItems(state.items.map((i) => i.id));
    $('#menuDialog').close();
  });

  $('#mHelp').addEventListener('click', () => { $('#menuDialog').close(); $('#helpDialog').showModal(); });

  /* --- GitHub 連携 --- */
  $('#syncBtn').addEventListener('click', () => {
    if (sync.status === 'conflict' || sync.status === 'error') { openGhDialog(); return; }
    pushToGitHub({ force: true });
  });

  $('#mGhSettings').addEventListener('click', () => { $('#menuDialog').close(); openGhDialog(); });
  $('#mGhPush').addEventListener('click', () => {
    $('#menuDialog').close();
    if (!ghReady()) { openGhDialog(); return; }
    pushToGitHub({ force: true });
  });
  $('#mGhPull').addEventListener('click', async () => {
    $('#menuDialog').close();
    if (!ghReady()) { openGhDialog(); return; }
    if (gh.dirty && !confirm('未反映の変更があります。GitHub の内容で置き換えますか？')) return;
    pullFromGitHub();
  });

  $('#ghShowToken').addEventListener('change', (e) => {
    $('#ghToken').type = e.target.checked ? 'text' : 'password';
  });

  $('#ghTest').addEventListener('click', async () => {
    const form = readGhForm();
    if (!form.owner || !form.repo || !form.token) {
      showGhStatus('オーナー・リポジトリ・トークンを入力してください', 'ng');
      return;
    }
    showGhStatus('確認中…', '');
    const backup = { ...gh };
    Object.assign(gh, form);
    try {
      const file = await ghFetchFile();
      showGhStatus(
        file
          ? `接続できました。GitHub 側に ${parseItemsJson(file.text).length}件あります。`
          : '接続できました。ファイルはまだ存在しないので、初回の反映時に作成します。',
        'ok',
      );
    } catch (e) {
      showGhStatus(e.message, 'ng');
    } finally {
      Object.assign(gh, backup);
    }
  });

  $('#ghSaveBtn').addEventListener('click', async () => {
    const form = readGhForm();
    if (!form.owner || !form.repo || !form.token) {
      showGhStatus('オーナー・リポジトリ・トークンを入力してください', 'ng');
      return;
    }
    const changedTarget = form.owner !== gh.owner || form.repo !== gh.repo
      || form.branch !== gh.branch || form.path !== gh.path;

    Object.assign(gh, form);
    if (changedTarget) gh.sha = null; // 参照先が変わったら SHA は無効
    saveGh();
    renderSync();

    showGhStatus('接続中…', '');
    let file;
    try {
      file = await ghFetchFile();
    } catch (e) {
      showGhStatus(e.message, 'ng');
      setSync('error', e.message);
      return;
    }

    const remoteItems = file ? parseItemsJson(file.text) : [];
    gh.sha = file ? file.sha : null;
    saveGh();

    // GitHub 側にデータがあり、この端末の内容と違うときだけ選ばせる
    if (remoteItems.length && !sameItems(remoteItems, state.items)) {
      const takeRemote = confirm(
        `GitHub 側に ${remoteItems.length}件、この端末に ${state.items.length}件あります。\n`
        + '［OK］GitHub 側を取り込む　／　［キャンセル］この端末の内容で上書きする',
      );
      if (takeRemote) {
        state.items = remoteItems;
        gh.dirty = false;
        saveGh();
        saveLocal();
        render();
        setSync('synced', '');
        $('#ghDialog').close();
        toast(`GitHub から ${remoteItems.length}件を読み込みました`);
        return;
      }
    }

    $('#ghDialog').close();
    gh.dirty = true;
    saveGh();
    await pushToGitHub({ force: true });
  });

  $('#ghTakeRemote').addEventListener('click', async () => {
    if (!sync.remote) return;
    state.items = sync.remote.items;
    gh.sha = sync.remote.sha;
    gh.dirty = false;
    sync.remote = null;
    saveGh();
    saveLocal();
    render();
    setSync('synced', '');
    $('#ghDialog').close();
    toast('GitHub 側の内容を取り込みました');
  });

  $('#ghTakeLocal').addEventListener('click', async () => {
    if (!sync.remote) return;
    gh.sha = sync.remote.sha;
    sync.remote = null;
    saveGh();
    $('#ghDialog').close();
    await pushToGitHub({ force: true });
  });

  $('#ghDisconnect').addEventListener('click', () => {
    if (!confirm('連携を解除し、この端末に保存したトークンを削除します。よろしいですか？')) return;
    clearTimeout(sync.timer);
    Object.assign(gh, { owner: '', repo: '', branch: 'main', path: 'data/videos.json', token: '', sha: null, dirty: false });
    try { localStorage.removeItem(GH_KEY); } catch { /* noop */ }
    sync.remote = null;
    setSync('idle', '');
    $('#ghDialog').close();
    toast('GitHub 連携を解除しました');
  });

  // 未反映のまま閉じようとしたら知らせる
  window.addEventListener('beforeunload', (e) => {
    if (ghReady() && gh.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  $('#optAutoEmbed').addEventListener('change', (e) => {
    prefs.autoEmbed = e.target.checked;
    savePrefs();
    render();
  });
  $('#optShowDesc').addEventListener('change', (e) => {
    prefs.showDesc = e.target.checked;
    savePrefs();
    render();
  });

  /* --- ライトボックス --- */
  $('#lbPrev').addEventListener('click', () => moveLightbox(-1));
  $('#lbNext').addEventListener('click', () => moveLightbox(1));

  /* --- キーボード --- */
  document.addEventListener('keydown', onKeydown);

  /* --- ドラッグ＆ドロップで JSON 読み込み --- */
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth += 1;
    $('#dropzone').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropzone').hidden = true;
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    $('#dropzone').hidden = true;
    const file = e.dataTransfer.files[0];
    if (!/\.json$/i.test(file.name)) { toast('JSON ファイルを指定してください'); return; }
    const mode = state.items.length && !confirm('現在のデータを置き換えますか？\n［キャンセル］を選ぶと追記します。')
      ? 'merge' : 'replace';
    importJson(await file.text(), mode);
  });

  /* --- OS のテーマ変更に追従 --- */
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (prefs.theme === 'auto') applyTheme();
  });
}

function onKeydown(e) {
  const lightbox = $('#lightbox');
  if (lightbox.open) {
    if (e.key === 'ArrowLeft') moveLightbox(-1);
    if (e.key === 'ArrowRight') moveLightbox(1);
    return;
  }

  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;

  switch (e.key) {
    case 'n': case 'N': e.preventDefault(); openItemDialog(); break;
    case '/': e.preventDefault(); $('#search').focus(); break;
    case 'g': case 'G': setView('grid'); break;
    case 'l': case 'L': setView('list'); break;
    case 'c': case 'C': setView('compact'); break;
    case 'f': case 'F': $('#favFilter').click(); break;
    case 's': case 'S': toggleSelectMode(); break;
    case '?': $('#helpDialog').showModal(); break;
    case 'Escape':
      if (state.selectMode) toggleSelectMode();
      break;
    default: break;
  }
}

function setView(view) {
  state.view = view;
  savePrefs();
  syncControls();
  render();
}

function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  state.selected.clear();
  syncControls();
  render();
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  render();
}

function toggleTag(tag) {
  if (state.tags.has(tag)) state.tags.delete(tag);
  else state.tags.add(tag);
  render();
}

async function shareItem(id) {
  const it = findItem(id);
  if (!it) return;
  const p = PLATFORMS[it.platform] || PLATFORMS.other;
  const url = p.canonical(it.ref || { raw: it.url }) || it.url;
  if (navigator.share) {
    try {
      await navigator.share({ title: it.title || 'Video', text: it.description || '', url });
      return;
    } catch { /* キャンセルまたは失敗 → コピーにフォールバック */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('リンクをコピーしました');
  } catch {
    toast('コピーできませんでした');
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* --------------------------------------------------------------------------
   起動
   -------------------------------------------------------------------------- */

boot();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* オフライン非対応でも動く */ });
  });
}
