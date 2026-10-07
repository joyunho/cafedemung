/**
 * 카페드멍 재고체크 — Apps Script 백엔드
 *
 * 쓰는 법 (README.md에 자세히):
 *  1. 새 구글 스프레드시트를 만들고 (원본 재고 시트는 그대로 둠) 확장 프로그램 → Apps Script 를 연다.
 *  2. 이 파일 내용을 전부 붙여넣고, 아래 PIN을 바꾼 뒤 저장한다.
 *  3. 함수 선택에서 setup 을 고르고 실행 → 권한 허용. "재고" 탭과 초기 항목 108개가 만들어진다.
 *  4. 배포 → 새 배포 → 웹 앱 → 실행 계정: 나 / 액세스: 모든 사용자 → 배포. 나온 URL을 앱에 넣는다.
 *
 * 코드를 고친 뒤에는 "배포 → 배포 관리 → 연필 → 새 버전"으로 다시 배포해야 반영된다.
 */

const PIN = '0000';            // ← 꼭 바꿔주세요. 앱에서 입력하는 가게 공용 비밀번호
const SHEET_NAME = '재고';

const HEADERS = ['id', '구역', '분류', '항목', '안뜯은거', '뜯은거', '메모', '최소수량', '수정시각', '수정자'];
const COL = { id: 1, section: 2, group: 3, name: 4, unopened: 5, opened: 6, note: 7, min: 8, updatedAt: 9, updatedBy: 10 };
const EDITABLE = { section: 'str', group: 'str', name: 'str', note: 'str', unopened: 'num', opened: 'num', min: 'num' };

// ---------- 처음 한 번: 시트 만들고 기존 재고 시트의 항목을 넣기 ----------
function setup() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME, 0);
  if (sh.getLastRow() >= 2) {
    formatSheet(sh);
    alert_('"' + SHEET_NAME + '" 탭에 이미 데이터가 있어서 초기 항목은 넣지 않고 서식만 맞췄어요.');
    return;
  }
  sh.clear();
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  const rows = SEED.map(r => [r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], '', '']);
  sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  formatSheet(sh);
  alert_('초기 항목 ' + rows.length + '개를 넣었어요. 이제 "배포 → 새 배포"로 웹 앱을 배포하세요.');
}

