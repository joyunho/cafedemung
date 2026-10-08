// 테스트용 서버 두 개: 앱 정적 서버 + ntfy를 흉내낸 가짜 서버(발행, json poll, sse 스트림, Delay 예약 전송).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };

export function startServers({ appPort = 8080, ntfyPort = 8081, delayScale = 1 } = {}) {
  const log = [];                // 발행된 메시지 기록 {topic, delay, size, at}
  const topics = new Map();      // topic → {msgs, subs}
  let seq = 0;
  const nowSec = () => Math.floor(Date.now() / 1000);
  const newId = () => (++seq).toString(36).padStart(5, '0') + Math.random().toString(36).slice(2, 9);
  const topicOf = name => { if (!topics.has(name)) topics.set(name, { msgs: [], subs: new Set() }); return topics.get(name); };
  const parseDelay = s => { const m = /^(\d+)\s*(s|m|h|d)?$/.exec(String(s || '').trim()); if (!m) return 0; return Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 })[m[2] || 's'] * 1000; };
  const deliver = (t, msg) => {
    msg.time = nowSec(); msg.expires = msg.time + 43200; t.msgs.push(msg);
    const line = 'data: ' + JSON.stringify(msg) + '\n\n';
    for (const res of t.subs) res.write(line);
  };
  const since = (t, s) => {
    if (!s || s === 'all' || /^\d+[smhd]$/.test(s)) return t.msgs.slice();
    if (/^\d{9,}$/.test(s)) { const ts = Number(s); return t.msgs.filter(m => m.time >= ts); }
    const i = t.msgs.findIndex(m => m.id === s); return i < 0 ? [] : t.msgs.slice(i + 1);
  };
  const cors = res => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS'); };

  const ntfy = http.createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x');
    const [, name, sub] = url.pathname.split('/');
    if (!name) { res.writeHead(404); return res.end(); }
    const t = topicOf(name);
    if (req.method === 'POST' && !sub) {
      let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
        const delay = String(req.headers['delay'] || '');
        const msg = { id: newId(), time: nowSec(), expires: 0, event: 'message', topic: name, message: body };
        log.push({ topic: name, delay, size: body.length, at: Date.now() });
        const ms = parseDelay(delay);
        if (ms > 0) setTimeout(() => deliver(t, { ...msg }), ms * delayScale); else deliver(t, msg);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(msg));
      });
      return;
    }
    if (req.method === 'GET' && sub === 'json') {
      const list = since(t, url.searchParams.get('since'));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      return res.end(list.map(m => JSON.stringify(m)).join('\n') + (list.length ? '\n' : ''));
    }
    if (req.method === 'GET' && sub === 'sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write('event: open\ndata: ' + JSON.stringify({ id: newId(), time: nowSec(), event: 'open', topic: name }) + '\n\n');
      for (const m of since(t, url.searchParams.get('since'))) res.write('data: ' + JSON.stringify(m) + '\n\n');
      t.subs.add(res); req.on('close', () => t.subs.delete(res));
      return;
    }
    res.writeHead(404); res.end();
  });

  const app = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });

  return new Promise(resolve => {
    ntfy.listen(ntfyPort, () => app.listen(appPort, () => resolve({
      log, topics,
      close: () => { for (const t of topics.values()) for (const r of t.subs) r.end(); ntfy.close(); app.close(); },
    })));
  });
}
