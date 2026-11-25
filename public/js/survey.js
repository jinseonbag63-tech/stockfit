// 투자성향 설문 7문항과 성향 판정 규칙 (서버와 화면이 같이 씀)
// 금융투자협회 표준투자권유준칙의 투자자정보확인서 항목(나이, 투자 기간, 경험, 지식, 투자 비중, 손실 감내도)을 따름
// q1~q3은 예전 3문항 설문과 같은 키·값이라 예전에 저장한 답변도 그대로 쓸 수 있어요.

export const RISK_LEVELS = ['안정형', '안정추구형', '위험중립형', '적극투자형', '공격투자형'];

// 화면에 보여주는 순서. points: 위험을 감수할 여력이 클수록 높음
export const SURVEY = [
  { key: 'q4', title: '나이가 어떻게 되세요?', options: [
    { value: 'age39', label: '39세 이하', points: 4 },
    { value: 'age49', label: '40~49세', points: 3 },
    { value: 'age59', label: '50~59세', points: 2 },
    { value: 'age60', label: '60세 이상', points: 1 },
  ] },
  { key: 'q2', title: '이 돈을 얼마나 오래 투자할 생각인가요?', options: [
    { value: 'lt6m', label: '6개월 이내', points: 1 },
    { value: 'short', label: '6개월~1년', points: 2 },
    { value: 'long', label: '1~3년', points: 3 },
    { value: 'vlong', label: '3년 이상', points: 4 },
  ] },
  { key: 'q5', title: '투자해 본 적 있는 상품은 무엇인가요? (가장 위험한 것 하나)', options: [
    { value: 'deposit', label: '예금·적금만 해봤어요', points: 1 },
    { value: 'fund', label: '채권, 펀드, 원금보장형 상품', points: 2 },
    { value: 'stock', label: '주식을 직접 사고판 적이 있어요', points: 3 },
    { value: 'derivative', label: '선물·옵션, 신용거래(빚내서 투자)', points: 4 },
  ] },
  { key: 'q6', title: '금융상품을 얼마나 알고 있나요?', options: [
    { value: 'none', label: '투자 결정을 혼자 해본 적이 없어요', points: 1 },
    { value: 'basic', label: '주식과 채권의 차이 정도는 알아요', points: 2 },
    { value: 'good', label: '대부분의 금융상품 구조를 이해해요', points: 3 },
    { value: 'expert', label: '파생상품까지 포함해 잘 알아요', points: 4 },
  ] },
  { key: 'q7', title: '전체 금융자산 중 이번 투자금은 얼마나 되나요?', options: [
    { value: 'p10', label: '10% 이하', points: 1 },
    { value: 'p30', label: '10~30%', points: 2 },
    { value: 'p50', label: '30~50%', points: 3 },
    { value: 'p100', label: '50% 넘게', points: 4 },
  ] },
  { key: 'q3', title: '투자한 돈이 줄어든다면 어디까지 견딜 수 있나요?', options: [
    { value: 'none', label: '원금 손실은 싫어요', points: 1 },
    { value: 'calm', label: '10% 정도 손실까지는 괜찮아요', points: 2 },
    { value: 'growth', label: '20% 정도 손실까지는 괜찮아요', points: 3 },
    { value: 'aggressive', label: '더 큰 수익을 위해 더 큰 손실도 감수해요', points: 4 },
  ] },
  { key: 'q1', title: '어떤 기업이 더 마음에 드나요?', note: '분석할 때 어떤 기준을 더 중요하게 볼지 정해요.', options: [
    { value: 'steady', label: '꾸준히 이익을 내고 재무가 안정적인 기업', points: 1 },
    { value: 'dividend', label: '배당을 꾸준히 주는 기업', points: 2 },
    { value: 'growth', label: '변화가 크더라도 빠르게 성장하는 기업', points: 3 },
  ] },
];

const optionOf = (answers, q) => q.options.find(o => o.value === answers?.[q.key]);

// 저장해도 되는 답변만 남김 (모르는 키·값은 버림). q1~q3이 없으면 null
export function cleanAnswers(answers) {
  if (!answers || typeof answers !== 'object') return null;
  const out = {};
  for (const q of SURVEY) if (optionOf(answers, q)) out[q.key] = answers[q.key];
  return out.q1 && out.q2 && out.q3 ? out : null;
}

// 답변 → 5단계 성향
// 7문항을 다 답했으면 점수 합계를 5구간으로, 예전 3문항만 있으면 예전 방식(간이 진단)으로
export function riskFromAnswers(answers) {
  const complete = SURVEY.every(q => optionOf(answers, q));
  if (!complete) {
    const r = ({ steady: 0, dividend: 1, growth: 2 }[answers?.q1] ?? 0)
      + (['long', 'vlong'].includes(answers?.q2) ? 1 : 0)
      + (['growth', 'aggressive'].includes(answers?.q3) ? 1 : 0);
    return { riskIndex: r, riskLevel: RISK_LEVELS[r], complete: false };
  }
  const sum = SURVEY.reduce((a, q) => a + optionOf(answers, q).points, 0);
  const min = SURVEY.reduce((a, q) => a + Math.min(...q.options.map(o => o.points)), 0);
  const max = SURVEY.reduce((a, q) => a + Math.max(...q.options.map(o => o.points)), 0);
  const ratio = (sum - min) / (max - min);
  let r = Math.min(4, Math.floor(ratio * 5));
  // 원금 손실을 원하지 않으면 다른 답과 상관없이 안정형 (적합성 원칙: 원금 보전을 원하면 손실 가능 상품은 맞지 않음)
  if (answers.q3 === 'none') r = 0;
  return { riskIndex: r, riskLevel: RISK_LEVELS[r], complete: true, score: Math.round(ratio * 100) };
}
