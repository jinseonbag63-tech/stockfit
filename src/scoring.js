// 적합도 점수 계산 (v1)
// 1) 설문 → 투자성향(금융투자협회 5단계 이름) + 기준별 가중치 (+ 고금리면 안정성 비중↑)
// 2) 지표마다 0~100점: 같은 업종 회사가 충분하면 업종 안 순위(백분위), 아니면 고정 기준표
// 3) 기준 점수 = 지표 점수 평균, 적합도 = 기준 점수 × 가중치의 합 (데이터 없는 기준은 빼고 비중 재조정)
// 4) 주가 위험 등급이 내 성향이 감당할 수 있는 수준을 넘으면 점수를 낮추고 경고 (적합성 원칙 구조를 따름)
// 같은 입력이면 언제나 같은 점수가 나와요.
import { RISK_LEVELS, riskFromAnswers } from '../public/survey.js';

export { RISK_LEVELS };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
// v가 zero일 때 0점, full일 때 100점이 되도록 직선으로 환산 (방향은 두 값의 순서로 결정)
const scale = (v, zero, full) => (v == null ? null : clamp(((v - zero) / (full - zero)) * 100, 0, 100));
const avg = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const CRITERIA = {
  stability: { label: '안정성', about: '빚 부담, 단기 지급 능력, 이자 감당 능력, 부실 위험' },
  profitability: { label: '수익성', about: '본업 이익률, 자본 대비 이익, 자산 대비 매출총이익, 이익의 질' },
  growth: { label: '성장성', about: '최근 1년·3년 매출 성장, 성장의 꾸준함' },
  dividend: { label: '배당', about: '배당수익률, 국고채 금리와의 차이, 배당 지속 가능성, 연속 배당' },
  valuation: { label: '가격 수준', about: '이익·자산 대비 주가 (PER, PBR)' },
  volatility: { label: '주가 안정성', about: '최근 1년 주가 변동 폭과 최대 하락폭' },
};

function payoutScore(v, m) {
  if (m.dividendStreak === 0) return 0; // 최근 3년 배당 없음
  if (v == null) return null;
  if (v <= 0 || v > 100) return 0;
  if (v > 80) return 30;
  if (v > 60) return 60;
  if (v >= 20) return 100;
  return 70;
}

