// 앱 전체 흐름 검사: 처음 설정 → 링크로 연결 → 숫자 동기화 → 한눈에 보기 → 추가/삭제 → 오프라인 → 예약 스냅샷 → 늦게 합류한 폰.
// 실행: node tests/smoke.mjs   (REAL_NTFY=1 이면 실제 ntfy.sh로도 한 번 더 검사)
import { chromium } from 'playwright';
import { startServers } from './mock-ntfy.mjs';

const APP_PORT = 8080, NTFY_PORT = 8081;
const APP = `http://127.0.0.1:${APP_PORT}/`;
const MOCK = `http://127.0.0.1:${NTFY_PORT}`;
const errors = [];
let failures = 0, offlinePhase = false;
const check = (cond, msg) => { if (cond) console.log('  ok   ' + msg); else { failures++; console.log('  FAIL ' + msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const storeOf = page => page.evaluate(() => JSON.parse(localStorage.getItem('cdm.store') || '{"items":[]}'));

const { log, close } = await startServers({ appPort: APP_PORT, ntfyPort: NTFY_PORT, delayScale: 5e-5 });
const browser = await chromium.launch();

async function phone(name, { ntfy = MOCK, hash = '', scheme = 'light' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, locale: 'ko-KR' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await ctx.route('**/config.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.CDM_CONFIG={NTFY:${JSON.stringify(ntfy)},POLL_MS:15000};` }));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !offlinePhase && !/ERR_INTERNET_DISCONNECTED|ERR_FAILED|ERR_NETWORK/.test(m.text())) errors.push(`[${name}] console: ${m.text()}`); });
  await page.goto(APP + hash);
  return page;
}
async function setupPhone(page, nick, code) {
  await page.waitForSelector('#setup:not([hidden])');
  await page.fill('#s-name', nick);
  if (code) await page.fill('#s-code', code);
  await page.click('#s-go');
  await page.waitForSelector('.item', { timeout: 20000 });
}
const inputVal = (page, sel) => page.$eval(sel, el => el.value);

try {
  console.log('1) 폰 A 처음 설정');
  const A = await phone('A');
  check(await A.isVisible('#setup'), '처음 설정 화면이 보임');
  await setupPhone(A, '윤호');
  const code = await A.evaluate(() => JSON.parse(localStorage.getItem('cdm.settings')).code);
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), '가게 코드 생성: ' + code);
  check((await A.$$('#tabs button')).length === 3, '구역 탭 3개');
  check((await A.$$('.item')).length === 47, '첫 구역(윤영 정리) 항목 47개');
  check((await A.textContent('#summary')).includes('항목 108'), '요약에 항목 108: ' + (await A.textContent('#summary')).trim());
  check(await A.isVisible('#pairHint'), '연결 안내 배너 표시');

  console.log('2) 폰 B 링크로 연결');
  const B = await phone('B', { hash: '#j=' + code });
  await B.waitForSelector('#setup:not([hidden])');
  check((await B.textContent('#setupTitle')) === '가게에 연결', '링크로 열면 "가게에 연결" 화면');
  await B.fill('#s-name', '사장님'); await B.click('#s-go'); await B.waitForSelector('.item', { timeout: 20000 });
  check(await B.evaluate(() => location.hash === ''), '주소에서 코드가 지워짐');
  await A.waitForFunction(() => document.querySelector('#summary').textContent.includes('연결된 폰'), null, { timeout: 20000 });
  check((await A.textContent('#summary')).includes('사장님'), 'A가 사장님 폰을 인식');
  await B.waitForFunction(() => document.querySelector('#summary').textContent.includes('윤호'), null, { timeout: 20000 });
  check(true, 'B가 윤호 폰의 스냅샷을 받음');
  check(!(await A.isVisible('#pairHint')), '연결되면 안내 배너가 사라짐');

  console.log('3) A에서 +2 → B에 반영');
  const incA = A.locator('.item[data-id="yy-001"] button.inc[data-f="u"]');
  await incA.click(); await incA.click();
  check((await inputVal(A, '#u-yy-001')) === '122', 'A 화면에 바로 122');
  await B.waitForFunction(() => document.querySelector('#u-yy-001').value === '122', null, { timeout: 20000 });
  check(true, 'B에 122 도착');
  const metaB = await B.locator('.item[data-id="yy-001"] .meta').textContent();
  check(metaB.includes('윤호'), 'B에 수정자 표시: ' + metaB);
  check(log.filter(l => !l.delay).length >= 2, '서버로 보낸 메시지 ' + log.length + '개');

  console.log('4) B에서 직접 입력 → A에 반영');
  await B.fill('#o-yy-001', '3'); await B.press('#o-yy-001', 'Enter');
  await A.waitForFunction(() => document.querySelector('#o-yy-001').value === '3', null, { timeout: 20000 });
  check(true, 'A에 뜯은거 3 도착');

  console.log('5) 거의 동시 수정: 나중 값이 이김');
  await A.fill('#u-yy-002', '5'); await A.press('#u-yy-002', 'Enter');
  await sleep(300);
  await B.fill('#u-yy-002', '7'); await B.press('#u-yy-002', 'Enter');
  await A.waitForFunction(() => document.querySelector('#u-yy-002').value === '7', null, { timeout: 20000 });
  await sleep(2500);
  check((await inputVal(B, '#u-yy-002')) === '7' && (await inputVal(A, '#u-yy-002')) === '7', '양쪽 모두 7');

  console.log('6) 한눈에 보기');
  await B.click('#viewTable'); await B.waitForSelector('#table:not([hidden])');
  const tableText = await B.textContent('#table');
  check(tableText.includes('주문 목록'), '주문 목록 카드');
  check((await B.$$('#table table.grid')).length === 3, '구역별 표 3개');
  check((await B.$$('#table tr.row')).length === 108, '표 행 108개');
  check((await B.$$('#table .orders li')).length >= 10, '주문 목록 항목 ' + (await B.$$('#table .orders li')).length + '개');
  await B.click('#copyOrdersBtn'); await B.waitForSelector('#toast:not([hidden])');
  check((await B.textContent('#toast')).includes('복사'), '주문 목록 복사 토스트: ' + (await B.textContent('#toast')));
  await B.click('#table tr.row[data-id="yh-007"]'); await B.waitForSelector('#list:not([hidden])');
  check((await B.$eval('#tabs button[aria-selected="true"]', b => b.dataset.sec)) === '윤호 정리', '표에서 항목을 누르면 해당 구역으로 이동');
  check(await B.$eval('.item[data-id="yh-007"]', el => el.classList.contains('flash')), '이동한 항목 강조');

  console.log('7) 항목 추가/삭제 전파');
  await A.click('#addBtn'); await A.waitForSelector('#editor:not([hidden])');
  await A.fill('#ed-name', '테스트 시럽'); await A.fill('#ed-group', '시럽'); await A.click('#ed-save');
  await B.waitForFunction(() => JSON.parse(localStorage.getItem('cdm.store')).items.some(i => i.name === '테스트 시럽'), null, { timeout: 20000 });
  check(true, '추가한 항목이 B에 저장됨');
  const newId = (await storeOf(A)).items.find(i => i.name === '테스트 시럽').id;
  await A.click(`.item[data-id="${newId}"] .name`); await A.waitForSelector('#editor:not([hidden])');
  await A.click('#ed-delete'); await A.click('#ed-del-yes');
  await B.waitForFunction(id => { const it = JSON.parse(localStorage.getItem('cdm.store')).items.find(i => i.id === id); return !!(it && it.t.d > 0); }, newId, { timeout: 20000 });
  check(true, '삭제가 B에 전파');

  console.log('8) 오프라인 수정 후 복구');
  offlinePhase = true;
  await B.context().setOffline(true);
  await sleep(500);
  await B.locator('.item[data-id="yh-001"] button.inc[data-f="u"]').click();
  await sleep(2500);
  const pill = await B.textContent('#sync');
  check(pill === '오프라인' || pill === '다시 연결 중…', '오프라인 표시: ' + pill);
  check((await B.locator('.item[data-id="yh-001"] .meta').textContent()).includes('보내는 중'), '보류 표시');
  await B.context().setOffline(false);
  await A.waitForFunction(() => { const it = JSON.parse(localStorage.getItem('cdm.store')).items.find(i => i.id === 'yh-001'); return it && it.unopened === 4; }, null, { timeout: 25000 });
  check(true, '복구 후 A에 도착 (망고 4)');
  await sleep(1000); offlinePhase = false;

  console.log('9) 앱이 다시 보일 때 예약 스냅샷 전송');
  const before = log.length;
  await A.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(700);
  await A.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(8000);
  const sched = log.slice(before).filter(l => l.delay);
  check(sched.length >= 6, '예약 전송 ' + sched.length + '개 (지연: ' + [...new Set(sched.map(l => l.delay))].join(',') + ')');
  check(log.every(l => l.size <= 4096), '모든 메시지가 4096바이트 이하 (최대 ' + Math.max(...log.map(l => l.size)) + ')');

  console.log('10) 폰 C 나중에 합류 → 캐시로 따라잡기');
  const C = await phone('C', { hash: '#j=' + code });
  await setupPhone(C, '알바');
  await C.waitForFunction(() => { const el = document.querySelector('#u-yy-001'); return el && el.value === '122'; }, null, { timeout: 25000 });
  check(true, 'C가 과거 수정(탄산수 122)을 받음');
  await C.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('cdm.store') || '{"items":[]}'); const it = s.items.find(i => i.id === 'yy-002'); return !!(it && it.unopened === 7); }, null, { timeout: 10000 });
  const cStore = await storeOf(C);
  check(cStore.items.find(i => i.id === 'yy-002').unopened === 7, 'C에 yy-002=7 (저장소에도 반영)');
  check(cStore.items.find(i => i.name === '테스트 시럽').t.d > 0, 'C에도 삭제 반영');

  console.log('11) 설정 시트 · 표 복사');
  await C.click('#gearBtn'); await C.waitForSelector('#settings:not([hidden])');
  check((await C.textContent('#codeBox')) === code, '설정에 가게 코드 표시');
  check((await C.textContent('#peersLine')).includes('윤호') || (await C.textContent('#peersLine')).includes('사장님'), '연결된 폰 목록: ' + (await C.textContent('#peersLine')).trim());
  await C.click('#copyTableBtn'); await C.waitForSelector('#toast:not([hidden])');
  check((await C.textContent('#toast')).includes('복사'), '표 복사 토스트');
  await C.click('#st-cancel');

  console.log('12) 다시 열어도 데이터 유지 + 다크 모드');
  await C.reload(); await C.waitForSelector('.item', { timeout: 20000 });
  check((await inputVal(C, '#u-yy-001')) === '122', '새로고침 후에도 122 유지');
  const D = await phone('D', { scheme: 'dark' });
  check(await D.isVisible('#setup'), '다크 모드에서 설정 화면 표시');

  if (process.env.REAL_NTFY === '1') {
    console.log('13) 실제 ntfy.sh로 동기화 (실패해도 치명적 아님)');
    try {
      const realCode = 'T' + Math.random().toString(36).slice(2, 13).toUpperCase().replace(/[^A-Z0-9]/g, 'X').padEnd(11, 'X');
      const R1 = await phone('R1', { ntfy: 'https://ntfy.sh' }); await setupPhone(R1, '윤호', realCode);
      const R2 = await phone('R2', { ntfy: 'https://ntfy.sh' }); await setupPhone(R2, '사장님', realCode);
      await R1.locator('.item[data-id="yy-003"] button.inc[data-f="u"]').click();
      await R2.waitForFunction(() => document.querySelector('#u-yy-003').value === '17', null, { timeout: 40000 });
      console.log('  ok   실제 ntfy.sh로 숫자 전달됨');
    } catch (e) { console.log('  WARN 실제 ntfy.sh 검사 실패: ' + e.message); }
  }
} catch (e) {
  failures++; console.log('  FAIL 예외: ' + (e && e.stack || e));
} finally {
  await browser.close(); close();
}
console.log('page errors:', errors.length ? errors : 'none');
console.log(failures ? `FAILED (${failures})` : 'ALL PASSED');
process.exit(failures || errors.length ? 1 : 0);
