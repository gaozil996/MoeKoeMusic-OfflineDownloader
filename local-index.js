(function () {
  'use strict';

  var KEY = '__odl_local_index';
  var DIR = 'D:\\MoeKoeMusic';
  var SCAN_INTERVAL = 15000;

  function log() { console.log.apply(console, ['[OfflineDL Local]'].concat([].slice.call(arguments))); }

  function getIndex() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return {};
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }

  function saveIndex(idx) {
    try { localStorage.setItem(KEY, JSON.stringify(idx)); } catch (e) {}
  }

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,5}$/, '')
      .replace(/[\s\-_·・,.，。、'"“”‘’()（）\[\]【】!！?？:：;；~～\-]+/g, '');
  }

  function keysOf(song) {
    var out = [];
    if (!song) return out;
    var name = song.name || song.title || '';
    var author = song.author || song.artist || '';
    var album = song.albumname || song.album || '';

    if (name && author) out.push(norm(author + ' - ' + name));
    if (name) out.push(norm(name));
    if (album && name) out.push(norm(album + ' - ' + name));
    if (song.hash) out.push(String(song.hash).toUpperCase());
    return out.filter(Boolean);
  }

  function indexSong(song, fileName) {
    var idx = getIndex();
    var keys = keysOf(song);
    if (!keys.length) return 0;
    var changed = 0;
    keys.forEach(function (k) {
      if (!idx[k]) { idx[k] = fileName; changed++; }
    });
    if (changed) saveIndex(idx);
    return changed;
  }

  function lookup(hash) {
    if (!hash) return null;
    var idx = getIndex();
    var hit = idx[String(hash).toUpperCase()];
    return hit || null;
  }

  window.__odlLocalIndex = indexSong;
  window.__odlLocalLookup = lookup;

  log('loaded, dir =', DIR);

  window.addEventListener('storage', function (e) {
    if (e.key === KEY) log('index updated');
  });
})();