function formatSheet(sh) {
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#e9ede4');
  const widths = { section: 110, group: 130, name: 230, unopened: 80, opened: 70, note: 220, min: 80, updatedAt: 140, updatedBy: 110 };
  Object.keys(widths).forEach(k => sh.setColumnWidth(COL[k], widths[k]));
  sh.hideColumns(COL.id);
  const n = Math.max(sh.getMaxRows() - 1, 1);
  sh.getRange(2, COL.updatedAt, n, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  const zero = SpreadsheetApp.newConditionalFormatRule()
    .whenNumberEqualTo(0).setBackground('#f8ded9').setFontColor('#b03527')
    .setRanges([sh.getRange(2, COL.unopened, n, 1)]).build();
  sh.setConditionalFormatRules([zero]);
}

function alert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

// ---------- 시트에서 직접 고치면 수정시각/수정자 자동 기록 ----------
function onEdit(e) {
  try {
    const sh = e.range.getSheet();
    if (sh.getName() !== SHEET_NAME) return;
    const r = e.range.getRow(), c = e.range.getColumn(), n = e.range.getNumRows();
    if (r < 2 || c >= COL.updatedAt) return;
    sh.getRange(r, COL.updatedAt, n, 1).setValue(new Date());
    sh.getRange(r, COL.updatedBy, n, 1).setValue('시트에서 직접');
  } catch (err) { /* 무시 */ }
}

// ---------- 웹 앱 진입점 ----------
function doGet() {
  return out_({ ok: true, app: '카페드멍 재고 API', hint: '이 주소를 앱의 "앱 주소" 칸에 넣으세요.' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'badrequest' }); }
  if (String(body.pin || '') !== String(PIN)) return out_({ ok: false, error: 'pin' });
  const by = String(body.by || '').trim().slice(0, 30) || '누군가';
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) return out_({ ok: false, error: 'nosheet' });

  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { return out_({ ok: false, error: 'locked' }); }
  try {
    switch (body.action) {
      case 'list':   return out_({ ok: true, items: readAll_(sh), sheetUrl: ss.getUrl(), now: new Date().toISOString() });
      case 'update': return out_(updateItem_(sh, body, by));
      case 'add':    return out_(addItem_(sh, body, by));
      case 'delete': return out_(deleteItem_(sh, body));
      default:       return out_({ ok: false, error: 'badrequest' });
    }
  } catch (err) {
    return out_({ ok: false, error: 'error', message: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------- 읽기/쓰기 ----------
function readAll_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const items = [];
  values.forEach((row, i) => {
    const name = String(row[COL.name - 1] || '').trim();
    if (!name) return;                                   // 빈 줄은 건너뜀
    let id = String(row[COL.id - 1] || '').trim();
    if (!id) {                                           // 시트에서 직접 추가한 줄에 id 부여
      id = newId_(); row[COL.id - 1] = id;
      sh.getRange(i + 2, COL.id).setValue(id);
    }
    items.push(rowToItem_(row, i + 2));
  });
  return items;
}

function rowToItem_(row, rowNum) {
  return {
    id: String(row[COL.id - 1]).trim(), row: rowNum,
    section: String(row[COL.section - 1] || '').trim(),
    group: String(row[COL.group - 1] || '').trim(),
    name: String(row[COL.name - 1] || '').trim(),
    unopened: toNum_(row[COL.unopened - 1]),
    opened: toNum_(row[COL.opened - 1]),
    note: String(row[COL.note - 1] == null ? '' : row[COL.note - 1]),
    min: toNum_(row[COL.min - 1]),
    updatedAt: toIso_(row[COL.updatedAt - 1]),
    updatedBy: String(row[COL.updatedBy - 1] == null ? '' : row[COL.updatedBy - 1]),
  };
}

function updateItem_(sh, body, by) {
  const id = String(body.id || '');
  const patch = (body.patch && typeof body.patch === 'object') ? body.patch : {};
  const r = findRow_(sh, id);
  if (!r) return { ok: false, error: 'notfound' };
  Object.keys(EDITABLE).forEach(k => {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) return;
    const v = patch[k];
    const cell = sh.getRange(r, COL[k]);
    if (EDITABLE[k] === 'num') { const n = toNum_(v); cell.setValue(n === null ? '' : n); }
    else cell.setValue(String(v == null ? '' : v).slice(0, 200));
  });
  sh.getRange(r, COL.updatedAt).setValue(new Date());
  sh.getRange(r, COL.updatedBy).setValue(by);
  return { ok: true, item: rowToItem_(sh.getRange(r, 1, 1, HEADERS.length).getValues()[0], r) };
}

function addItem_(sh, body, by) {
  const it = (body.item && typeof body.item === 'object') ? body.item : {};
  const name = String(it.name || '').trim();
  if (!name) return { ok: false, error: 'badrequest' };
  const section = String(it.section || '기타').trim() || '기타';
  const row = [newId_(), section, String(it.group || '기타').trim() || '기타', name,
    numCell_(it.unopened), numCell_(it.opened), String(it.note || '').slice(0, 200), numCell_(it.min), new Date(), by];
  // 같은 구역의 마지막 줄 바로 아래에 넣어 시트에서도 구역별로 모여 보이게 한다
  const last = sh.getLastRow();
  let after = 0;
  if (last >= 2) {
    const secs = sh.getRange(2, COL.section, last - 1, 1).getValues();
    for (let i = secs.length - 1; i >= 0; i--) if (String(secs[i][0]).trim() === section) { after = i + 2; break; }
  }
  let r;
  if (after) { sh.insertRowAfter(after); r = after + 1; sh.getRange(r, 1, 1, HEADERS.length).setValues([row]); }
  else { sh.appendRow(row); r = sh.getLastRow(); }
  return { ok: true, item: rowToItem_(sh.getRange(r, 1, 1, HEADERS.length).getValues()[0], r) };
}

function deleteItem_(sh, body) {
  const r = findRow_(sh, String(body.id || ''));
  if (!r) return { ok: false, error: 'notfound' };
  sh.deleteRow(r);
  return { ok: true };
}

function findRow_(sh, id) {
  const last = sh.getLastRow();
  if (last < 2 || !id) return 0;
  const ids = sh.getRange(2, COL.id, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]).trim() === id) return i + 2;
  return 0;
}

