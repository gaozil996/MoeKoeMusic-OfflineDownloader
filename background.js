function broadcast(msg) {
  chrome.tabs.query({}, function (tabs) {
    if (chrome.runtime.lastError) return;
    tabs.forEach(function (t) {
      chrome.tabs.sendMessage(t.id, msg, function () { void chrome.runtime.lastError; });
    });
  });
}

// 内容脚本的消息会同时到达 service worker 和 bridge 页。
// bridge 页不能重复处理（会造成同一个下载跑两遍），所以这里只保留
// 「bridge → 全页面广播」和「内容脚本 → 后台 fetch」两类。
chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (!request) return false;

  if (request.type === 'odl-nh-diag') {
    broadcast({ type: 'odl-nh-diag', lines: request.lines });
    sendResponse({ ok: true });
    return false;
  }

  if (request.type !== 'odl-nh-progress' && request.type !== 'fetch-bytes') return false;

  if (request.type === 'odl-nh-progress') {
    broadcast({ type: 'odl-nh-progress', payload: request.payload });
    sendResponse({ ok: true });
    return false;
  }

  if (request.type === 'fetch-bytes') {
    fetch(request.url, { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        sendResponse({ data: arrayBufferToBase64(buf) });
      })
      .catch(function (e) {
        sendResponse({ error: e.message });
      });
    return true;
  }

  return false;
});

function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var chunkSize = 8192;
  var out = [];
  for (var i = 0; i < bytes.length; i += chunkSize) {
    var chunk = bytes.subarray(i, i + chunkSize);
    var s = '';
    for (var j = 0; j < chunk.length; j++) s += String.fromCharCode(chunk[j]);
    out.push(s);
  }
  return btoa(out.join(''));
}