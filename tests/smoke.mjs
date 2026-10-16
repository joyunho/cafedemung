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

async function phone(name, { ntfy = MOCK, hash = '', scheme = 'light', init = null, shared = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, locale: 'ko-KR' });
  // init: [저장소, 설정] JSON. 처음 열 때만 넣어서 '예전에 쓰던 폰'을 흉내낸다.
  if (init) await ctx.addInitScript(([st, cfg]) => { if (!localStorage.getItem('cdm.store')) { localStorage.setItem('cdm.store', st); localStorage.setItem('cdm.settings', cfg); } }, init);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await ctx.route('**/config.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.CDM_CONFIG={NTFY:${JSON.stringify(ntfy)},POLL_MS:15000,ALERT_DELAY_MS:600,SHARED_CODE:${JSON.stringify(shared)}};` }));
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
  check((await A.$$('#tabs button')).length === 4, '구역 탭 4개');
  check((await A.$$('.item')).length === 14, '첫 구역(음료) 항목 14개');
  check((await A.textContent('#summary')).includes('항목 101'), '요약에 항목 101: ' + (await A.textContent('#summary')).trim());
  check(await A.isVisible('#pairHint'), '연결 안내 배너 표시');

  console.log('1b) 제품 사진');
  const man = await fetch(APP + 'img/manifest.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
  const firstImgId = man ? Object.keys(man.items || {}).find(id => id.startsWith('yy-')) : null;
  if (firstImgId) {
    await A.waitForFunction(id => { const im = document.querySelector(`.item[data-id="${id}"] .thumb img`); return !!(im && im.complete && im.naturalWidth > 0); }, firstImgId, { timeout: 15000 });
    const withImg = await A.$$eval('.item .thumb img', els => els.length);
    check(withImg === (await A.$$('.item')).length, `입력 화면 항목마다 사진 ${withImg}개 (목록 ${Object.keys(man.items).length}개)`);
  } else console.log('  skip 사진 목록(img/manifest.json)이 아직 없음');
  check((await A.$$('.item .thumb')).length === 14, '모든 항목에 사진 칸 있음');
  await A.click('.item[data-id="yy-001"] .thumb'); await A.waitForSelector('#viewer:not([hidden])');
  check((await A.textContent('#vw-name')) === '탄산수', '사진 크게 보기: ' + (await A.textContent('#vw-name')));
  check((await A.textContent('#vw-credit')).length > 5, '사진 설명/출처 표시: ' + (await A.textContent('#vw-credit')).slice(0, 60));
  await A.click('#vw-close');
  check(await A.isHidden('#viewer'), '크게 보기 닫힘');

  console.log('1c) 배치 정리 (윤호 정리·윤영 정리 → 종류별 탭)');
  const tabNames = await A.$$eval('#tabs button', bs => bs.map(b => b.dataset.sec));
  check(tabNames.join('/') === '음료/음료 재료/과일·케이크/포장·소모품', '구역 탭: ' + tabNames.join(' / '));
  const stA = await storeOf(A); const itA = id => stA.items.find(i => i.id === id);
  const gone = it => (it.t.d || 0) > 0 && it.t.d >= Math.max(it.t.u || 0, it.t.o || 0, it.t.m || 0);
  check(itA('pk-028').unopened === 38 && gone(itA('yh-026')), '쉬폰 비닐 미니 합침 (28+10=38): ' + itA('pk-028').unopened);
  check(itA('pk-026').unopened === 12 && itA('pk-026').opened === 1 && gone(itA('yh-028')), '냅킨 합침 (0+12, 뜯은거 1)');
  check(itA('pk-033').unopened === 11 && itA('pk-032').unopened === 19, 'OPP 봉투 합침 (25*18: 4+7, 15*18: 10+9)');
  check(itA('yh-001').section === '과일·케이크' && itA('yh-001').group === '냉동과일', '망고 → 과일·케이크 / 냉동과일');
  check(itA('yh-015').group === '과일청·베이스' && itA('yh-006').group === '아이스크림', '레몬주스 → 과일청·베이스, 아포가또 → 아이스크림');
  check(!stA.items.some(i => (i.section === '윤호 정리' || i.section === '윤영 정리') && !gone(i)), "'윤호 정리'·'윤영 정리'에 남은 항목 없음");
  check(itA('yy-046').section === '음료' && itA('yy-046').group === '탄산·스파클링' && itA('yy-002').group === '우유·주스', '분다버그 → 음료 / 탄산·스파클링, 멸균우유 → 우유·주스');
  check(itA('yy-014').section === '음료 재료' && itA('yy-014').group === '스무디·베이스' && itA('yy-044').group === '소스' && itA('yy-037').group === '토핑·잼', '펌킨페이스트 → 스무디·베이스, 기라델리 → 소스, 쿠앤크분태 → 토핑·잼');
  check(stA.items.filter(i => i.section === '음료 재료' && !gone(i)).length === 33, '음료 재료 33개');
  await A.click('#tabs button[data-sec="과일·케이크"]');
  const grpA = await A.$$eval('#list .group h2', hs => hs.map(h => h.textContent.trim()));
  check(grpA.length === 4 && grpA[0].startsWith('냉동과일') && grpA[2].startsWith('케이크'), '과일·케이크 분류: ' + grpA.join(', '));
  check((await A.textContent('.item[data-id="yh-001"] .meta')) === '시트에서 가져옴' && !(await A.textContent('#summary')).includes('최근 수정'), '정리만 한 항목엔 수정 시각을 안 붙임');
  await A.click('#tabs button[data-sec="음료"]');

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
  await B.waitForSelector('#syncHint', { state: 'hidden', timeout: 20000 });
  check(true, 'B가 A의 숫자를 받은 뒤 고치기 가능');

  console.log('3) A에서 +2 → B에 반영');
  const incA = A.locator('.item[data-id="yy-001"] button.inc[data-f="u"]');
  await incA.click(); await incA.click();
  check((await inputVal(A, '#u-yy-001')) === '122', 'A 화면에 바로 122');
  await B.waitForFunction(() => document.querySelector('#u-yy-001').value === '122', null, { timeout: 20000 });
  check(true, 'B에 122 도착');
  const metaB = await B.locator('.item[data-id="yy-001"] .meta').textContent();
  check(metaB.includes('윤호'), 'B에 수정자 표시: ' + metaB);
  check(log.filter(l => !l.delay).length >= 2, '서버로 보낸 메시지 ' + log.length + '개');

  console.log('3b) 변경 기록 · 되돌리기');
  const hA = (await storeOf(A)).items.find(i => i.id === 'yy-001').h;
  check(hA.length === 1 && hA[0][2] === 'u' && hA[0][3] === 120 && hA[0][4] === 122 && hA[0][5] === '윤호', '연달아 누른 +2가 기록 한 줄로 (120 → 122, 윤호)');
  await B.waitForFunction(() => { const it = JSON.parse(localStorage.getItem('cdm.store')).items.find(i => i.id === 'yy-001'); return !!(it && it.h && it.h.some(e => e[3] === 120 && e[4] === 122)); }, null, { timeout: 20000 });
  check(true, 'B에도 기록 도착');
  await A.locator('.item[data-id="yy-004"] button.inc[data-f="u"]').click();
  await A.waitForSelector('#toast .act', { timeout: 3000 });
  check((await A.textContent('#toast')).includes('30 → 31'), '숫자를 바꾸면 "전 → 후 · 되돌리기": ' + (await A.textContent('#toast')));
  await A.click('#toast .act');
  check((await inputVal(A, '#u-yy-004')) === '30', '되돌리기 누르면 30으로');
  await B.click('.item[data-id="yy-001"] .name'); await B.waitForSelector('#editor:not([hidden])');
  const histB = await B.textContent('#ed-hist-list');
  check(histB.includes('안뜯은거 120 → 122') && histB.includes('윤호'), '편집 화면에 최근 기록: ' + histB.trim().slice(0, 60));
  await B.click('#ed-cancel');
  await A.fill('#u-yy-010', '5'); await A.press('#u-yy-010', 'Enter');
  await A.click('.item[data-id="yy-010"] .name'); await A.waitForSelector('#editor:not([hidden])');
  await A.click('#ed-hist-list button.undo');
  check((await inputVal(A, '#u-yy-010')) === '' && (await A.textContent('#ed-hist-list')).trim() === '', '기록에서 되돌리기 (5 → 비움), 제자리가 된 줄은 숨김');
  await A.click('#ed-cancel');

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
  const h2a = (await storeOf(A)).items.find(i => i.id === 'yy-002').h.map(e => e[4]).sort().join(','), h2b = (await storeOf(B)).items.find(i => i.id === 'yy-002').h.map(e => e[4]).sort().join(',');
  check(h2a === '5,7' && h2b === '5,7', '동시에 고쳐도 두 폰의 기록이 모두 남음 (' + h2a + ' / ' + h2b + ')');

  console.log('6) 한눈에 보기');
  await B.click('#viewTable'); await B.waitForSelector('#table:not([hidden])');
  const tableText = await B.textContent('#table');
  check(tableText.includes('주문 목록'), '주문 목록 카드');
  check((await B.$$('#table table.grid')).length === 4, '구역별 표 4개');
  check((await B.$$('#table tr.row')).length === 101, '표 행 101개');
  check((await B.$$('#table .orders li')).length >= 10, '주문 목록 항목 ' + (await B.$$('#table .orders li')).length + '개');
  check((await B.$$('#table tr.row .mini')).length === 101, '표의 모든 행에 사진 칸');
  await B.click('#table tr.row[data-id="yh-001"] .mini'); await B.waitForSelector('#viewer:not([hidden])');
  check((await B.textContent('#vw-name')) === '망고', '표에서 사진 누르면 크게 보기');
  await B.click('#vw-close');
  check(await B.isVisible('#table'), '크게 보기 닫아도 표 화면 유지');
  const feed = await B.$$eval('#table .feed li', ls => ls.map(l => l.textContent));
  check(feed.length >= 3 && feed.some(t => t.includes('탄산수') && t.includes('120 → 122')), '한눈에 "최근 변경" 목록 ' + feed.length + '줄');
  await B.click('#copyOrdersBtn');
  await B.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && t.textContent.includes('복사'); }, null, { timeout: 5000 }).catch(() => {});
  check((await B.textContent('#toast')).includes('복사'), '주문 목록 복사 토스트: ' + (await B.textContent('#toast')));
  const copied = await B.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  if (copied) check(copied.includes('[과일·케이크 · 케이크]'), '주문 목록에 분류까지 표시');
  await B.click('#table tr.row[data-id="yh-007"]'); await B.waitForSelector('#list:not([hidden])');
  check((await B.$eval('#tabs button[aria-selected="true"]', b => b.dataset.sec)) === '과일·케이크', '표에서 항목을 누르면 해당 구역으로 이동');
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

  console.log('7b) 사진 주소 직접 넣기 → 다른 폰에 전달');
  const customImg = APP + 'icons/icon-192.png';
  await A.click('#tabs button[data-sec="음료"]');
  await A.click('.item[data-id="yy-003"] .name'); await A.waitForSelector('#editor:not([hidden])');
  await A.fill('#ed-img', 'javascript:alert(1)'); await A.click('#ed-save');
  check(await A.isVisible('#editor'), '잘못된 사진 주소는 저장 안 됨');
  await A.fill('#ed-img', customImg);
  check(await A.$eval('#ed-img-prev img', im => im.getAttribute('src')) === customImg, '편집 화면에 사진 미리보기');
  await A.click('#ed-save');
  await A.waitForFunction(src => { const im = document.querySelector('.item[data-id="yy-003"] .thumb img'); return !!(im && im.getAttribute('src') === src); }, customImg, { timeout: 5000 });
  check(true, 'A 화면 사진이 바뀜');
  await B.waitForFunction(src => { const it = JSON.parse(localStorage.getItem('cdm.store')).items.find(i => i.id === 'yy-003'); return !!(it && it.img === src); }, customImg, { timeout: 20000 });
  check(true, 'B에 바뀐 사진 주소 도착');

  console.log('7c) 사장님 폰 알림 (ntfy 앱)');
  const alerts = () => log.filter(l => l.topic.startsWith('cdm-alert-'));
  const n0 = alerts().length;
  await A.fill('#u-yy-011', '0'); await A.press('#u-yy-011', 'Enter');
  await sleep(1500);
  const al = alerts();
  check(al.length === n0 + 1 && (new URLSearchParams(al[al.length - 1].query).get('title') || '').includes('뽀로로딸기 없음') && al[al.length - 1].body.includes('윤호'), '없음이 되면 알림 1통 (바꾼 폰에서만): ' + (al.length - n0) + '통');
  await A.click('#gearBtn'); await A.waitForSelector('#settings:not([hidden])');
  const topicShown = await A.textContent('#alertTopic');
  check(topicShown === al[al.length - 1].topic && (await A.getAttribute('#alertSub', 'href')).startsWith('ntfy://'), '설정에 알림 주제 이름과 안드로이드 구독 링크');
  await A.click('#alertTest'); await sleep(600);
  check(alerts().length === n0 + 2 && alerts()[alerts().length - 1].body.includes('잘 와요'), '테스트 알림 보내기');
  await A.uncheck('#alertSend'); await A.click('#st-cancel');
  await A.fill('#u-yy-012', '0'); await A.press('#u-yy-012', 'Enter'); await sleep(1500);
  check(alerts().length === n0 + 2, '알림 보내기를 끄면 이 폰은 안 보냄');
  await A.click('#gearBtn'); await A.waitForSelector('#settings:not([hidden])'); await A.check('#alertSend'); await A.click('#st-cancel');

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
  await C.click('#copyTableBtn');
  await C.waitForFunction(() => { const t = document.querySelector('#toast'); return !t.hidden && t.textContent.includes('복사'); }, null, { timeout: 5000 }).catch(() => {});
  check((await C.textContent('#toast')).includes('복사'), '표 복사 토스트');
  await C.click('#st-cancel');

  console.log('12) 다시 열어도 데이터 유지 + 다크 모드');
  await C.reload(); await C.waitForSelector('.item', { timeout: 20000 });
  check((await inputVal(C, '#u-yy-001')) === '122', '새로고침 후에도 122 유지');
  const D = await phone('D', { scheme: 'dark' });
  check(await D.isVisible('#setup'), '다크 모드에서 설정 화면 표시');

  console.log('12b) 예전 배치로 쓰던 폰: 열면 한 번만 정리되고, 새로 연결한 폰도 같은 숫자');
  const code2 = 'OLDL-AYOU-T234';
  const oldItems = [
    { id: 'pk-028', name: '쉬폰 비닐 미니', section: '포장·소모품', group: '쉬폰 포장', note: '', min: null, order: 1210, unopened: 30, opened: 1, t: { u: 1000, o: 0, m: 0, d: 0 }, b: { u: '윤호', o: '', m: '' } },
    { id: 'yh-026', name: '쉬폰 비닐 미니', section: '윤호 정리', group: '쉬폰·포장', note: '', min: null, order: 2250, unopened: 12, opened: null, t: { u: 2000, o: 0, m: 0, d: 0 }, b: { u: '윤호', o: '', m: '' } },
    { id: 'yh-001', name: '망고', section: '윤호 정리', group: '냉동과일·청', note: '', min: null, order: 2010, unopened: 3, opened: 1, t: { u: 0, o: 0, m: 500, d: 0 }, b: { u: '', o: '', m: '윤호' } },
    { id: 'nUSER1', name: '직접 추가한 시럽', section: '윤영 정리', group: '시럽', note: '', min: null, order: 480, unopened: 1, opened: null, t: { u: 300, o: 0, m: 300, d: 0 }, b: { u: '윤호', o: '', m: '윤호' } },
    { id: 'nUSER2', name: '쉬폰 리본', section: '윤호 정리', group: '쉬폰·포장', note: '', min: null, order: 2300, unopened: 5, opened: null, t: { u: 300, o: 0, m: 300, d: 0 }, b: { u: '윤호', o: '', m: '윤호' } },
    { id: 'yy-005', name: '유기농딸기', section: '윤영 정리', group: '유기농', note: '', min: null, order: 50, unopened: null, opened: null, t: { u: 0, o: 0, m: 0, d: 900 }, b: { u: '', o: '', m: '' } },
  ];
  const oldStore = { v: 1, items: oldItems, lastId: '', lastIdAt: 0, peers: {}, lastSnapAt: 0, lastSchedSnapAt: 0, dirtySinceSnap: false, daily: { day: '', n: 0 }, dirty: [] };
  const oldCfg = { name: '옛폰', code: code2, deviceId: 'dOLDPHONE', view: 'list', tab: '윤호 정리', hints: { pair: true, install: true } };
  const E = await phone('E', { init: [JSON.stringify(oldStore), JSON.stringify(oldCfg)] });
  await E.waitForSelector('.item', { timeout: 20000 });
  const stE = await storeOf(E); const itE = id => stE.items.find(i => i.id === id);
  check(itE('pk-028').unopened === 42 && itE('pk-028').t.u === 2001 && gone(itE('yh-026')), '고친 숫자끼리 합침 (30+12=42): ' + itE('pk-028').unopened);
  check(itE('yh-001').section === '과일·케이크' && itE('yh-001').t.m === 501, '옛 폰의 망고도 과일·케이크로');
  check(itE('nUSER1').section === '음료 재료' && itE('nUSER1').group === '시럽' && itE('nUSER2').section === '포장·소모품' && itE('nUSER2').group === '쉬폰 포장', '직접 추가한 항목도 분류 보고 옮김 (시럽 → 음료 재료, 쉬폰·포장 → 포장·소모품)');
  check((await E.$$eval('#tabs button', bs => bs.map(b => b.dataset.sec))).join('/') === '음료/음료 재료/과일·케이크/포장·소모품' && itE('yy-001').section === '음료', '옛 폰 구역 탭 4개 (두 단계 정리 모두 적용)');
  await E.reload(); await E.waitForSelector('.item', { timeout: 20000 });
  check((await storeOf(E)).items.find(i => i.id === 'pk-028').unopened === 42, '다시 열어도 두 번 더하지 않음');
  const F = await phone('F', { hash: '#j=' + code2 });
  await setupPhone(F, '사장님2');
  await F.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('cdm.store') || '{"items":[]}'); const it = s.items.find(i => i.id === 'pk-028'); return !!(it && it.unopened === 42); }, null, { timeout: 25000 });
  const stF = await storeOf(F);
  check(!stF.items.some(i => i.section === '윤호 정리' && !gone(i)), "새 폰에도 '윤호 정리' 없음, 숫자 42로 맞춰짐");
  await F.waitForFunction(() => { const it = JSON.parse(localStorage.getItem('cdm.store')).items.find(i => i.id === 'yy-005'); return !!(it && it.t.d === 900); }, null, { timeout: 25000 });
  await F.click('#gearBtn'); await F.waitForSelector('#settings:not([hidden])');
  await F.click('#resetBtn'); await F.click('#resetYes');
  await F.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('cdm.store')); const it = s.items.find(i => i.id === 'pk-028'); return !!(it && it.unopened === 38); }, null, { timeout: 5000 }).catch(() => {});
  const stF2 = await storeOf(F); const itF2 = id => stF2.items.find(i => i.id === id);
  check(itF2('pk-028').unopened === 38 && gone(itF2('yh-026')) && !stF2.items.some(i => i.section === '윤호 정리' && !gone(i)), '시트 값으로 초기화해도 합친 상태 유지 (38)');
  check(!gone(itF2('yy-005')) && itF2('yy-005').section === '음료' && itF2('yy-005').group === '유기농', '초기화로 되살린 항목은 새 배치 자리로 (유기농딸기 → 음료)');
  const bk = { app: 'cafedemung', v: 1, items: [{ id: 'yy-006', name: '유기농바나나', section: '윤영 정리', group: '유기농', note: '', min: null, order: 60, unopened: 5, opened: null, t: { u: Date.now(), o: 0, m: Date.now(), d: 0 }, b: { u: '옛폰', o: '', m: '옛폰' } }] };
  await F.setInputFiles('#restoreFile', { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bk)) });
  await F.waitForFunction(() => { const it = JSON.parse(localStorage.getItem('cdm.store')).items.find(i => i.id === 'yy-006'); return !!(it && it.unopened === 5); }, null, { timeout: 5000 });
  const it6 = (await storeOf(F)).items.find(i => i.id === 'yy-006');
  check(it6.section === '음료' && it6.group === '유기농', '예전 배치로 들어온 항목(백업·예전 버전 폰)도 새 자리로 옮김');

  console.log('12c) 코드 없이 누구나 (SHARED_CODE)');
  const SH = 'SHAR-EDCO-DE23';
  const S1 = await phone('S1', { shared: SH });
  await S1.waitForSelector('.item', { timeout: 20000 });
  check(await S1.isHidden('#setup') && await S1.isVisible('#nameHint'), '처음 설정 없이 바로 재고 화면, 이름 넣기는 선택');
  check(await S1.isVisible('#syncHint'), '아직 받은 숫자가 없으면 받아오는 중 안내');
  await S1.locator('.item[data-id="yy-003"] button.inc[data-f="u"]').click();
  check((await inputVal(S1, '#u-yy-003')) === '16', '받아오기 전에는 시트 숫자를 못 고침 (실제 숫자 덮어쓰기 방지)');
  await S1.click('#sh-start');
  check(await S1.isHidden('#syncHint'), '"처음 숫자로 시작"을 누르면 고칠 수 있음');
  check((await S1.evaluate(() => JSON.parse(localStorage.getItem('cdm.settings')).code)) === SH, '공용 코드로 연결');
  const S2 = await phone('S2', { shared: SH, hash: '#j=ZZZZ-ZZZZ-ZZZZ' });
  await S2.waitForSelector('.item', { timeout: 20000 });
  check((await S2.evaluate(() => location.hash)) === '' && (await S2.evaluate(() => JSON.parse(localStorage.getItem('cdm.settings')).code)) === SH, '예전 연결 링크로 열어도 공용 코드');
  await S2.waitForSelector('#syncHint', { state: 'hidden', timeout: 20000 });
  check(true, '새 폰은 다른 폰의 숫자를 받으면 바로 고칠 수 있음');
  await S1.locator('.item[data-id="yy-003"] button.inc[data-f="u"]').click();
  await S2.waitForFunction(() => document.querySelector('#u-yy-003').value === '17', null, { timeout: 20000 });
  check(true, '이름도 코드도 없이 숫자가 다른 폰에 전달');
  await S2.fill('#nh-name', '손님'); await S2.click('#nh-save');
  check(await S2.isHidden('#nameHint') && (await S2.evaluate(() => JSON.parse(localStorage.getItem('cdm.settings')).name)) === '손님', '이름 넣기 저장');
  const oldOwnCfg = { name: '사장님', code: 'OWNC-ODEX-YZ23', deviceId: 'dOWNER', view: 'list', tab: '음료', hints: { pair: true, install: true }, layout: 2 };
  const ownItems = [{ id: 'yy-001', name: '탄산수', section: '음료', group: '탄산·스파클링', note: '', min: null, order: 10, unopened: 77, opened: 2, t: { u: Date.now() - 60000, o: Date.now() - 60000, m: 2, d: 0 }, b: { u: '사장님', o: '사장님', m: '' } }];
  const S3 = await phone('S3', { shared: SH, init: [JSON.stringify({ ...oldStore, items: ownItems }), JSON.stringify(oldOwnCfg)] });
  await S3.waitForSelector('.item', { timeout: 20000 });
  check((await S3.evaluate(() => JSON.parse(localStorage.getItem('cdm.settings')).code)) === SH && await S3.isHidden('#nameHint'), '코드를 쓰던 폰도 공용 코드로 옮김 (이름 유지)');
  await S1.waitForFunction(() => document.querySelector('#u-yy-001').value === '77', null, { timeout: 20000 });
  check(true, '옮겨온 폰의 숫자(탄산수 77)가 다른 폰에도 반영');
  await S1.click('#gearBtn'); await S1.waitForSelector('#settings:not([hidden])');
  check((await S1.textContent('#codeBox')).startsWith('http') && await S1.isHidden('#st-code-f'), '설정에 코드 대신 주소, 코드 바꾸기 칸 숨김');
  await S1.click('#st-cancel');

  if (process.env.REAL_NTFY === '1') {
    console.log('13) 실제 ntfy.sh로 동기화 (실패해도 치명적 아님)');
    try {
      const realCode = 'T' + Math.random().toString(36).slice(2, 13).toUpperCase().replace(/[^A-Z0-9]/g, 'X').padEnd(11, 'X');
      const R1 = await phone('R1', { ntfy: 'https://ntfy.sh' }); await setupPhone(R1, '윤호', realCode);
      await R1.click('#sh-start');   // 새 코드의 첫 폰: 시트 숫자로 시작
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