// 지표별 기준표. peer: 업종 비교에 쓸 수 있는 지표 (업종 데이터가 있으면 기준표 대신 업종 안 순위)
export const METRICS = {
  debtRatio: { criterion: 'stability', label: '부채비율', higher: false, fixed: [200, 50], peer: true, rule: '200% 이상 0점 → 50% 이하 100점' },
  currentRatio: { criterion: 'stability', label: '유동비율', higher: true, fixed: [50, 200], peer: true, rule: '50% 이하 0점 → 200% 이상 100점' },
  interestCoverage: { criterion: 'stability', label: '이자보상배율', higher: true, fixed: [1, 10], rule: '1배 이하 0점 → 10배 이상 100점' },
  altmanZ: { criterion: 'stability', label: '부실위험 점수 (Altman Z″)', higher: true, fixed: [1.1, 2.6], rule: '1.1 이하(위험 구간) 0점 → 2.6 이상(안전 구간) 100점' },

  operatingMargin: { criterion: 'profitability', label: '영업이익률', higher: true, fixed: [0, 20], peer: true, rule: '0% 이하 0점 → 20% 이상 100점' },
  roe: { criterion: 'profitability', label: 'ROE', higher: true, fixed: [0, 15], peer: true, rule: '0% 이하 0점 → 15% 이상 100점' },
  grossProfitability: { criterion: 'profitability', label: '총자산 대비 매출총이익', higher: true, fixed: [0, 40], rule: '0% 0점 → 40% 이상 100점' },
  accruals: { criterion: 'profitability', label: '이익의 질 (발생액 비율)', higher: false, fixed: [10, -5], rule: '(순이익−영업현금흐름)/총자산 10% 이상 0점 → −5% 이하 100점' },

  revenueGrowth: { criterion: 'growth', label: '매출 성장률 (1년)', higher: true, fixed: [-10, 20], peer: true, rule: '−10% 이하 0점 → 20% 이상 100점' },
  revenueCagr3y: { criterion: 'growth', label: '매출 성장률 (3년 평균)', higher: true, fixed: [-5, 15], peer: true, rule: '연 −5% 이하 0점 → 연 15% 이상 100점' },
  growthConsistency: { criterion: 'growth', label: '성장의 꾸준함', higher: true, fixed: [0, 100], rule: '최근 2년 매출·영업이익이 전년보다 늘어난 비율' },

  dividendYield: { criterion: 'dividend', label: '배당수익률', higher: true, fixed: [0, 4], rule: '0% 0점 → 4% 이상 100점' },
  dividendSpread: { criterion: 'dividend', label: '배당수익률 − 국고채 3년 금리', higher: true, fixed: [-2, 2], rule: '−2%p 이하 0점 → +2%p 이상 100점' },
  payoutRatio: { criterion: 'dividend', label: '배당성향', custom: payoutScore, rule: '20~60% 100점, 20% 미만 70점, 60~80% 60점, 80~100% 30점, 100% 초과·배당 없음 0점' },
  dividendStreak: { criterion: 'dividend', label: '연속 배당', custom: (v, m) => (v == null ? null : clamp((v / 3) * 100 - (m.dividendCut ? 30 : 0), 0, 100)),
    rule: '최근 3년 중 배당한 해 0년 0점 → 3년 100점 (작년보다 줄였으면 −30점)' },

  per: { criterion: 'valuation', label: 'PER', higher: false, fixed: [40, 8], peer: true, custom: (v, m) => (m.perLoss ? 0 : undefined),
    rule: '40배 이상 0점 → 8배 이하 100점 (적자면 0점)' },
  pbr: { criterion: 'valuation', label: 'PBR', higher: false, fixed: [3, 0.5], peer: true, rule: '3배 이상 0점 → 0.5배 이하 100점' },

  volatility: { criterion: 'volatility', label: '주가 변동성 (연)', higher: false, fixed: [60, 15], rule: '60% 이상 0점 → 15% 이하 100점' },
  maxDrawdown: { criterion: 'volatility', label: '최대 하락폭 (1년)', higher: true, fixed: [-60, -10], rule: '−60% 이하 0점 → −10% 이내 100점' },
};

// 성향별로 감당할 수 있는 가장 위험한 등급 (1등급이 가장 위험). 증권사 적합성 표의 일반적인 구조를 따름
const ALLOWED_GRADE = [5, 4, 3, 2, 1];
// 감당 범위를 1·2·3단계 이상 넘을 때 점수를 낮추는 비율
// (상한으로 자르면 개별 주식은 대부분 1~2등급이라 안정형에게 모든 종목이 같은 점수가 돼서, 순서는 유지되게 비율로)
const RISK_PENALTY = [0.1, 0.2, 0.3];

// 설문 답변: public/survey.js의 q1~q7 (q1~q3만 있으면 예전 간이 진단)
// 성향은 7문항 점수로, 기준별 비중은 선호 기업(q1)·투자 기간(q2)·손실 감내도(q3)로 정해요
export function buildProfile(answers = {}, macro = null) {
  const a = { q1: 'steady', q2: 'long', q3: 'calm' }; // 설문 전 기본값
  for (const [k, v] of Object.entries(answers)) if (v != null) a[k] = v;
  const { riskIndex: risk, complete } = riskFromAnswers(a);
  const shortTerm = ['lt6m', 'short'].includes(a.q2);
  const lowLoss = ['none', 'calm'].includes(a.q3);

  const w = { stability: 1, profitability: 1, growth: 1, dividend: 1, valuation: 0.75, volatility: 1 };
  if (a.q1 === 'steady') { w.stability += 1.5; w.profitability += 1; w.volatility += 0.5; }
  if (a.q1 === 'growth') { w.growth += 2; }
  if (a.q1 === 'dividend') { w.dividend += 2; w.stability += 0.5; }
  if (shortTerm) { w.stability += 0.5; w.volatility += 0.5; } else { w.growth += 0.5; w.valuation += 0.25; }
  if (lowLoss) { w.stability += 1; w.volatility += 1.5; w.growth = Math.max(0.25, w.growth - 0.5); }
  else { w.growth += 1; w.volatility = Math.max(0.25, w.volatility - 0.5); }
  const notes = [];
  if (macro?.highRate) {
    w.stability *= 1.2;
    notes.push(`국고채 3년 금리가 ${macro.bond3y}%로 높은 편이라, 빚 부담을 보는 안정성 비중을 20% 높였어요.`);
  }

  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const weights = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total]));
  return { answers: a, complete, riskIndex: risk, riskLevel: RISK_LEVELS[risk], allowedGrade: ALLOWED_GRADE[risk], weights, notes };
}

