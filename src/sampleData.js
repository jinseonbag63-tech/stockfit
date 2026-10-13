// API 키가 없거나 DART 호출이 실패했을 때 쓰는 예시(가상) 데이터
// 실제 기업의 현재 수치가 아니에요. 화면 시연용입니다.
export const SAMPLE = {
  '005930': { info: { market: 'Y', industryCode: '264' },
    metrics: { debtRatio: 27, currentRatio: 250, interestCoverage: 40, altmanZ: 4.1, operatingMargin: 11, roe: 9,
      grossProfitability: 22, accruals: -4, revenueGrowth: 8, revenueCagr3y: 4, growthConsistency: 50,
      dividendYield: 2.4, payoutRatio: 30, dividendStreak: 3, dividendCut: false } },
  '000660': { info: { market: 'Y', industryCode: '261' },
    metrics: { debtRatio: 55, currentRatio: 160, interestCoverage: 18, altmanZ: 3.0, operatingMargin: 28, roe: 25,
      grossProfitability: 30, accruals: -6, revenueGrowth: 45, revenueCagr3y: 20, growthConsistency: 75,
      dividendYield: 0.8, payoutRatio: 8, dividendStreak: 3, dividendCut: false } },
  '005380': { info: { market: 'Y', industryCode: '301' },
    metrics: { debtRatio: 180, currentRatio: 110, interestCoverage: 6, altmanZ: 1.6, operatingMargin: 8, roe: 12,
      grossProfitability: 14, accruals: 2, revenueGrowth: 6, revenueCagr3y: 9, growthConsistency: 75,
      dividendYield: 5.5, payoutRatio: 25, dividendStreak: 3, dividendCut: false } },
};

// 예시 재무 체크리스트 (가상)
const SAMPLE_CHECKLIST = {
  '005930': [true, true, false, true, true, true, true, false, false],
  '000660': [true, true, true, true, true, false, true, true, true],
  '005380': [true, true, true, false, false, true, true, true, true],
};
const CHECK_LABELS = [
  ['이익을 냈어요', '손실을 냈어요'], ['본업으로 현금이 들어왔어요', '본업에서 현금이 빠져나갔어요'],
  ['자산 대비 이익률이 좋아졌어요', '자산 대비 이익률이 나빠졌어요'], ['이익보다 실제 들어온 현금이 많아요', '이익에 비해 실제 들어온 현금이 적어요'],
  ['장기 빚 비중이 줄었어요', '장기 빚 비중이 늘었어요'], ['단기 지급 능력이 좋아졌어요', '단기 지급 능력이 나빠졌어요'],
  ['새 주식을 발행하지 않았어요', '새 주식을 발행했어요 (자본금 증가)'], ['매출총이익률이 좋아졌어요', '매출총이익률이 나빠졌어요'],
  ['자산을 더 효율적으로 써서 매출을 냈어요', '자산 대비 매출이 줄었어요'],
];

// 예시 데이터가 없는 종목이면 null
export function getSample(stock) {
  const s = SAMPLE[stock.code];
  if (!s) return null;
  const items = SAMPLE_CHECKLIST[stock.code].map((pass, i) => ({ label: CHECK_LABELS[i][pass ? 0 : 1], pass }));
  return {
    year: null, source: '예시 데이터 (가상 수치)', sample: true, info: s.info, metrics: { ...s.metrics },
    checklist: { items, passed: items.filter(i => i.pass).length, total: items.length },
  };
}
