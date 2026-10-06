// 키가 없을 때(예시 데이터 모드) 쓰는 기본 종목 목록
// 키가 있으면 src/corpCodes.js가 DART에서 상장사 전체 목록을 받아와요.
export const FALLBACK_STOCKS = [
  { code: '005930', corpCode: '00126380', name: '삼성전자', engName: 'SAMSUNG ELECTRONICS' },
  { code: '000660', corpCode: '00164779', name: 'SK하이닉스', engName: 'SK hynix' },
  { code: '005380', corpCode: '00164742', name: '현대자동차', engName: 'HYUNDAI MOTOR' },
];

// 첫 화면에 보여줄 빠른 선택 종목 (종목코드 기준)
// 통신주(SK텔레콤, KT)는 배당·안정형 성향과의 대비를 보여주기 좋아요.
export const QUICK_PICKS = ['005930', '000660', '005380', '017670', '030200'];

// 사람들이 흔히 부르는 이름 → DART에 등록된 이름
export const ALIASES = {
  '현대차': '현대자동차',
  '하이닉스': 'SK하이닉스',
  '삼전': '삼성전자',
  '엔솔': 'LG에너지솔루션',
  '카뱅': '카카오뱅크',
};
