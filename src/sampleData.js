// API 키가 없거나 DART 호출이 실패했을 때 쓰는 예시(가상) 데이터
// 실제 기업의 현재 수치가 아니에요. 화면 시연용입니다.
export const SAMPLE = {
  '005930': { info: { market: 'Y', industryCode: '264' }, metrics: { debtRatio: 27, operatingMargin: 11, roe: 9, revenueGrowth: 8, dividendYield: 2.4, payoutRatio: 30 } },
  '000660': { info: { market: 'Y', industryCode: '261' }, metrics: { debtRatio: 55, operatingMargin: 28, roe: 25, revenueGrowth: 45, dividendYield: 0.8, payoutRatio: 8 } },
  '005380': { info: { market: 'Y', industryCode: '301' }, metrics: { debtRatio: 180, operatingMargin: 8, roe: 12, revenueGrowth: 6, dividendYield: 5.5, payoutRatio: 25 } },
};

// 예시 데이터가 없는 종목이면 null
export function getSample(stock) {
  const s = SAMPLE[stock.code];
  if (!s) return null;
  return { year: null, source: '예시 데이터 (가상 수치)', sample: true, info: s.info, metrics: { ...s.metrics } };
}