// 지표 하나의 점수. rank(key, value)는 업종 비교 결과({ score, peers }) 또는 null
// custom 규칙: 숫자면 그 점수, null이면 데이터 없음, undefined면 일반 규칙으로
function scoreMetric(key, metrics, rank) {
  const rule = METRICS[key];
  const value = metrics[key];
  const custom = rule.custom?.(value, metrics);
  if (custom !== undefined) return { score: custom, basis: custom == null ? null : 'rule' };
  if (value == null) return { score: null, basis: null };
  if (rule.peer && rank) {
    const r = rank(key, value);
    if (r) return { score: r.score, basis: 'industry', peers: r.peers };
  }
  return { score: scale(value, ...rule.fixed), basis: 'rule' };
}

// ctx: { rank, risk: { grade, label, var975 } | null }
export function computeFit(metrics, profile, ctx = {}) {
  const parts = Object.entries(CRITERIA).map(([key, c]) => {
    const items = Object.entries(METRICS).filter(([, m]) => m.criterion === key).map(([mk, m]) => ({
      key: mk, label: m.label, rule: m.rule, value: metrics[mk] ?? null, ...scoreMetric(mk, metrics, ctx.rank),
    }));
    const scored = items.filter(i => i.score != null);
    return { key, label: c.label, about: c.about, items, score: avg(scored.map(i => i.score)), weight: profile.weights[key] };
  });

  // 데이터가 없는 기준은 빼고 나머지 가중치를 다시 100%로 맞춤
  const usable = parts.filter(p => p.score != null);
  const wSum = usable.reduce((a, p) => a + p.weight, 0) || 1;
  for (const p of parts) {
    p.appliedWeight = p.score == null ? 0 : p.weight / wSum;
    p.contribution = p.score == null ? 0 : p.score * p.appliedWeight;
  }
  let total = Math.round(parts.reduce((a, p) => a + p.contribution, 0));

  const warnings = [];
  if (metrics.altmanZ != null && metrics.altmanZ < 1.1) {
    warnings.push('재무제표로 계산한 부실위험 점수가 위험 구간(1.1 미만)이에요. 빚과 손실을 꼭 확인해보세요.');
  }

  // 주가 위험 등급 vs 내 성향
  let risk = null;
  if (ctx.risk) {
    const excess = profile.allowedGrade - ctx.risk.grade;
    risk = { ...ctx.risk, allowedGrade: profile.allowedGrade, excess: Math.max(0, excess), penalty: 0, before: total };
    if (excess > 0) {
      risk.penalty = RISK_PENALTY[Math.min(excess, RISK_PENALTY.length) - 1];
      total = Math.round(total * (1 - risk.penalty));
      warnings.push(`최근 주가 움직임으로 본 위험은 ${ctx.risk.grade}등급(${ctx.risk.label})이에요. ${profile.riskLevel}이 감당하기 어려운 수준이라 적합도를 ${risk.penalty * 100}% 낮췄어요 (${risk.before}점 → ${total}점).`);
    }
  }

  const verdict = total >= 80 ? '내 기준과 잘 맞는 편이에요'
    : total >= 60 ? '대체로 맞지만 확인할 부분이 있어요'
    : total >= 40 ? '일부 기준만 맞아요'
    : '내 기준과는 잘 맞지 않아요';
  return { total, verdict, parts, risk, warnings };
}
