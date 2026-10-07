// 카페드멍 재고체크 설정
// Apps Script 웹 앱을 배포한 뒤 나온 URL(https://script.google.com/macros/s/…/exec)을 API_URL에 넣으세요.
// 비워두면 앱이 처음 열릴 때 주소를 물어보고, 그 폰에만 저장합니다.
window.CDM_CONFIG = {
  API_URL: "",
  POLL_MS: 8000, // 다른 사람이 바꾼 숫자를 다시 읽어오는 간격(밀리초). 2분간 손대지 않으면 20초로 늘어남
};
