(function () {
  'use strict';

  var HOST_ID = 'offline-dl-saver';
  var seq = 0;
  var pending = {};

  // bridge 是隐藏窗口，console 看不到。
  // 扩展页不能直接写 file://，所以把诊断回传给 content script 显示在面板上。
  var diagLines = [];

  function dlog(msg) {
    try {
      diagLines.push(msg);
      if (diagLines.length > 40) diagLines.shift();
      chrome.runtime.sendMessage({ type: 'odl-nh-diag', lines: diagLines.slice() }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  window.__lycOpenBridge = true;
  dlog('BRIDGE LOADED pid-env ok');

  function post(msg) {
    try {
      dlog('POST ' + msg.cmd + ' dest=' + (msg.dest || '') + ' url=' + String(msg.url).slice(0, 70));
      var r = window.electronAPI.nativeHost.send(HOST_ID, msg);
      if (r && typeof r.then === 'function') {
        r.then(function (res) {
          dlog('POST-RET ' + JSON.stringify(res));
          if (res && res.success === false) {
            var id = msg.id;
            if (id && pending[id]) {
              pending[id]({ ok: false, msg: res.message || 'nativeHost.send 失败', path: '', bytes: 0 });
            }
          } else {
            dlog('POST-OK (accepted)');
          }
        }, function (err) {
          dlog('POST-REJECT ' + String(err));
        });
      }
      return r;
    } catch (e) {
      dlog('POST-THROW ' + String(e && e.message || e));
      console.error('[OfflineDL bridge] send threw', e);
      var id0 = msg.id;
      if (id0 && pending[id0]) {
        pending[id0]({ ok: false, msg: String(e && e.message || e), path: '', bytes: 0 });
      }
    }
  }

  function broadcastProgress(p) {
    try {
      chrome.runtime.sendMessage({ type: 'odl-nh-progress', payload: p }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  async function status() {
    try {
      return await window.electronAPI.nativeHost.getStatus(HOST_ID);
    } catch (e) {
      return { available: false, message: String(e && e.message || e) };
    }
  }

  // 静默门限：每次收到 exe 的任何消息就重置，避免大文件被误杀
  var SILENT_MS = 20000;

  function download(opts, onProgress) {
    return request(opts, 'download', onProgress, SILENT_MS);
  }

  // Any command that expects one reply carrying the same id. Downloads get the
  // long silent window and progress beats; short queries get a short one so a
  // wedged host fails fast instead of stalling the whole batch.
  function request(opts, cmd, onProgress, silentMs) {
    seq += 1;
    var id = 'd' + Date.now().toString(36) + '_' + seq;

    return new Promise(function (resolve) {
      var settled = false;
      var silent = null;

      function settle(r) {
        if (settled) return;
        settled = true;
        clearTimeout(silent);
        delete pending[id];
        resolve(r);
      }

      function armSilent() {
        clearTimeout(silent);
        silent = setTimeout(function () {
          settle({ ok: false, msg: '本地程序无响应（' + (silentMs / 1000) + ' 秒无任何回包）', path: '', bytes: 0 });
        }, silentMs);
      }

      var fn = function (r) { settle(r); };
      fn.beat = armSilent;
      pending[id] = fn;
      armSilent();

      // Forward everything the caller passed, not just the four fields the
      // download path happens to use. Dropping unknown keys silently is how a
      // `check` reached the host with no candidate names at all.
      var frame = { id: id, cmd: cmd };
      Object.keys(opts || {}).forEach(function (k) {
        if (k === 'id' || k === 'cmd' || k === '__id') return;
        frame[k] = opts[k];
      });
      if (frame.url === undefined) delete frame.url;
      if (frame.dest === undefined) delete frame.dest;
      var handle = post(frame);

      if (handle && typeof handle.then === 'function') {
        handle.then(function (res) {
          armSilent();
          if (!res) return;
          if (res.success === false) {
            settle({ ok: false, msg: res.message || '本地程序拒绝请求', path: '', bytes: 0 });
          }
        });
      }
    });
  }

  window.electronAPI.nativeHost.onMessage(function (payload) {
    if (!payload || payload.hostId !== HOST_ID) return;
    var m = payload.message;
    if (!m) return;

    if (m.type === 'hello') { dlog('HOST HELLO'); return; }

    // exe echoes the id verbatim and it may be a number or a string
    var id = m.id === undefined || m.id === null ? '' : String(m.id);
    if (!id) return;

    if (m.event === 'start') {
      dlog('START ' + id);
      broadcastProgress({ id: id, event: 'start', received: 0, total: 0, percent: 0 });
      return;
    }

    if (m.event === 'progress') {
      var pct = m.percent || 0;
      var part = { id: id, event: 'progress', received: m.received || 0, total: m.total || 0, percent: pct };
      dlog('PROG ' + id + ' ' + ((m.received / 1048576) || 0).toFixed(2) + 'MB ' + pct + '%');
      broadcastProgress(part);
      if (onProgress) onProgress(m);
      // 进度也用来续命，避免慢速大文件被误判超时
      var ent = pending[id];
      if (ent && ent.beat) ent.beat();
      return;
    }

    if (typeof m.ok === 'boolean') {
      dlog('DONE ' + id + ' ok=' + m.ok + ' bytes=' + m.bytes +
        (m.exists === undefined ? '' : ' exists=' + m.exists));
      pending[id] && pending[id]({
        ok: m.ok,
        msg: m.msg || '',
        path: m.path || '',
        bytes: m.bytes || 0,
        exists: m.exists,
        have: m.have
      });
    }
  });

  chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
    if (!req || req.type !== 'odl-nh') return false;

    if (req.action === 'status') {
      status().then(function (s) { sendResponse({ ok: true, status: s }); });
      return true;
    }

    if (req.action === 'download') {
      var p = req.payload || {};
      // 进度由 onMessage 统一广播，这里不再重复广播
      download(p).then(sendResponse);
      return true;
    }

    if (req.action === 'exists') {
      var q = req.payload || {};
      request(q, 'exists', null, 8000).then(sendResponse);
      return true;
    }

    if (req.action === 'check') {
      // Batched membership check, see the host side for why this is not a
      // single "give me every filename" call.
      var cq = req.payload || {};
      request(cq, 'check', null, 20000).then(sendResponse);
      return true;
    }

    return false;
  });

  status().then(function (s) {
    dlog('STATUS ' + JSON.stringify(s));
    console.log('[OfflineDL bridge] status', JSON.stringify(s));
  }, function (e) {
    dlog('STATUS-FAIL ' + String(e));
  });
})();