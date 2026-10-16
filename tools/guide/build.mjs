// 사용 안내서(guide.pdf) 만들기: 앱 화면을 찍어 tools/guide/shots/ 에 넣고, tools/guide/guide.html 을 A4 PDF로 인쇄한다.
// 실행: node tools/guide/build.mjs   (playwright 필요. 테스트와 같은 준비: tests/ 참고)
// 주소창·알림 주제는 실제 것과 같게 보이지만, 앱 파일은 이 저장소에서 읽고 동기화는 로컬 가짜 중계 서버로만 보낸다(실제 가게 숫자를 건드리지 않음).
// 글꼴(Google Fonts)과 PDF 라이브러리(cdnjs)는 curl로 받아 넘긴다(브라우저에 프록시가 없어도 되게).
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServers } from '../../tests/mock-ntfy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'shots') + '/';
fs.mkdirSync(OUT, { recursive: true });
const SITE = 'https://joyunho.github.io/cafedemung/', MOCK = 'http://127.0.0.1:8091';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.json': 'application/json', '.pdf': 'application/pdf' };
const cache = new Map();
const curl = url => { if (!cache.has(url)) cache.set(url, execFileSync('curl', ['-sfL', '--max-time', '60', '-A', UA, url], { maxBuffer: 1 << 26 })); return cache.get(url); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { close } = await startServers({ appPort: 8090, ntfyPort: 8091, delayScale: 5e-5 });
const browser = await chromium.launch({ args: ['--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks'] });
async function phone(name, startAt) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ko-KR', timezoneId: 'Asia/Seoul', colorScheme: 'light', serviceWorkers: 'block' });
  await ctx.clock.install({ time: startAt });
  await ctx.route(SITE + '**', r => {
    const u = new URL(r.request().url()); let rel = decodeURIComponent(u.pathname.replace(/^\/cafedemung\/?/, '')) || 'index.html';
    if (rel === 'config.js') return r.fulfill({ contentType: 'text/javascript', body: `window.CDM_CONFIG={NTFY:${JSON.stringify(MOCK)},POLL_MS:15000,SHARED_CODE:"CAUK-8SFS-N9MB"};` });
    const f = path.join(ROOT, rel); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ status: 200, contentType: MIME[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
  });
  for (const host of ['https://fonts.googleapis.com/**', 'https://fonts.gstatic.com/**', 'https://cdnjs.cloudflare.com/**']) {
    await ctx.route(host, r => { const u = r.request().url(); let body; try { body = curl(u); } catch (e) { return r.abort(); }
      const ct = u.includes('googleapis') ? 'text/css' : u.includes('gstatic') ? 'font/woff2' : 'application/javascript';
      return r.fulfill({ status: 200, contentType: ct, headers: { 'access-control-allow-origin': '*' }, body }); });
  }
  // 실제 ntfy.sh로 나가는 요청은 막는다(알림 테스트 등)
  await ctx.route('https://ntfy.sh/**', r => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`[${name}] pageerror`, e.message));
  await page.goto(SITE);
  await page.waitForSelector('.item', { timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  return page;
}
const shot = (p, n, opt = {}) => p.screenshot({ path: OUT + n + '.png', ...opt });
const setv = async (p, sel, v) => { await p.fill(sel, String(v)); await p.press(sel, 'Enter'); await sleep(200); };

const A = await phone('A', new Date('2026-10-16T09:05:00+09:00'));
await sleep(1200);
await shot(A, 'g01-first');
await A.click('#sh-start'); await sleep(400);
await A.fill('#nh-name', '사장님'); await A.click('#nh-save'); await sleep(300);
const B = await phone('B', new Date('2026-10-16T08:40:00+09:00'));
await B.waitForSelector('#syncHint', { state: 'hidden', timeout: 30000 });
if (await B.isVisible('#nh-name')) { await B.fill('#nh-name', '윤호'); await B.click('#nh-save'); }
await setv(B, '#u-yy-011', 0); await setv(B, '#o-yy-011', 3);
await setv(B, '#u-yy-012', 0);
await setv(B, '#u-yy-003', 14);
await B.click('#tabs button[data-sec="과일·케이크"]'); await sleep(300);
await setv(B, '#u-yh-001', 2); await setv(B, '#o-yh-001', 1);
await sleep(3000);
await A.waitForFunction(() => document.querySelector('#u-yy-011').value === '0', null, { timeout: 20000 });
await setv(A, '#u-yy-001', 96); await setv(A, '#o-yy-001', 1);
await setv(A, '#u-yy-002', 2); await setv(A, '#u-yy-004', 24); await setv(A, '#o-yy-004', 1);
await A.click('.item[data-id="yy-003"] .name'); await A.waitForSelector('#editor:not([hidden])');
await A.fill('#ed-min', '6'); await A.click('#ed-save'); await sleep(300);
await setv(A, '#u-yy-003', 5);
await sleep(2500);
await A.clock.fastForward('25:00');
await sleep(1500);
await A.evaluate(() => window.scrollTo(0, 0));
await sleep(300);
await shot(A, 'g02-list');
await A.locator('.item[data-id="yy-001"] button.dec[data-f="u"]').click();
await A.locator('.item[data-id="yy-001"] button.dec[data-f="u"]').click();
await sleep(300);
await shot(A, 'g03-toast');
await sleep(700); await A.click('#toast .act'); await sleep(400);
// 편집 + 기록
await sleep(2600); await A.click('.item[data-id="yy-011"] .name'); await A.waitForSelector('#editor:not([hidden])'); await sleep(400);
await A.evaluate(() => document.querySelector('#ed-hist').scrollIntoView({ block: 'end' })); await sleep(200);
await shot(A, 'g04-editor');
await A.click('#ed-cancel');
// 한눈에
await A.click('#viewTable'); await A.waitForSelector('#table:not([hidden])'); await sleep(600);
await shot(A, 'g05-table');
await A.evaluate(() => { const f = document.querySelector('#table .feed'); f && f.closest('.card').scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); }); await sleep(300);
await shot(A, 'g06-feed');
await A.evaluate(() => window.scrollTo(0, 0));
// PDF
await A.click('#pdfBtn'); await A.waitForSelector('#pdfSheet:not([hidden])');
await A.click('#pdfAll');
await A.waitForSelector('#pdfReady:not([hidden])', { timeout: 120000 }); await sleep(300);
await shot(A, 'g07-pdf');
await A.click('#pdf-close');
// 설정 · 알림
await A.click('#gearBtn'); await A.waitForSelector('#settings:not([hidden])'); await sleep(400);
await shot(A, 'g08-settings');
await A.evaluate(() => document.querySelector('#alertTopic').scrollIntoView({ block: 'center' })); await sleep(200);
await shot(A, 'g09-alert');
await A.click('#st-cancel');
const topic = await A.evaluate(() => document.querySelector('#alertTopic').textContent);
if (!fs.readFileSync(path.join(HERE, 'guide.html'), 'utf8').includes(topic)) console.warn('안내서의 알림 주제 이름이 앱과 달라요: ' + topic);

// 안내서 인쇄
const ctx = await browser.newContext();
await ctx.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: curl(r.request().url()) }));
await ctx.route('https://fonts.gstatic.com/**', r => r.fulfill({ status: 200, contentType: 'font/woff2', headers: { 'access-control-allow-origin': '*' }, body: curl(r.request().url()) }));
const doc = await ctx.newPage();
await doc.goto(pathToFileURL(path.join(HERE, 'guide.html')).href, { waitUntil: 'networkidle' });
await doc.evaluate(() => document.fonts.ready);
await doc.pdf({ path: path.join(ROOT, 'guide.pdf'), format: 'A4', printBackground: true, preferCSSPageSize: true });
await browser.close(); close();
console.log('guide.pdf 만듦');
