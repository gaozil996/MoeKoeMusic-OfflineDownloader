(function () {
  'use strict';

  var P = '[OfflineDL]';
  var API_BASE = 'http://127.0.0.1:6521';
  var STORE_KEY = 'offline_dl_state';

  // Order matters and so do the tags. matchVariant returns the FIRST tag hit,
  // scanning variants in order, so "high" has to stay on the 320 row. The
  // API reports 320kbps mp3 as quality "high" -- putting that tag on Hi-Res
  // made Hi-Res resolve to a plain mp3 whenever a 320 variant was present.
  var QUALITIES = [
    { id: '128', label: '标准', tags: ['128', 'standard', 'mp3-128', 'sq'] },
    { id: '320', label: '高品', tags: ['320', 'mp3-320', 'hq'] },
    { id: 'flac', label: '无损', tags: ['flac', 'lossless', 'alac'] },
    { id: 'hires', label: 'Hi-Res', tags: ['high', 'hires', 'hi-res', 'highres', 'viper_tape', 'viper_clear', '24bit'] }
  ];

  function log() { console.log.apply(console, [P].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, [P].concat([].slice.call(arguments))); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var ui = { mode: 'single', quality: 'flac' };
  var batch = {
    listid: '',
    gcid: '',
    listName: '',
    playlistMap: {},
    songs: [],
    selected: {},
    saved: {},
    marking: false,
    shielded: 0,
    running: false,
    stopFlag: false,
    total: 0,
    done: 0,
    bytes: 0,
    fails: [],
    failHashes: [],
    blockedCount: 0,
    skipped: 0
  };

  function loadState() {
    try {
      // Failures survive a restart; without this the retry button would come
      // back empty every time the app relaunched.
      var fh = JSON.parse(localStorage.getItem('__odl_fail_hashes') || '[]');
      if (Array.isArray(fh) && fh.length) batch.failHashes = fh;
    } catch (e) {}
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.quality) ui.quality = o.quality;
        if (o && o.mode) ui.mode = o.mode;
      }
    } catch (e) {}
  }

  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ quality: ui.quality, mode: ui.mode })); } catch (e) {}
  }

  function getApiBase() {
    try {
      var s = JSON.parse(localStorage.getItem('settings') || '{}');
      var custom = (s.apiBaseUrl || '').toString().trim().replace(/\/+$/, '');
      if (custom && /^https?:\/\//.test(custom)) return custom;
    } catch (e) {}
    return API_BASE;
  }

  function getAuthHeaders() {
    try {
      var moe = JSON.parse(localStorage.getItem('MoeData') || '{}');
      var user = moe.UserInfo || {};
      var device = moe.Device || {};
      var parts = [];
      if (user.token) parts.push('token=' + user.token);
      if (user.userid) parts.push('userid=' + user.userid);
      if (device.dfid) parts.push('dfid=' + device.dfid);
      if (user.t1) parts.push('t1=' + user.t1);
      if (device.mid) parts.push('KUGOU_API_MID=' + device.mid);
      if (device.guid) parts.push('KUGOU_API_GUID=' + device.guid);
      if (device.serverDev) parts.push('KUGOU_API_DEV=' + device.serverDev);
      if (device.mac) parts.push('KUGOU_API_MAC=' + device.mac);
      return parts.length ? { Authorization: parts.join(';') } : {};
    } catch (e) { return {}; }
  }

  async function apiGet(path, params) {
    var url = new URL(path, getApiBase());
    params = params || {};
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') url.searchParams.set(k, params[k]);
    });
    var resp = await fetch(url.toString(), {
      method: 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders()),
      credentials: 'include'
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  function getCurrentSong() {
    try {
      var raw = localStorage.getItem('current_song');
      if (raw) {
        var s = JSON.parse(raw);
        if (s && (s.hash || s.playHash)) return s;
      }
    } catch (e) {}
    try {
      var mq = localStorage.getItem('MusicQueue');
      if (mq) {
        var d = JSON.parse(mq);
        if (d && d.queue && d.queue.length && (d.queue[0].hash || d.queue[0].playHash)) return d.queue[0];
      }
    } catch (e) {}
    return null;
  }

  function pick(obj, names) {
    if (!obj) return null;
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (v !== undefined && v !== null && v !== '' && typeof v !== 'object') return v;
    }
    return null;
  }

  function songInfo(song) {
    if (!song) return null;

    var artist = pick(song, ['author', 'artist', 'singer', 'authors', 'AuthorName']);
    if (!artist && Array.isArray(song.singerinfo)) {
      var names = song.singerinfo
        .map(function (x) { return x && (x.name || x.singer_name); })
        .filter(Boolean);
      if (names.length) artist = names.join('/');
    }
    if (!artist && song.singerinfo && song.singerinfo.name) artist = song.singerinfo.name;

    var album = pick(song, ['albumname', 'album', 'album_name', 'AlbumName']);
    if (!album && song.albuminfo && song.albuminfo.name) album = song.albuminfo.name;

    var goods = [];
    var src = Array.isArray(song.relate_goods) ? song.relate_goods
      : (song.relate_goods ? Object.values(song.relate_goods) : []);
    src.forEach(function (g) {
      if (!g || !g.hash) return;
      var br = Number(g.bitrate || g.bit_rate || 0);
      var qid = '128';
      if (br >= 1500) qid = 'hires';
      else if (br >= 800) qid = 'flac';
      else if (br >= 256) qid = '320';
      goods.push({ hash: g.hash, quality: qid, bitrate: br });
    });

    return {
      hash: pick(song, ['hash', 'playHash', 'FileHash', 'file_hash', '270hash', 'orig_hash']),
      title: pick(song, ['name', 'title', 'songname', 'filename', 'SongName', 'song_name']) || '未知歌曲',
      artist: artist || '未知歌手',
      album: album || '',
      img: pick(song, ['img', 'pic', 'cover', 'album_img', 'picture']),
      goods: goods
    };
  }

  function sanitize(s) {
    return String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function extFromUrl(url, fallback) {
    try {
      var p = new URL(url).pathname;
      var m = p.match(/\.([a-z0-9]{2,5})$/i);
      if (m) return m[1].toLowerCase();
    } catch (e) {}
    return fallback || 'mp3';
  }

  function extForQuality(q) {
    return (q === 'flac' || q === 'hires') ? 'flac' : 'mp3';
  }

  function resolveUrl(payload) {
    if (!payload) return null;
    if (typeof payload === 'string') return payload.trim() || null;
    if (Array.isArray(payload)) {
      for (var i = 0; i < payload.length; i++) {
        var r = resolveUrl(payload[i]);
        if (r) return r;
      }
      return null;
    }
    if (typeof payload === 'object') {
      var keys = ['url', 'play_url', 'playUrl', 'download_url', 'downloadUrl'];
      for (var k = 0; k < keys.length; k++) {
        if (payload[keys[k]] !== undefined) {
          var r2 = resolveUrl(payload[keys[k]]);
          if (r2) return r2;
        }
      }
      if (payload.data !== undefined) {
        var r3 = resolveUrl(payload.data);
        if (r3) return r3;
      }
      if (payload.info !== undefined) {
        var r4 = resolveUrl(payload.info);
        if (r4) return r4;
      }
    }
    return null;
  }

  function variantsFrom(priv) {
    var out = [];
    if (!priv || typeof priv !== 'object') return out;
    var src = priv.data !== undefined ? priv.data : priv;
    var list = Array.isArray(src) ? src : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      if (item.hash && item.quality) out.push({ hash: item.hash, quality: normQuality(item.quality) });
      var goods = item.relate_goods || item.relateGoods || [];
      if (goods && !Array.isArray(goods)) goods = Object.values(goods);
      for (var g = 0; g < goods.length; g++) {
        var gg = goods[g];
        if (gg && gg.hash && gg.quality) {
          out.push({ hash: gg.hash, quality: normQuality(gg.quality), bitrate: gg.bitrate || 0 });
        }
      }
    }
    return out;
  }

  // The API mixes bitrates ("128", 128), words ("standard", "high") and
  // product names ("viper_tape", "flac"). Fold them all to one vocabulary so
  // exact-match lookups behave predictably.
  function normQuality(q) {
    var s = String(q == null ? '' : q).trim().toLowerCase();
    if (!s) return '';
    if (s === '320' || s === 'mp3-320' || s === 'hq') return '320';
    if (s === '128' || s === 'standard' || s === 'mp3-128' || s === 'sq') return '128';
    if (s === 'flac' || s === 'lossless' || s === 'alac') return 'flac';
    if (s === 'high' || s === 'hires' || s === 'hi-res' || s === 'highres' ||
      s.indexOf('viper_tape') >= 0 || s.indexOf('viper_clear') >= 0 ||
      s.indexOf('24bit') >= 0) return 'high';
    return s;
  }

  // Pick the best available variant for a target quality.
  //
  // Variants arrive as ["128","128","320","flac","high","viper_atmos",...]
  // in no guaranteed order. LADDER runs from highest to lowest, so starting
  // at the requested tier and walking forward means asking for lossless on a
  // track that only ships 320 quietly degrades to 320 instead of failing.
  var LADDER = ['hires', 'flac', '320', '128'];

  function matchVariant(variants, qid) {
    if (!variants || !variants.length) return null;

    var start = LADDER.indexOf(qid);
    if (start < 0) start = LADDER.length - 1;

    for (var step = start; step < LADDER.length; step++) {
      var want = LADDER[step];
      var spec = null;
      for (var i = 0; i < QUALITIES.length; i++) {
        if (QUALITIES[i].id === want) spec = QUALITIES[i];
      }
      if (!spec) continue;

      for (var j = 0; j < variants.length; j++) {
        var v = variants[j];
        var q = normQuality(v.quality);
        for (var t = 0; t < spec.tags.length; t++) {
          if (q === normQuality(spec.tags[t])) return v;
        }
      }
    }
    return null;
  }

  var SAVE_DIR = 'D:\\MoeKoeMusic';

  function loadSaveDir() {
    try {
      var v = localStorage.getItem('odl_save_dir');
      if (v && v.trim()) return v.trim();
    } catch (e) {}
    return SAVE_DIR;
  }

  function saveDir() {
    return loadSaveDir();
  }

  var nhSeq = 0;

  var live = { on: false, received: 0, total: 0, percent: 0, name: '' };
  var nhDiag = [];

  chrome.runtime.onMessage.addListener(function (request) {
    if (!request) return;

    if (request.type === 'odl-nh-diag') {
      nhDiag = request.lines || [];
      renderDiag();
      return;
    }

    if (request.type !== 'odl-nh-progress') return;
    var p = request.payload || {};

    if (p.event === 'start') {
      live.on = true; live.received = 0; live.total = 0; live.percent = 0;
      renderLiveProgress();
      return;
    }
    if (p.event !== 'progress') return;

    // 进度同时给「等回包的 promise」续命
    var cb = nhPending[p.id];
    if (cb) cb();

    live.on = true;
    live.received = p.received || 0;
    live.total = p.total || 0;
    live.percent = p.percent || 0;
    renderLiveProgress();
  });

  var nhPending = {};

  function renderDiag() {
    var el = document.getElementById('odl-diag');
    if (!el) return;
    if (!nhDiag.length) { el.classList.add('odl-hidden'); return; }
    el.classList.remove('odl-hidden');
    el.innerHTML = nhDiag.slice(-14).map(function (l) {
      return '<div>' + escapeHtml(l) + '</div>';
    }).join('');
  }

  function renderLiveProgress() {
    if (!live.on) return;
    var bar = document.getElementById('odl-bar-in');
    var txt = document.getElementById('odl-progress-txt');
    if (!bar || !txt) return;
    var wrap = document.getElementById('odl-progress');
    if (wrap) wrap.classList.remove('odl-hidden');

    var base = batch.total ? (batch.done / batch.total * 100) : 0;
    var within = live.total ? (live.received / live.total * 100) : 0;
    var pct = batch.total ? Math.min(100, base + (within / batch.total)) : within;

    bar.style.width = pct.toFixed(1) + '%';
    var mb = (live.received / 1048576).toFixed(2);
    var totalTxt = live.total ? (' / ' + (live.total / 1048576).toFixed(1) + ' MB') : ' MB';
    txt.textContent = '第 ' + (batch.done + 1) + ' / ' + batch.total + ' 首 · ' + mb + totalTxt
      + (batch.fails.length ? ' · 失败 ' + batch.fails.length : '');
  }

  // status 走 6 秒就够；download 由 bridge 侧 20 秒静默看门狗负责，
  // 这里只兜一个总超时防止 promise 永远挂着。
  function nhCall(action, payload, totalMs) {
    nhSeq += 1;
    var id = 'r' + Date.now().toString(36) + '_' + nhSeq;
    if (payload) payload.__id = id;

    return new Promise(function (resolve) {
      var settled = false;
      var hard = setTimeout(function () {
        if (settled) return;
        settled = true;
        delete nhPending[id];
        resolve({
          ok: false,
          msg: action === 'download'
            ? '本地程序超过 ' + Math.round((totalMs || 600000) / 1000) + ' 秒仍未返回'
            : '本地程序无响应',
          path: '', bytes: 0
        });
      }, totalMs || 600000);

      try {
        chrome.runtime.sendMessage({ type: 'odl-nh', action: action, payload: payload }, function (resp) {
          if (settled) return;
          settled = true;
          clearTimeout(hard);
          delete nhPending[id];
          if (chrome.runtime.lastError) {
            resolve({ ok: false, msg: '本地程序未就绪: ' + chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { ok: false, msg: '本地程序无响应' });
        });
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        delete nhPending[id];
        resolve({ ok: false, msg: '本地程序调用失败: ' + e.message });
      }
    });
  }

  // Normalise what getStatus returns.
  //
  // The reply nests the interesting fields: {success, host:{running,
  // platforms:{win32:{authorized}}}}. Reading st.running straight off the top
  // level always came back undefined, so the panel reported "待启动" even while
  // the host was up. Accept both shapes.
  async function nhStatus() {
    var r = await nhCall('status', {}, 6000);
    if (!r || !r.ok || !r.status) return null;
    var s = r.status;
    if (typeof s !== 'object') return null;
    if (s.success === false) return { running: false, authorized: false, message: s.message || '本地程序不可用' };

    var h = s.host && typeof s.host === 'object' ? s.host : s;
    var plat = h.platforms && (h.platforms.win32 || h.platforms.windows);
    var auth = s.authorized;
    if (auth === undefined) auth = h.authorized;
    if (auth === undefined && plat) auth = plat.authorized;

    return {
      running: (s.running !== undefined ? s.running : h.running) === true,
      authorized: auth === undefined ? true : auth !== false,
      message: s.message || h.message || '',
      raw: s
    };
  }

  function saveViaHost(url, filename) {
    live.on = true;
    live.received = 0;
    live.total = 0;
    live.percent = 0;
    live.name = filename;
    // 总超时按文件大小给：至少 2 分钟，每 10MB 再加 20 秒
    var hardMs = Math.max(120000, 120000 + 2000 * 10);
    return nhCall('download', { url: url, dir: saveDir(), dest: filename }, hardMs);
  }

  // Is "skip what is already on disk" ticked? Un-ticking it is the only way to
  // re-fetch a track at a different quality, so it has to be reachable.
  function skipToggle() {
    var el = document.getElementById('odl-skip');
    return el ? !!el.checked : true;
  }

  // Is this track already sitting in the download folder?
  //
  // Matched by file name, container ignored, and the host is the one doing the
  // matching. The question is "is it already downloaded", and which container
  // it got depends only on the bitrate that happened to be available -- so a
  // stem match is the right answer, and it keeps the 已下载 marks in the list
  // stable while the quality selector moves around.
  //
  // Re-fetching at a different bitrate is what the skip checkbox is for.
  async function alreadySaved(song) {
    var name = sanitize(song.author + ' - ' + song.name);
    try {
      var r = await nhCall('exists', { dir: saveDir(), dest: name }, 8000);
      return !!(r && r.ok && r.exists);
    } catch (e) { /* host unreachable: fall through to downloading */ return false; }
  }

  // Which of these songs are already in the download folder.
  //
  // Asking the host once per track was slow enough that a 195-track playlist
  // was still half-marked when the user looked at it. Asking for the whole
  // folder in one reply was worse: the reply is ~17 KB of CJK and never
  // arrives, so it just times out. Batches of 24 keep every message small and
  // turn the whole playlist into a handful of round trips.
  var CHECK_BATCH = 24;
  var onDisk = {};        // filename -> true, lowercase
  var onDiskBusy = null;

  function indexNames(songs) {
    var names = [];
    for (var i = 0; i < songs.length; i++) {
      names.push(sanitize(songs[i].author + ' - ' + songs[i].name));
    }
    return names;
  }

  function refreshOnDisk(songs) {
    if (onDiskBusy) return onDiskBusy;
    var names = indexNames(songs);
    onDiskBusy = (async function () {
      var set = {};
      try {
        for (var off = 0; off < names.length; off += CHECK_BATCH) {
          var part = names.slice(off, off + CHECK_BATCH);
          var r = await nhCall('check', { dir: saveDir(), names: part }, 20000);
          if (!r || !r.ok || !r.have) continue;
          for (var k = 0; k < r.have.length; k++) {
            var idx = r.have[k];
            if (typeof idx === 'number' && part[idx]) set[part[idx].toLowerCase()] = true;
          }
        }
      } catch (e) { /* host unreachable: treat everything as not present */ }
      onDisk = set;
      onDiskBusy = null;
      return onDisk;
    })();
    return onDiskBusy;
  }

  function inDirIndex(set, song) {
    if (!set) return false;
    return set[sanitize(song.author + ' - ' + song.name).toLowerCase()] === true;
  }

  function detectRoute() {
    var h = location.hash || '';
    var qIdx = h.indexOf('?');
    var path = (qIdx >= 0 ? h.slice(0, qIdx) : h).toLowerCase();
    var query = qIdx >= 0 ? h.slice(qIdx + 1) : '';
    var params = {};
    query.split('&').forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf('=');
      var k = i >= 0 ? kv.slice(0, i) : kv;
      var v = i >= 0 ? kv.slice(i + 1) : '';
      try { params[k] = decodeURIComponent(v); } catch (e) { params[k] = v; }
    });
    return { path: path, params: params, isPlaylistDetail: path.indexOf('playlistdetail') >= 0 };
  }

  function extractSongs(payload) {
    if (!payload || typeof payload !== 'object') return [];
    var data = payload.data !== undefined ? payload.data : payload;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.songs)) return data.songs;
    if (Array.isArray(data.info)) return data.info;
    if (Array.isArray(data.list)) return data.list;
    if (Array.isArray(data.tracks)) return data.tracks;
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      var v = data[keys[i]];
      if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && (v[0].hash || v[0].FileHash)) return v;
    }
    return [];
  }

  var PAGE_SIZE = 60;

  function myUid() {
    try {
      var moe = JSON.parse(localStorage.getItem('MoeData') || '{}');
      var u = moe.UserInfo || {};
      return u.userid || u.userId || u.uid || '';
    } catch (e) { return ''; }
  }

  function guessGcid(listid) {
    var uid = myUid();
    if (!uid || !listid) return '';
    return 'collection_3_' + uid + '_' + listid + '_0';
  }

  async function fetchSongsById(id) {
    var all = [];
    var total = null;
    var lastErr = null;

    for (var page = 1; page <= 40; page++) {
      var r;
      try {
        r = await apiGet('/playlist/track/all', { id: id, page: page, pagesize: PAGE_SIZE });
      } catch (e) {
        lastErr = e;
        break;
      }
      if (r.status !== 1) {
        lastErr = new Error('status=' + r.status + ' code=' + r.error_code + ' ' + (r.errmsg || ''));
        break;
      }
      var data = r.data || {};
      if (total === null && typeof data.count === 'number') total = data.count;
      var arr = Array.isArray(data.songs) ? data.songs : extractSongs(r);
      if (!arr.length) break;
      all = all.concat(arr);
      if (total !== null && all.length >= total) break;
      if (!total && arr.length < PAGE_SIZE) break;
      await sleep(120);
    }

    if (!all.length && lastErr) throw lastErr;
    return all;
  }

  async function fetchPlaylistSongs() {
    var ids = [];
    var guess = guessGcid(batch.listid);
    if (batch.gcid) ids.push(String(batch.gcid));
    if (guess && String(guess) !== String(batch.gcid)) ids.push(String(guess));
    if (batch.listid && String(batch.listid) !== String(batch.gcid) && String(batch.listid) !== String(guess)) {
      ids.push(String(batch.listid));
    }
    if (!ids.length) throw new Error('没有可用的歌单 id');

    var lastErr = null;
    for (var i = 0; i < ids.length; i++) {
      try {
        var songs = await fetchSongsById(ids[i]);
        if (songs.length) {
          batch.gcid = ids[i];
          log('歌单曲目拉取成功，id=', ids[i], '共', songs.length, '首');
          return songs;
        }
      } catch (e) {
        lastErr = e;
        log('id', ids[i], '拉取失败:', e.message);
      }
    }
    throw lastErr || new Error('歌单曲目为空');
  }

  async function fetchMyPlaylists() {
    var r = await apiGet('/user/playlist', { pagesize: 100, t: localStorage.getItem('t') || '' });
    if (r.status !== 1) throw new Error('歌单列表获取失败');
    var info = (r.data && r.data.info) || [];
    var mineUid = (JSON.parse(localStorage.getItem('MoeData') || '{}').UserInfo || {}).userid;
    var map = {};
    var list = (Array.isArray(info) ? info : []).map(function (p) {
      var gid = p.global_collection_id || p.list_create_gid || '';
      if (p.listid) map[String(p.listid)] = String(gid);
      return {
        listid: p.listid,
        gcid: gid,
        name: p.name || '(未命名)',
        count: p.count || p.song_count || '',
        mine: p.list_create_userid === mineUid
      };
    });
    batch.playlistMap = map;
    return list;
  }

  // What to ask /song/url for. "high" is the API's name for hi-res; the
  // returned URL then carries quhigh and a .flac container.
  function apiQuality(q) {
    var n = normQuality(q);
    if (n === 'high') return 'high';
    if (n === 'flac') return 'flac';
    if (n === '320') return '320';
    if (n === '128') return '128';
    return String(q || '');
  }

  async function resolvePlayUrl(hash, goods) {
    var variants = (goods && goods.length) ? goods : null;

    if (!variants) {
      try {
        var priv = await apiGet('/privilege/lite', { hash: hash });
        variants = variantsFrom(priv);
      } catch (e) {
        variants = [];
      }
    }

    // Build the attempt list up front, best first: whatever the requested tier
    // is, then every step below it.
    //
    // The old code picked ONE variant and gave up when /song/url came back
    // empty. That happens on tracks where the advertised quality is not
    // actually servable (rare pressings, VIP-only masters), and the whole
    // song failed even though a lower tier was sitting right there in
    // relate_goods. Six out of a 195-song batch died that way.
    var tries = [];
    var primary = matchVariant(variants, ui.quality);
    if (primary) tries.push(primary);
    // Every distinct variant, ordered by the ladder, minus the one we already
    // queued. Uses each variant's own hash: /song/url wants the hash that
    // belongs to that quality, not the base one.
    var start = LADDER.indexOf(ui.quality);
    if (start < 0) start = LADDER.length - 1;
    for (var step = start; step < LADDER.length; step++) {
      var want = LADDER[step];
      for (var i = 0; i < variants.length; i++) {
        var v = variants[i];
        if (normQuality(v.quality) === want) tries.push(v);
      }
    }
    // Last resort: ask for the base hash at the requested tier.
    tries.push({ hash: hash, quality: ui.quality });

    var tried = {};
    var lastErr = null;
    var noPermission = false;
    for (var t = 0; t < tries.length; t++) {
      var cand = tries[t];
      if (!cand || !cand.hash) continue;
      var key = cand.hash + '@' + cand.quality;
      if (tried[key]) continue;
      tried[key] = true;
      try {
        // ppage_id: MoeKoe's own player always sends this with /song/url, and
        // a handful of tracks return an empty url when it is absent. Harmless
        // for the ones that already work.
        var urlResp = await apiGet('/song/url', {
          hash: cand.hash,
          quality: apiQuality(cand.quality),
          ppage_id: 356753938
        });
        var playUrl = resolveUrl(urlResp);
        if (playUrl) return { url: playUrl, quality: cand.quality, variants: variants };
        if (urlIsDenied(urlResp)) noPermission = true;
        lastErr = new Error('未返回播放地址');
      } catch (e) {
        lastErr = e;
      }
    }

    if (noPermission) {
      // Every variant came back with priv_status=0, i.e. the server says this
      // account may not fetch this track. Saying "未返回播放地址" here reads
      // like our bug and invites pointless retries; this is the real reason,
      // and there is nothing a retry can change.
      var e = new Error('酷狗返回无播放权限（priv_status=0），该账号下拿不到这首');
      e.noRetry = true;
      throw e;
    }
    throw lastErr || new Error('未返回播放地址');
  }

  // Does the API say "you are not allowed to play this" rather than "try a
  // different quality"? Kugou answers that with status 3 and priv_status 0
  // (or error_code 20010 for the membership-only tiers).
  function urlIsDenied(resp) {
    if (!resp || typeof resp !== 'object') return false;
    var d = resp.data;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      if (d.priv_status === 0) return true;
      if (d.error_code === 20010 || d.error_code === 20028) return true;
    }
    return resp.status === 3;
  }

  function isMainPlayer() {
    var h = (location.hash || '').toLowerCase();
    if (h.indexOf('#/lyrics') === 0 || h.indexOf('#/mv') === 0 || h.indexOf('#/video') === 0 || h.indexOf('#/share') === 0) {
      return false;
    }
    return true;
  }

  function buildUI() {
    if (document.getElementById('odl-toggle')) return;
    if (!isMainPlayer()) return;

    var btn = document.createElement('button');
    btn.id = 'odl-toggle';
    btn.className = 'odl-toggle';
    btn.title = '离线下载器';
    btn.textContent = '⤓';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var panel = document.getElementById('odl-panel');
      if (panel) {
        panel.classList.toggle('odl-hidden');
        if (!panel.classList.contains('odl-hidden')) refreshContext();
      }
    });

    var host = document.querySelector('.extra-controls');
    if (host) {
      var vfx = document.getElementById('vfx-toggle');
      if (vfx) host.insertBefore(btn, vfx);
      else {
        var speed = host.querySelector('.playback-speed');
        if (speed) host.insertBefore(btn, speed.nextSibling);
        else host.appendChild(btn);
      }
    } else {
      btn.style.position = 'fixed';
      btn.style.right = '54px';
      btn.style.bottom = '96px';
      btn.style.zIndex = '99998';
      btn.style.background = 'rgba(255,255,255,.92)';
      btn.style.boxShadow = '0 4px 14px rgba(0,0,0,.18)';
      document.body.appendChild(btn);
    }

    var panel = document.createElement('div');
    panel.id = 'odl-panel';
    panel.className = 'odl-panel odl-hidden';

    var html = '';
    html += '<div class="odl-head"><div class="odl-title">离线下载器<small>单曲 · 歌单批量 · 下完不联网也能播</small></div>' +
      '<button class="odl-close" id="odl-close">&times;</button></div>';

    html += '<div class="odl-tabs"><button class="odl-tab" data-mode="single">单曲</button>' +
      '<button class="odl-tab" data-mode="batch">歌单批量</button></div>';

    html += '<div id="odl-view-single">';
    html += '<div class="odl-song"><img class="odl-cover" id="odl-cover" alt="">' +
      '<div class="odl-meta"><div class="odl-name" id="odl-name">未检测到歌曲</div>' +
      '<div class="odl-artist" id="odl-artist">播放任意歌曲后自动识别</div></div></div>';
    html += '<div class="odl-label">音质</div><div class="odl-qualities">';
    for (var i = 0; i < QUALITIES.length; i++) {
      html += '<button class="odl-q" data-q="' + QUALITIES[i].id + '">' + QUALITIES[i].label + '</button>';
    }
    html += '</div><div class="odl-actions"><button class="odl-go" id="odl-go">下载这首</button></div>';
    html += '<div class="odl-status" id="odl-status">就绪</div>';
    html += '</div>';

    html += '<div id="odl-view-batch" class="odl-hidden">';
    html += '<div class="odl-pl-detect" id="odl-pl-detect">打开任意歌单详情页可自动识别</div>';
    html += '<div class="odl-row"><button class="odl-mini" id="odl-pl-refresh">识别当前页</button>' +
      '<button class="odl-mini" id="odl-pl-mine">我的歌单</button>' +
      '<select class="odl-select" id="odl-pl-select"><option value="">— 选择歌单 —</option></select></div>';
    html += '<div class="odl-row"><button class="odl-mini" id="odl-pl-fetch">拉取歌曲</button>' +
      '<button class="odl-mini" id="odl-sel-all">全选</button>' +
      '<button class="odl-mini" id="odl-sel-none">清空</button>' +
      '<span class="odl-count" id="odl-count">0 首</span></div>';
    html += '<div class="odl-row"><label class="odl-check"><input type="checkbox" id="odl-skip" checked>' +
      '跳过目录里已有的同名文件（取消勾选＝重新下载，可用来换音质）</label></div>';
    html += '<div class="odl-list" id="odl-list"><div class="odl-empty">尚未拉取歌曲</div></div>';
    html += '<div class="odl-label">音质</div><div class="odl-qualities">';
    for (var q = 0; q < QUALITIES.length; q++) {
      html += '<button class="odl-q odl-q2" data-q="' + QUALITIES[q].id + '">' + QUALITIES[q].label + '</button>';
    }
    html += '</div>';
    html += '<div class="odl-actions"><button class="odl-go" id="odl-go-batch">下载选中</button>' +
      '<button class="odl-stop odl-hidden" id="odl-stop">停止</button></div>';
    html += '<div class="odl-progress odl-hidden" id="odl-progress"><div class="odl-bar"><div class="odl-bar-in" id="odl-bar-in"></div></div>' +
      '<div class="odl-progress-txt" id="odl-progress-txt">0 / 0</div></div>';
    html += '<div class="odl-fails" id="odl-fails"></div>';
    html += '<div class="odl-row odl-retry-row odl-hidden" id="odl-retry-row">' +
      '<button class="odl-mini" id="odl-retry">只重试失败的</button>' +
      '<span class="odl-count" id="odl-retry-n"></span></div>';
    html += '<div class="odl-diag odl-hidden" id="odl-diag"></div>';
    html += '<div class="odl-savedir">保存到 <b id="odl-dir-text">' + escapeHtml(saveDir()) + '</b>' +
      '<span class="odl-host-flag" id="odl-host-flag">检测本地程序…</span></div>';
    html += '<div class="odl-status" id="odl-status2">就绪</div>';
    html += '</div>';

    panel.innerHTML = html;
    document.body.appendChild(panel);

    panel.querySelector('#odl-close').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      panel.classList.add('odl-hidden');
    });

    panel.querySelectorAll('.odl-tab').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        ui.mode = b.getAttribute('data-mode');
        saveState();
        renderMode();
        if (ui.mode === 'batch') refreshContext();
      });
    });

    // Set the property rather than relying on the bare `checked` attribute in
    // the markup: whatever the host page's form-control reset does, the
    // property is what the code actually reads.
    var skipBox = panel.querySelector('#odl-skip');
    if (skipBox) skipBox.checked = true;

    panel.querySelectorAll('.odl-q, .odl-q2').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        ui.quality = b.getAttribute('data-q');
        saveState();
        syncQualityUI();
        // No re-scan here on purpose: the marks mean "already downloaded",
        // which does not depend on the quality setting. Re-querying 195
        // endpoints every time the selector moves would be wasted work.
      });
    });

    panel.querySelector('#odl-go').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      runSingleDownload();
    });

    panel.querySelector('#odl-pl-refresh').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      refreshContext();
    });

    panel.querySelector('#odl-pl-mine').addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      await loadMyPlaylists();
    });

    panel.querySelector('#odl-pl-select').addEventListener('change', function (e) {
      var opt = e.target.selectedOptions[0];
      if (!opt || !opt.value) return;
      batch.listid = opt.value;
      batch.gcid = opt.getAttribute('data-gcid') || '';
      batch.listName = opt.textContent;
      updateDetect();
    });

    panel.querySelector('#odl-pl-fetch').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      pullPlaylist();
    });

    panel.querySelector('#odl-sel-all').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      batch.songs.forEach(function (s) { batch.selected[s.hash] = true; });
      renderList();
      updateCount();
    });

    panel.querySelector('#odl-sel-none').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      batch.selected = {};
      renderList();
      updateCount();
    });

    panel.querySelector('#odl-go-batch').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      runBatchDownload(null, !!skipToggle());
    });

    panel.querySelector('#odl-retry').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      runBatchDownload(batch.failHashes.slice(), true);
    });

    panel.querySelector('#odl-stop').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      batch.stopFlag = true;
      setStatus('正在停止…', '', 'odl-status2');
    });

    renderMode();
    syncQualityUI();
    renderSong();
  }

  function renderMode() {
    var s = document.getElementById('odl-view-single');
    var b = document.getElementById('odl-view-batch');
    if (s) s.classList.toggle('odl-hidden', ui.mode !== 'single');
    if (b) b.classList.toggle('odl-hidden', ui.mode !== 'batch');
    document.querySelectorAll('#odl-panel .odl-tab').forEach(function (t) {
      t.classList.toggle('odl-active', t.getAttribute('data-mode') === ui.mode);
    });
  }

  function syncQualityUI() {
    document.querySelectorAll('#odl-panel .odl-q, #odl-panel .odl-q2').forEach(function (b) {
      b.classList.toggle('odl-active', b.getAttribute('data-q') === ui.quality);
    });
  }

  function setStatus(text, kind, id) {
    var el = document.getElementById(id || 'odl-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'odl-status' + (kind === 'err' ? ' odl-err' : kind === 'ok' ? ' odl-ok' : '');
  }


  function renderSong() {
    var nameEl = document.getElementById('odl-name');
    var artistEl = document.getElementById('odl-artist');
    var coverEl = document.getElementById('odl-cover');
    if (!nameEl) return;
    var s = songInfo(getCurrentSong());
    if (!s) {
      nameEl.textContent = '未检测到歌曲';
      artistEl.textContent = '播放任意歌曲后自动识别';
      if (coverEl) coverEl.removeAttribute('src');
      return;
    }
    nameEl.textContent = s.title;
    artistEl.textContent = s.artist + (s.album ? ' · ' + s.album : '');
    if (coverEl) {
      if (s.img) coverEl.src = s.img;
      else coverEl.removeAttribute('src');
    }
  }

  function updateDetect() {
    var el = document.getElementById('odl-pl-detect');
    if (!el) return;
    if (batch.listid || batch.gcid) {
      var idTxt = [];
      if (batch.listid) idTxt.push('listid=' + escapeHtml(String(batch.listid)));
      if (batch.gcid) idTxt.push('gcid=' + escapeHtml(String(batch.gcid)));
      el.innerHTML = '当前歌单：<b>' + escapeHtml(batch.listName || batch.listid || batch.gcid) + '</b>' +
        '<span class="odl-id">' + idTxt.join(' · ') + '</span>';
      el.classList.add('odl-detected');
    } else {
      el.textContent = '打开任意歌单详情页可自动识别，或点「我的歌单」选择';
      el.classList.remove('odl-detected');
    }
    var sel = document.getElementById('odl-pl-select');
    if (sel && sel.value !== batch.listid) {
      var found = false;
      Array.prototype.forEach.call(sel.options, function (o) {
        if (o.value === String(batch.listid)) { sel.value = o.value; found = true; }
      });
      if (!found) sel.value = '';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function refreshContext() {
    renderSong();
    var r = detectRoute();
    if (r.isPlaylistDetail) {
      var lid = r.params.listid || '';
      var gid = r.params.global_collection_id || r.params.list_create_gid || '';
      if (!gid && lid) gid = batch.playlistMap[String(lid)] || '';
      if (lid || gid) {
        batch.listid = String(lid || '');
        batch.gcid = String(gid || '');
        if (!batch.listName) batch.listName = '当前打开的歌单';
        updateDetect();
        setStatus('检测到歌单，点「拉取歌曲」加载列表', '', 'odl-status2');
        return;
      }
    }
    updateDetect();
  }

  async function loadMyPlaylists() {
    setStatus('正在读取我的歌单…', '', 'odl-status2');
    try {
      var list = await fetchMyPlaylists();
      var sel = document.getElementById('odl-pl-select');
      if (!sel) return;
      var keep = sel.value;
      sel.innerHTML = '<option value="">— 选择歌单 (' + list.length + ') —</option>';
      list.forEach(function (p) {
        var o = document.createElement('option');
        o.value = String(p.listid);
        o.setAttribute('data-gcid', String(p.gcid || ''));
        o.textContent = p.name + (p.count ? ' (' + p.count + ')' : '') + (p.mine ? '' : ' ♡');
        if (String(p.listid) === String(batch.listid)) o.selected = true;
        sel.appendChild(o);
      });
      if (keep) sel.value = keep;
      setStatus('共 ' + list.length + ' 个歌单', 'ok', 'odl-status2');
    } catch (e) {
      warn(e.message);
      setStatus('歌单列表失败：' + e.message, 'err', 'odl-status2');
    }
  }

  async function pullPlaylist() {
    if (!batch.listid && !batch.gcid) {
      setStatus('先识别或选择一个歌单', 'err', 'odl-status2');
      return;
    }
    var btn = document.getElementById('odl-pl-fetch');
    if (btn) btn.disabled = true;
    setStatus('拉取歌单歌曲…', '', 'odl-status2');
    try {
      var songs = await fetchPlaylistSongs();
      batch.songs = songs.map(function (raw) {
        var s = songInfo(raw);
        return { hash: s.hash, name: s.title, author: s.artist, cover: s.img, goods: s.goods || [] };
      }).filter(function (s) { return !!s.hash; });

      // Entries with no hash are not a bug on our side. Kugou returns them as
      // {"fileid": 91, "shield": 1} -- a bare "this is blocked" marker with no
      // title, no artist and no playable id, so there is nothing to ask
      // /song/url about. Say so plainly instead of quietly dropping them.
      var shielded = songs.filter(function (raw) {
        return !(raw && (raw.hash || raw.playHash || raw.FileHash || raw.file_hash ||
          raw['270hash'] || raw.orig_hash));
      });

      batch.selected = {};
      batch.saved = {};
      batch.shielded = shielded.length;
      batch.songs.forEach(function (s) { batch.selected[s.hash] = true; });
      renderList();
      updateCount();
      setStatus('拉取完成：' + batch.songs.length + ' 首可下载' +
        (shielded.length ? '（' + shielded.length + ' 首已被酷狗屏蔽，无法下载）' : '') +
        '，正在标记已下载…', shielded.length ? 'err' : 'ok', 'odl-status2');
      log('歌单拉取', batch.listid, batch.songs.length,
        '屏蔽 ' + shielded.length);
      // Marking writes the final status line, so let it run last.
      await markSaved();
    } catch (e) {
      warn('拉取失败', e.message);
      setStatus('拉取失败：' + e.message, 'err', 'odl-status2');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderList() {
    var box = document.getElementById('odl-list');
    if (!box) return;
    if (!batch.songs.length) {
      box.innerHTML = '<div class="odl-empty">尚未拉取歌曲</div>';
      return;
    }
    var html = '';
    batch.songs.forEach(function (s, i) {
      var on = !!batch.selected[s.hash];
      var have = !!batch.saved[s.hash];
      html += '<label class="odl-item' + (on ? ' on' : '') + (have ? ' have' : '') + '" data-hash="' + escapeHtml(s.hash) + '">' +
        '<input type="checkbox"' + (on ? ' checked' : '') + '>' +
        '<span class="odl-idx">' + (i + 1) + '</span>' +
        '<span class="odl-item-name">' + escapeHtml(s.name) + '</span>' +
        (have ? '<span class="odl-badge">已下载</span>' : '') +
        '<span class="odl-item-artist">' + escapeHtml(s.author) + '</span>' +
        '</label>';
    });
    box.innerHTML = html;

    box.querySelectorAll('.odl-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var h = el.getAttribute('data-hash');
        batch.selected[h] = !batch.selected[h];
        el.classList.toggle('on', !!batch.selected[h]);
        var cb = el.querySelector('input');
        if (cb) cb.checked = !!batch.selected[h];
        updateCount();
      });
    });
  }

  // Ask the host which of these songs are already sitting in the target
  // folder, and tag the rows. The host is the only party that can answer --
  // a browser-side cache lies as soon as localStorage gets cleared.
  //
  // Runs after a pull, after a quality change (the container changes with it)
  // and after a batch, so the marks always match what is actually on disk.
  async function markSaved() {
    if (!batch.songs.length || batch.marking) return;
    var st = await nhStatus();
    if (!st) { setStatus('本地程序未就绪，无法标记已下载', 'err', 'odl-status2'); return; }

    batch.marking = true;
    var found = 0;
    var set = await refreshOnDisk(batch.songs);
    if (!set) {
      batch.marking = false;
      setStatus('本地程序未就绪，无法读取下载目录', 'err', 'odl-status2');
      return;
    }
    for (var i = 0; i < batch.songs.length; i++) {
      var s = batch.songs[i];
      if (inDirIndex(set, s)) { batch.saved[s.hash] = true; found++; }
      else delete batch.saved[s.hash];
    }
    batch.marking = false;
    renderList();
    updateCount();
    if (batch.failHashes.length) renderFails();
    setStatus('拉取完成：' + batch.songs.length + ' 首可下载' +
      (batch.shielded ? '（' + batch.shielded + ' 首已被酷狗屏蔽，无法下载）' : '') +
      '，其中 ' + found + ' 首已在目录里', batch.shielded ? 'err' : 'ok', 'odl-status2');
  }

  function selectedSongs() {
    return batch.songs.filter(function (s) { return batch.selected[s.hash]; });
  }

  function updateCount() {
    var el = document.getElementById('odl-count');
    if (el) el.textContent = '已选 ' + selectedSongs().length + ' / ' + batch.songs.length + ' 首';
    var go = document.getElementById('odl-go-batch');
    if (go) go.textContent = '下载选中 (' + selectedSongs().length + ')';
  }

  function updateProgress() {
    var wrap = document.getElementById('odl-progress');
    var bar = document.getElementById('odl-bar-in');
    var txt = document.getElementById('odl-progress-txt');
    if (!wrap || !bar || !txt) return;
    wrap.classList.toggle('odl-hidden', !batch.running && batch.done === 0);
    if (batch.running && live.on) { renderLiveProgress(); return; }
    var pct = batch.total ? Math.round(batch.done / batch.total * 100) : 0;
    bar.style.width = pct + '%';
    txt.textContent = batch.done + ' / ' + batch.total +
      ' · ' + (batch.bytes / 1048576).toFixed(1) + ' MB' +
      (batch.skipped ? ' · 跳过 ' + batch.skipped : '') +
      (batch.fails.length ? ' · 失败 ' + batch.fails.length : '');
  }

  function renderFails() {
    var el = document.getElementById('odl-fails');
    var row = document.getElementById('odl-retry-row');
    var cnt = document.getElementById('odl-retry-n');
    if (row) row.classList.toggle('odl-hidden', !batch.failHashes.length || batch.running);
    if (cnt) cnt.textContent = batch.failHashes.length ? batch.failHashes.length + ' 首待重试' : '';
    if (!el) return;
    if (!batch.fails.length) { el.innerHTML = ''; return; }
    el.innerHTML = batch.fails.slice(-6).map(function (f) {
      return '<div class="odl-fail">' + escapeHtml(f) + '</div>';
    }).join('');
  }

  async function runSingleDownload() {
    var btn = document.getElementById('odl-go');
    if (btn && btn.disabled) return;
    var s = songInfo(getCurrentSong());
    if (!s) { setStatus('未检测到当前歌曲', 'err'); return; }
    if (!s.hash) { setStatus('当前歌缺少 hash，无法取流', 'err'); return; }

    if (btn) btn.disabled = true;
    try {
      setStatus('解析地址…');
      var r = await resolvePlayUrl(s.hash, s.goods);
      var ext = extFromUrl(r.url, extForQuality(ui.quality));
      var fname = sanitize(s.artist + ' - ' + s.title) + '.' + ext;

      setStatus('写入 ' + saveDir() + ' …');
      var res = await saveViaHost(r.url, fname);
      if (!res || !res.ok) {
        setStatus('写入失败：' + (res && res.msg ? res.msg : '本地程序未授权'), 'err');
        return;
      }
      try {
        if (window.__odlLocalIndex) {
          window.__odlLocalIndex({ hash: s.hash, name: s.title, author: s.artist }, fname);
        }
      } catch (e2) {}
      setStatus('完成：' + res.path + '（' + (res.bytes / 1048576).toFixed(2) + ' MB · ' + r.quality + '）', 'ok');
      log('单曲下载完成', res.path, res.bytes);
    } catch (e) {
      warn('单曲下载失败', e.message);
      setStatus('失败：' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function runBatchDownload(onlyHashes, skipExisting) {
    if (batch.running) return;
    var list = onlyHashes
      ? batch.songs.filter(function (s) { return onlyHashes.indexOf(s.hash) >= 0; })
      : selectedSongs();
    if (!list.length) {
      setStatus(onlyHashes ? '没有待重试的曲目' : '先拉取歌曲并勾选要下载的', 'err', 'odl-status2');
      return;
    }

    batch.running = true;
    batch.stopFlag = false;
    batch.total = list.length;
    batch.done = 0;
    batch.bytes = 0;
    batch.skipped = 0;
    batch.fails = [];
    batch.failHashes = [];
    batch.blockedCount = 0;

    var goBtn = document.getElementById('odl-go-batch');
    var stopBtn = document.getElementById('odl-stop');
    if (goBtn) { goBtn.disabled = true; goBtn.textContent = '下载中…'; }
    if (stopBtn) stopBtn.classList.remove('odl-hidden');
    updateProgress();
    renderFails();
    setStatus('批量下载开始（' + ui.quality + '）', '', 'odl-status2');

    for (var i = 0; i < list.length; i++) {
      if (batch.stopFlag) {
        setStatus('已停止，完成 ' + batch.done + ' / ' + batch.total, 'err', 'odl-status2');
        break;
      }
      var s = list[i];
      setStatus('[' + (i + 1) + '/' + list.length + '] ' + s.author + ' - ' + s.name, '', 'odl-status2');

      // Already on disk from an earlier run? The host checks the folder itself.
      // Re-running a batch must not re-download gigabytes the user already
      // has, and a browser-side index is not trustworthy enough for that.
      if (skipExisting && (await alreadySaved(s))) {
        batch.skipped++;
        batch.done++;
        updateProgress();
        continue;
      }

      try {
        var r = await resolvePlayUrl(s.hash, s.goods);
        var ext = extFromUrl(r.url, extForQuality(ui.quality));
        var fname = sanitize(s.author + ' - ' + s.name) + '.' + ext;
        var res = await saveViaHost(r.url, fname);
        if (!res || !res.ok) throw new Error(res && res.msg ? res.msg : '本地程序写入失败');
        batch.bytes += res.bytes;
        // A track that just landed is on disk now; mark it so the row flips
        // as soon as the run finishes instead of staying unmarked.
        batch.saved[s.hash] = true;
        try {
          if (window.__odlLocalIndex) {
            window.__odlLocalIndex({ hash: s.hash, name: s.name, author: s.author }, fname);
          }
        } catch (e2) {}
        log('批量完成', res.path, res.bytes);
      } catch (e) {
        batch.fails.push(s.name + ' - ' + e.message);
        // A track the server refuses to serve will refuse again. Keep it out
        // of the retry list so the button only offers things that can work.
        if (!e.noRetry) batch.failHashes.push(s.hash);
        else batch.blockedCount++;
        warn('批量失败', s.name, e.message);
        renderFails();
      }
      batch.done++;
      updateProgress();
      await sleep(600);
    }

    batch.running = false;
    // Freshly written files belong in the cached index, otherwise a second run
    // would report tracks it just saved as missing.
    onDisk = {};
    if (goBtn) { goBtn.disabled = false; updateCount(); }
    if (stopBtn) stopBtn.classList.add('odl-hidden');

    if (!batch.stopFlag) {
      var msg = '全部完成：' + batch.done + ' 首 · ' + (batch.bytes / 1048576).toFixed(1) + ' MB';
      if (batch.skipped) msg += ' · 跳过已存在 ' + batch.skipped;
      if (batch.blockedCount) msg += ' · 无权限 ' + batch.blockedCount;
      if (batch.failHashes.length) msg += ' · 失败 ' + batch.failHashes.length;
      setStatus(msg, (batch.blockedCount || batch.failHashes.length) ? 'err' : 'ok', 'odl-status2');
    }

    // Keep the failures around across a restart. They are the only record of
    // which tracks could not be fetched, and losing them on every app launch
    // makes the retry button useless.
    try {
      if (batch.failHashes.length) {
        localStorage.setItem('__odl_fail_hashes', JSON.stringify(batch.failHashes));
      } else {
        localStorage.removeItem('__odl_fail_hashes');
      }
    } catch (e) {}
    updateProgress();
    // Refresh once more now that running is false: during the loop the retry
    // row is hidden on purpose, and without this it stayed hidden after the
    // batch finished.
    renderFails();
    // Rows that were skipped because the file was already there, or that just
    // finished downloading, now carry the mark.
    renderList();
  }

  /* ============================================================
     歌单详情页：在应用自己的歌曲列表上标出「已下载」
     ------------------------------------------------------------
     行的结构（探针实测）：

       .vue-recycle-scroller__item-view
         .li
           .track-number
           .track-title[title=歌名]   > .track-title-text / .track-title-tags
           .track-artist[title=歌手]
           .track-album[title=专辑]

     行里没有 hash，只有 title 属性里的干净歌名/歌手，所以用「歌名+歌手」
     去匹配磁盘上已有的文件。

     这是个虚拟滚动列表：可视区之外的行不在 DOM 里，滚回去时又是新的节点。
     所以标记不能只在加载时打一次，得每轮重扫当前存在的行，缺哪个补哪个。
     ============================================================ */

  var plMarks = {};        // normalised key -> true
  var plMarksListId = '';
  var plMarking = false;

  // Normalise before comparing. The API's `name` often already carries the
  // artist ("金志文 - 远走高飞 (独唱版)") while the row's title attribute holds
  // the bare title with full-width brackets ("远走高飞（独唱版）"), so the two never
  // match as plain strings. Keep only letters and CJK characters.
  function plNorm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, '');
  }

  function plKey(title, artist) {
    return plNorm(artist) + '|' + plNorm(title);
  }

  // Drop a redundant artist from the title: the API puts it back on some
  // tracks and the row never carries it.
  function plStripArtist(title, artist) {
    var t = String(title == null ? '' : title);
    var a = String(artist == null ? '' : artist).trim();
    if (!a) return t;
    var na = plNorm(a);
    if (!na || plNorm(t).indexOf(na) !== 0) return t;
    var need = na.length, seen = 0, cut = 0;
    for (var i = 0; i < t.length; i++) {
      if (plNorm(t[i])) seen++;
      if (seen === need) { cut = i + 1; break; }
    }
    if (!cut) return t;
    return t.slice(cut).replace(/^[\s\-_、,，&·:：]+/, '');
  }

  // Build the mark table once per playlist: pull the tracks, then ask the host
  // which of them are already in the download folder.
  async function loadPlaylistMarks() {
    if (plMarking) return;
    var r = detectRoute();
    if (!r.isPlaylistDetail) return;
    var lid = r.params.listid || '';
    var gid = r.params.global_collection_id || r.params.list_create_gid || '';
    if (!lid && !gid) return;
    var sig = String(lid) + '|' + String(gid);
    if (sig === plMarksListId) return;

    var st = await nhStatus();
    if (!st) return;

    plMarking = true;
    try {
      var ids = [];
      if (gid) ids.push(String(gid));
      var guess = guessGcid(lid);
      if (guess && guess !== String(gid)) ids.push(guess);
      if (lid && String(lid) !== String(gid) && String(lid) !== guess) ids.push(String(lid));

      var songs = [];
      for (var i = 0; i < ids.length && !songs.length; i++) {
        try { songs = await fetchSongsById(ids[i]); } catch (e) { songs = []; }
      }
      if (!songs.length) { plMarksListId = sig; return; }

      // Both shapes are needed: the disk lookup wants author+name, the badge key
      // wants the bare title. Carrying one object with both used to silently
      // produce keys like "artist|" with an empty title.
      var probe = [];
      for (var q = 0; q < songs.length; q++) {
        var qi = songInfo(songs[q]);
        if (qi.hash) probe.push({ author: qi.artist, name: qi.title, title: qi.title });
      }

      var set = await refreshOnDisk(probe);
      var marks = {};
      for (var k = 0; k < probe.length; k++) {
        if (inDirIndex(set, probe[k])) {
          marks[plKey(plStripArtist(probe[k].title, probe[k].author), probe[k].author)] = true;
        }
      }
      plMarks = marks;
      plMarksListId = sig;
      paintPlaylistMarks();
    } catch (e) {
      // A failure here is not worth surfacing: the panel reports its own.
    } finally {
      plMarking = false;
    }
  }

  function paintPlaylistMarks() {
    var rows = document.querySelectorAll('.vue-recycle-scroller__item-view');
    if (!rows.length) return;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var badge = row.querySelector('.odl-pl-have');
      var t = row.querySelector('.track-title');
      var a = row.querySelector('.track-artist');
      if (!t) continue;
      var name = (t.getAttribute('title') || '').trim();
      var artist = a ? (a.getAttribute('title') || '').trim() : '';
      if (!name) continue;
      var hit = !!plMarks[plKey(name, artist)];

      if (hit && !badge) {
        badge = document.createElement('span');
        badge.className = 'odl-pl-have';
        badge.textContent = '已下载';
        badge.title = '目标目录里已经有这个文件';
        var tags = t.querySelector('.track-title-tags');
        if (tags && tags.parentNode) tags.parentNode.insertBefore(badge, tags.nextSibling);
        else t.appendChild(badge);
      } else if (hit && badge) {
        badge.style.display = '';
      } else if (badge) {
        badge.remove();
      }
    }
  }

  function injectPlaylistDownloadButton() {
    if (!isMainPlayer()) return;
    var r = detectRoute();
    if (!r.isPlaylistDetail) return;
    if (document.getElementById('odl-pl-dl-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'odl-pl-dl-btn';
    btn.className = 'odl-pl-dl';
    btn.textContent = '⤓ 离线下载本歌单';
    var batchBtn = document.querySelector('.batch-action-btn');
    if (batchBtn && batchBtn.parentElement) {
      btn.style.cssText = 'margin-left:16px; padding:9px 16px; border:none; border-radius:7px; background:#ff4d8d; color:#fff; font-size:13px; font-weight:600; cursor:pointer; white-space:nowrap; vertical-align:middle;';
      batchBtn.parentElement.appendChild(btn);
    } else {
      btn.style.cssText = 'position:fixed; top:88px; right:26px; z-index:9990; padding:10px 18px; border:none; border-radius:8px; background:#ff4d8d; color:#fff; font-size:13px; font-weight:600; cursor:pointer; box-shadow:0 6px 18px rgba(255,77,141,.35);';
      document.body.appendChild(btn);
    }
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      ui.mode = 'batch';
      saveState();
      renderMode();
      var panel = document.getElementById('odl-panel');
      if (panel) panel.classList.remove('odl-hidden');
      refreshContext();
      pullPlaylist();
    });
  }

  function init() {
    loadState();
    buildUI();
    refreshContext();

    try {
      var raw = localStorage.getItem('settings');
      var S = raw ? JSON.parse(raw) : {};
      S.loudnessNormalization = 'off';
      S.quality = 'flac';
      localStorage.setItem('settings', JSON.stringify(S));
    } catch (e) {}

    /* 观察器 + 定时器都要两件事：各自兜住异常、并且合并重扫。

       歌单列表是虚拟滚动的，滚动一次就是几十次 DOM 变更。观察器是
       subtree 全量监听，每来一次变更就全表重扫一遍 —— 滚动顺滑的时候
       那是每帧一次。所以这里只置一个「待重扫」的标记，用 rAF 合并成
       一帧最多扫一次，滚动照样跟手。
    */
    var markPending = false;
    function scheduleMarkPaint() {
      if (markPending) return;
      markPending = true;
      requestAnimationFrame(function () {
        markPending = false;
        try { paintPlaylistMarks(); } catch (e) { warn('标记绘制失败', e.message); }
      });
    }

    var obs = new MutationObserver(function () {
      scheduleMarkPaint();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // 每个钩子各自兜住：面板建不起来，不该连带把宿主状态和已下载标记
    // 一起废掉 —— 那是六个独立的功能，串在一起等下一次一起死。
    var HOOKS = [
      ['界面', buildUI],
      ['当前歌曲', renderSong],
      ['歌单按钮', injectPlaylistDownloadButton],
      ['宿主状态', refreshHostFlag],
      ['已下载表', loadPlaylistMarks],
      ['已下载标记', paintPlaylistMarks]
    ];

    setInterval(function () {
      for (var i = 0; i < HOOKS.length; i++) {
        try { HOOKS[i][1](); } catch (e) { warn('定时任务「' + HOOKS[i][0] + '」失败', e.message); }
      }
    }, 3000);
    window.addEventListener('hashchange', function () {
      var panel = document.getElementById('odl-panel');
      if (panel && !panel.classList.contains('odl-hidden') && ui.mode === 'batch') refreshContext();
      // A different playlist means a different mark table.
      plMarks = {};
      plMarksListId = '';
      loadPlaylistMarks();
    });

    refreshHostFlag();
    log('已加载，音质:', ui.quality, '模式:', ui.mode, '保存目录:', saveDir());
  }

  var hostFlagState = null;

  async function refreshHostFlag() {
    var el = document.getElementById('odl-host-flag');
    if (!el) return;
    var st = await nhStatus();
    var txt, okFlag;
    if (!st) {
      txt = '本地程序未授权';
      okFlag = false;
    } else if (st.authorized === false) {
      txt = '需在「设置 → 插件」授权本地程序';
      okFlag = false;
    } else if (st.running) {
      txt = '本地程序就绪';
      okFlag = true;
    } else {
      txt = '本地程序待启动（首次下载时自动拉起）';
      okFlag = true;
    }
    if (hostFlagState === txt) return;
    hostFlagState = txt;
    el.textContent = txt;
    el.classList.toggle('odl-ok-flag', okFlag);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
