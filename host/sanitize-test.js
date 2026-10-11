// 真跑一遍 moekoe-saver.exe，看加固后的文件名在盘上到底变成什么。
// 不是单元测试：起本地 HTTP 服务，让 exe 真的下载，落盘后列目录。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const EXE = path.join(__dirname, 'moekoe-saver.exe');
const DL = path.join(process.env.TEMP || '.', 'odl-sanitize-test');
const BODY = Buffer.alloc(4096, 0x41);

fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': BODY.length });
  res.end(BODY);
});

const CASES = [
  'CON.mp3',
  'nul.mp3',
  'COM1.mp3',
  'LPT9.flac',
  'com0.mp3',            // 合法，不该被改
  'com10.mp3',           // 合法，不该被改
  'AUX.mp3',
  '..\\..\\escape.mp3',  // 穿越
  '../../escape2.mp3',
  '.hidden.mp3',         // 前导点
  'song‮exe.mp3',   // U+202E 右向覆盖
  'a<b>c:d"e|f?g*h.mp3', // 非法字符
  '  前后空格  .mp3',
  '...mp3',
  'CON',                 // 无扩展名
  'CONSOLE.mp3',         // 合法
  ''
];

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}/a.mp3`;
  const host = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const replies = new Map();
  const pending = new Set();
  host.stdout.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (j.id && replies.has(j.id) && j.ok !== undefined) replies.get(j.id)(j);
      // start / progress 事件只用来证明还活着，不结算这次调用
      else if (j.id && j.event === 'progress' && pending.has(j.id)) pending.get(j.id)(j);
    }
  });

  let seq = 0;
  function call(cmd, extra, timeoutMs) {
    return new Promise((resolve) => {
      const id = 't' + (++seq);
      const timer = setTimeout(() => resolve({ ok: false, msg: 'TIMEOUT' }), timeoutMs || 15000);
      replies.set(id, (r) => { clearTimeout(timer); resolve(r); });
      host.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n');
    });
  }

  const ping = await call('ping', {});
  console.log('握手:', ping.ok ? 'OK' : 'FAIL ' + ping.msg);

  let pass = 0, fail = 0;
  const problems = [];
  for (const dest of CASES) {
    const r = await call('download', { url, dir: DL, dest }, 20000);
    // 只有空名该被拒；CON 这种设备名是改名后照常下载，不是报错
    const expectOk = dest !== '';
    const good = (r.ok === expectOk);
    if (good) pass++; else { fail++; problems.push(`${JSON.stringify(dest)} -> ${r.ok ? 'ok' : 'ERR ' + (r.msg || '')}`); }
    console.log(`  ${good ? 'PASS' : 'FAIL'} ${(dest === '' ? '(空)' : JSON.stringify(dest)).padEnd(26)} -> ${r.ok ? 'ok' : 'ERR'} ${r.msg || ''}`);
  }

  host.kill();
  srv.close();

  console.log('\n=== 下载目录实际内容 ===');
  const left = fs.readdirSync(DL).sort();
  for (const f of left) {
    const st = fs.statSync(path.join(DL, f));
    console.log(`  ${JSON.stringify(f).padEnd(40)} ${st.size} 字节`);
  }
  console.log('\n=== 上级目录是否被写脏（穿越检查）===');
  const parent = path.dirname(DL);
  const escaped = fs.readdirSync(parent).filter(f => /escape/i.test(f));
  console.log(escaped.length ? '  ★ 发现了逃逸文件: ' + escaped.join(', ') : '  没有（好）');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
});