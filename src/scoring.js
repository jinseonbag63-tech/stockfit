// 적합도 점수 계산 로직 (v0)
// 1) 설문 → 투자성향(금융투자협회 5단계 이름으로 간이 매핑) + 기준별 가중치
// 2) 종목 지표 → 기준별 점수(0~100)
// 3) 가중 평균 → 적합도(0~100), 기준별 기여도를 함께 반환

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// v가 zero일 때 0점, full일 때 100점이 되도록 직선으로 환산 (방향은 두 값의 순서로 결정)
const scale = (v, zero, full) => (v == null ? null : clamp(((v - zero) / (full - zero)) * 100, 0, 100));
const avg = arr => { const xs = arr.filter(x => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };

// 기준표: 어떤 지표가 몇일 때 0점/100점인지 (발표 때 근거로 설명할 부분, 추후 조정)
export const CRITERIA = {
  stability:     { label: '안정성', rule: '부채비율 200% 이상 0점 → 50% 이하 100점',
                   score: m => scale(m.debtRatio, 200, 50) },
  profitability: { label: '수익성', rule: '영업이익률 0%→0점, 20%→100점 / ROE 0%→0점, 15%→100점 (평균)',
                   score: m => avg([scale(m.operatingMargin, 0, 20), scale(m.roe, 0, 15)]) },
  growth:        { label: '성장성', rule: '매출 성장률 -10% 이하 0점 → 20% 이상 100점',
                   score: m => scale(m.revenueGrowth, -10, 20) },
  dividend:      { label: '배당',   rule: '배당수익률 0%→0점, 4% 이상 100점',
                   score: m => scale(m.dividendYield, 0, 4) },
};

export const RISK_LEVELS = ['안정형', '안정추구형', '위험중립형', '적극투자형', '공격투자형'];

// 설문 답변 형식: { q1: 'steady'|'growth'|'dividend', q2: 'short'|'long', q3: 'calm'|'growth' }
export function buildProfile({ q1 = 'steady', q2 = 'long', q3 = 'calm' } = {}) {
  // 위험 감수 점수(0~4) → 5단계 성향
  const risk = ({ steady: 0, dividend: 1, growth: 2 }[q1] ?? 0)
    + (q2 === 'long' ? 1 : 0) + (q3 === 'growth' ? 1 : 0);

  const w = { stability: 1, profitability: 1, growth: 1, dividend: 1 };
  if (q1 === 'steady')   { w.stability += 1.5; w.profitability += 1; }
  if (q1 === 'growth')   { w.growth += 2; }
  if (q1 === 'dividend') { w.dividend += 2; w.stability += 0.5; }
  if (q2 === 'short')    { w.stability += 0.5; }
  if (q2 === 'long')     { w.growth += 0.5; }
  if (q3 === 'calm')     { w.stability += 1; w.growth = Math.max(0.25, w.growth - 0.5); }
  if (q3 === 'growth')   { w.growth += 1; }

  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const weights = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total]));
  return { answers: { q1, q2, q3 }, riskLevel: RISK_LEVELS[risk], weights };
}

export function computeFit(metrics, profile) {
  const parts = Object.entries(CRITERIA).map(([key, c]) => ({
    key, label: c.label, rule: c.rule, score: c.score(metrics), weight: profile.weights[key],
  }));
  // 데이터가 없는 기준은 빼고 나머지 가중치를 다시 100%로 맞춤
  const usable = parts.filter(p => p.score != null);
  const wSum = usable.reduce((a, p) => a + p.weight, 0) || 1;
  for (const p of parts) {
    p.appliedWeight = p.score == null ? 0 : p.weight / wSum;
    p.contribution = p.score == null ? 0 : p.score * p.appliedWeight;
  }
  const total = Math.round(parts.reduce((a, p) => a + p.contribution, 0));
  const verdict = total >= 80 ? '내 기준과 잘 맞는 편이에요'
    : total >= 60 ? '대체로 맞지만 확인할 부분이 있어요'
    : total >= 40 ? '일부 기준만 맞아요'
    : '내 기준과는 잘 맞지 않아요';
  return { total, verdict, parts };
}