function toNum_(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}
function numCell_(v) { const n = toNum_(v); return n === null ? '' : n; }
function toIso_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}
function newId_() { return 'i-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ---------- 초기 항목: 기존 재고 시트(시트1)에서 옮겨온 값 ----------
// [id, 구역, 분류, 항목, 안뜯은거, 뜯은거, 메모, 최소수량]
const SEED = [
  ["yy-001", "윤영 정리", "음료·우유", "탄산수", 120, "", "", ""],
  ["yy-002", "윤영 정리", "음료·우유", "수입멸균우유(박스로체크)", 2, "", "", ""],
  ["yy-003", "윤영 정리", "음료·우유", "애플스파클링", 16, "", "", ""],
  ["yy-004", "윤영 정리", "음료·우유", "애플 기본", 30, "", "", ""],
  ["yy-005", "윤영 정리", "유기농", "유기농딸기", "", "", "", ""],
  ["yy-006", "윤영 정리", "유기농", "유기농바나나", "", "", "", ""],
  ["yy-007", "윤영 정리", "유기농", "유기농코코아", "", "", "", ""],
  ["yy-008", "윤영 정리", "유기농", "유기농딸기주스", "", "", "", ""],
  ["yy-009", "윤영 정리", "유기농", "유기농오렌지주스", "", "", "", ""],
  ["yy-010", "윤영 정리", "유기농", "유기농포도주스", "", "", "", ""],
  ["yy-011", "윤영 정리", "뽀로로", "뽀로로딸기", 36, "", "", ""],
  ["yy-012", "윤영 정리", "뽀로로", "뽀로로밀크", 16, "", "", ""],
  ["yy-013", "윤영 정리", "기타 재료", "립톤아이스티", "", "", "", ""],
  ["yy-014", "윤영 정리", "기타 재료", "펌킨페이스트", "", "", "", ""],
  ["yy-015", "윤영 정리", "티백", "캐모마일", 3, 1, "", ""],
  ["yy-016", "윤영 정리", "티백", "녹차", 9, 1, "", ""],
  ["yy-017", "윤영 정리", "티백", "얼그레이", 5, "", "", ""],
  ["yy-018", "윤영 정리", "티백", "페퍼민트", 3, 1, "", ""],
  ["yy-019", "윤영 정리", "티백", "루이보스", 8, "", "", ""],
  ["yy-020", "윤영 정리", "시럽", "헤이즐넛시럽", 3, 1, "", ""],
  ["yy-021", "윤영 정리", "시럽", "바닐라시럽", 3, 1, "", ""],
  ["yy-022", "윤영 정리", "시럽", "카라멜시럽", 7, 2, "", ""],
  ["yy-023", "윤영 정리", "시럽", "설탕시럽", 7, 2, "", ""],
  ["yy-024", "윤영 정리", "시럽", "블루시럽(절반남으면수첩에적기", 1, 1, "", ""],
  ["yy-025", "윤영 정리", "토핑·잼", "딸기잼", "", "", "", ""],
  ["yy-026", "윤영 정리", "토핑·잼", "미니웨하스", 3, 1, "", ""],
  ["yy-027", "윤영 정리", "토핑·잼", "아몬드", 2, 2, "", ""],
  ["yy-028", "윤영 정리", "토핑·잼", "발사믹", 1, "", "", ""],
  ["yy-029", "윤영 정리", "파우더", "오곡파우더", 7, 1, "", ""],
  ["yy-030", "윤영 정리", "파우더", "녹차파우더", 3, 1, "", ""],
  ["yy-031", "윤영 정리", "파우더", "쑥파우더", 4, 1, "", ""],
  ["yy-032", "윤영 정리", "파우더", "초코파우더", 6, 1, "", ""],
  ["yy-033", "윤영 정리", "파우더", "쿠앤크파우더", 6, 1, "", ""],
  ["yy-034", "윤영 정리", "파우더", "요거트파우더", 4, 1, "", ""],
  ["yy-035", "윤영 정리", "파우더", "시나몬스틱", 1, 1, "", ""],
  ["yy-036", "윤영 정리", "파우더", "시나몬분말", 3, 1, "", ""],
  ["yy-037", "윤영 정리", "파우더", "쿠앤크분태", 3, 1, "", ""],
  ["yy-038", "윤영 정리", "아이스티·기타", "아이스티 피치", 2, 1, "", ""],
  ["yy-039", "윤영 정리", "아이스티·기타", "아이스티 레몬", "", "", "", ""],
  ["yy-040", "윤영 정리", "아이스티·기타", "바닐라빈 파우더", "", "", "", ""],
  ["yy-041", "윤영 정리", "아이스티·기타", "제로 스윗 복숭아 아이스티", "", "", "", ""],
  ["yy-042", "윤영 정리", "스무디", "망고스무디", 4, 1, "", ""],
  ["yy-043", "윤영 정리", "스무디", "딸기스무디", 5, 1, "", ""],
  ["yy-044", "윤영 정리", "기라델리", "기라델리 초코", 4, 1, "", ""],
  ["yy-045", "윤영 정리", "기라델리", "기라델리 카라멜", 3, 1, "", ""],
  ["yy-046", "윤영 정리", "분다버그", "분다버그 자몽", 20, "", "", ""],
  ["yy-047", "윤영 정리", "분다버그", "분다버그 레몬,라임", 12, "", "", ""],
  ["pk-001", "포장·소모품", "컵·뚜껑", "아이스컵", 1, 1, "", ""],
  ["pk-002", "포장·소모품", "컵·뚜껑", "핫컵", 1, 1, "", ""],
  ["pk-003", "포장·소모품", "컵·뚜껑", "돔뚜껑", 1, 1, "", ""],
  ["pk-004", "포장·소모품", "컵·뚜껑", "플랫뚜껑", 0, 2, "", ""],
  ["pk-005", "포장·소모품", "컵·뚜껑", "무타공", 0, 1, "", ""],
  ["pk-006", "포장·소모품", "컵·뚜껑", "핫뚜껑", 3, 1, "", ""],
  ["pk-007", "포장·소모품", "컵·뚜껑", "캐리어", 3, 1, "", ""],
  ["pk-008", "포장·소모품", "빨대·종이백", "스무디빨대", 1, 1, "", ""],
  ["pk-009", "포장·소모품", "빨대·종이백", "일반빨대", 0, 1, "1(7)", ""],
  ["pk-010", "포장·소모품", "빨대·종이백", "포장빨대", 0, 1, "1(6)", ""],
  ["pk-011", "포장·소모품", "빨대·종이백", "손잡이종이백", 0, 1, "", ""],
  ["pk-012", "포장·소모품", "빨대·종이백", "와이드종이백", "", 1, "?", ""],
  ["pk-013", "포장·소모품", "빨대·종이백", "크라프트지별대", 1, 1, "", ""],
  ["pk-014", "포장·소모품", "빨대·종이백", "크라프트지 특대", 2, 1, "", ""],
  ["pk-015", "포장·소모품", "실링·컵홀더", "실링지", 0, 1, "", ""],
  ["pk-016", "포장·소모품", "실링·컵홀더", "컵홀더핫", 0, 1, "", ""],
  ["pk-017", "포장·소모품", "실링·컵홀더", "컵홀더아이스", 2, 1, "", ""],
  ["pk-018", "포장·소모품", "커트러리·봉투", "포크", 2, "", "", ""],
  ["pk-019", "포장·소모품", "커트러리·봉투", "나이프", 1, "", "", ""],
  ["pk-020", "포장·소모품", "커트러리·봉투", "배달봉투", "", 5, "", ""],
  ["pk-021", "포장·소모품", "커트러리·봉투", "검정봉투", 0, 1, "", ""],
  ["pk-022", "포장·소모품", "커트러리·봉투", "분리수거봉투", 0, 1, "", ""],
  ["pk-023", "포장·소모품", "스낵·냅킨·빌지", "프렛즐", "", 1, "1(4)", ""],
  ["pk-024", "포장·소모품", "스낵·냅킨·빌지", "쿠앤크", 0, 0, "", ""],
  ["pk-025", "포장·소모품", "스낵·냅킨·빌지", "옥수수", 1, 1, "1(5)", ""],
  ["pk-026", "포장·소모품", "스낵·냅킨·빌지", "냅킨", 0, 1, "", ""],
  ["pk-027", "포장·소모품", "스낵·냅킨·빌지", "빌지", 1, 1, "1(10)", ""],
  ["pk-028", "포장·소모품", "쉬폰 포장", "쉬폰 비닐 미니", 28, 1, "", ""],
  ["pk-029", "포장·소모품", "쉬폰 포장", "쉬폰 비닐 1호", 0, "", "", ""],
  ["pk-030", "포장·소모품", "쉬폰 포장", "쉬폰 미니 받침", 10, "", "원본 시트 I열에 1 적혀 있음", ""],
  ["pk-031", "포장·소모품", "쉬폰 포장", "쉬폰 1호 받침", 4, "", "", ""],
  ["pk-032", "포장·소모품", "OPP 봉투", "15*18 OPP 봉투", 10, "", "", ""],
  ["pk-033", "포장·소모품", "OPP 봉투", "25*18 OPP 봉투", 4, "", "", ""],
  ["yh-001", "윤호 정리", "냉동과일·청", "망고", 3, 1, "", ""],
  ["yh-002", "윤호 정리", "냉동과일·청", "블루베리", 5, 1, "", ""],
  ["yh-003", "윤호 정리", "냉동과일·청", "레드커런트", 0, 1, "", ""],
  ["yh-004", "윤호 정리", "냉동과일·청", "복숭아", 3, 1, "", ""],
  ["yh-005", "윤호 정리", "냉동과일·청", "딸기청", 12, 0, "", ""],
  ["yh-006", "윤호 정리", "냉동과일·청", "아포가또아이스크림", 0, 1, "", ""],
  ["yh-007", "윤호 정리", "케이크", "딸기", 0, 0, "", ""],
  ["yh-008", "윤호 정리", "케이크", "초코", 0, 0, "", ""],
  ["yh-009", "윤호 정리", "케이크", "초코딸기", 2, 0, "", ""],
  ["yh-010", "윤호 정리", "케이크", "고구마", 5, 0, "", ""],
  ["yh-011", "윤호 정리", "케이크", "포레스트", 0, 0, "", ""],
  ["yh-012", "윤호 정리", "케이크", "치즈", 0, 0, "", ""],
  ["yh-013", "윤호 정리", "케이크", "우유", 0, 0, "", ""],
  ["yh-014", "윤호 정리", "케이크", "오레오", 0, "", "", ""],
  ["yh-015", "윤호 정리", "케이크", "레몬주스", 1, 0, "", ""],
  ["yh-016", "윤호 정리", "베이스", "복숭아", 3, 0, "", ""],
  ["yh-017", "윤호 정리", "베이스", "레몬", 2, 1, "", ""],
  ["yh-018", "윤호 정리", "베이스", "자몽", 4, 1, "", ""],
  ["yh-019", "윤호 정리", "베이스", "청포도", 3, 1, "", ""],
  ["yh-020", "윤호 정리", "베이스", "블루베리", 3, 1, "", ""],
  ["yh-021", "윤호 정리", "베이스", "참외", 0, 0, "", ""],
  ["yh-022", "윤호 정리", "쉬폰·포장", "쉬폰 받침 미니", 4, "", "", ""],
  ["yh-023", "윤호 정리", "쉬폰·포장", "쉬폰 받침 1호", 5, "", "", ""],
  ["yh-024", "윤호 정리", "쉬폰·포장", "18x25", 7, "", "", ""],
  ["yh-025", "윤호 정리", "쉬폰·포장", "18x15", 9, "", "", ""],
  ["yh-026", "윤호 정리", "쉬폰·포장", "쉬폰 비닐 미니", 10, "", "", ""],
  ["yh-027", "윤호 정리", "쉬폰·포장", "쉬폰 비닐 1호", 0, "", "", ""],
  ["yh-028", "윤호 정리", "쉬폰·포장", "냅킨", 12, "", "", ""]
];
