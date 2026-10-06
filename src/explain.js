// 지표를 초보자용 문장으로 풀어주는 모듈 (규칙 기반)
// 각 지표마다: 용어 뜻 + 이 회사 수치의 의미 + 내 성향 기준에서의 의미

const fmt = (v, unit = '%') => (v == null ? '정보 없음' : `${(Math.round(v * 10) / 10).toLocaleString('ko-KR')}${unit}`);

const METRICS = [
  {
    key: 'debtRatio', label: '부채비율', criterion: 'stability',
    meaning: '회사 자기 돈(자본) 대비 빌린 돈(부채)의 비율이에요. 100%면 빌린 돈과 자기 돈이 같다는 뜻이에요.',
    read: v => v < 50 ? '빌린 돈이 아주 적어서 재무 부담이 낮아요.'
      : v < 100 ? '빌린 돈이 자기 돈보다 적어서 안정적인 편이에요.'
      : v < 200 ? '빌린 돈이 자기 돈보다 많은 편이라 경기가 나쁠 때 부담이 될 수 있어요.'
      : '빌린 돈이 자기 돈의 2배가 넘어서 재무 부담이 큰 편이에요.',
  },
  {
    key: 'operatingMargin', label: '영업이익률', criterion: 'profitability',
    meaning: '100원어치를 팔았을 때 본업으로 남긴 이익이 몇 원인지 보여줘요.',
    read: v => v < 0 ? '본업에서 손해를 보고 있어요.'
      : v < 5 ? '팔아도 남는 돈이 적은 편이에요.'
      : v < 10 ? '보통 수준으로 이익을 남기고 있어요.'
      : v < 20 ? '이익을 꽤 잘 남기는 편이에요.'
      : '팔 때마다 많은 이익을 남기고 있어요.',
  },
  {
    key: 'roe', label: 'ROE (자기자본이익률)', criterion: 'profitability',
    meaning: '주주가 맡긴 돈 100원으로 1년 동안 몇 원을 벌었는지예요.',
    read: v => v < 0 ? '작년에는 주주 돈으로 손실을 냈어요.'
      : v < 5 ? '맡긴 돈에 비해 버는 돈이 적은 편이에요.'
      : v < 10 ? '무난한 수준으로 돈을 불리고 있어요.'
      : '맡긴 돈을 효율적으로 불리고 있어요.',
  },
  {
    key: 'revenueGrowth', label: '매출 성장률', criterion: 'growth',
    meaning: '1년 전보다 매출이 얼마나 늘었거나 줄었는지예요.',
    read: v => v < 0 ? '작년보다 매출이 줄었어요.'
      : v < 5 ? '매출이 거의 제자리예요.'
      : v < 15 ? '매출이 꾸준히 늘고 있어요.'
      : '매출이 빠르게 늘고 있어요.',
  },
  {
    key: 'dividendYield', label: '배당수익률', criterion: 'dividend',
    meaning: '주가 대비 1년에 받는 배당금 비율이에요. 은행 이자율처럼 생각하면 쉬워요.',
    read: v => v < 1 ? '배당은 거의 기대하기 어려워요.'
      : v < 3 ? '적당한 수준의 배당을 줘요.'
      : '배당을 넉넉하게 주는 편이에요.',
  },
  {
    key: 'payoutRatio', label: '배당성향', criterion: 'dividend',
    meaning: '1년 동안 번 돈 중 몇 %를 주주에게 배당으로 나눠줬는지예요.',
    read: v => v < 15 ? '번 돈 대부분을 회사에 다시 투자하고 있어요.'
      : v < 40 ? '번 돈 일부를 주주와 나누고 있어요.'
      : '번 돈의 상당 부분을 주주에게 돌려주고 있어요.',
  },
];

export function explainMetrics(metrics, profile, fit) {
  // 내가 가장 중요하게 보는 기준 (가중치 1위)
  const topCriterion = Object.entries(profile.weights).sort((a, b) => b[1] - a[1])[0][0];
  return METRICS.map(m => {
    const v = metrics[m.key];
    const part = fit.parts.find(p => p.key === m.criterion);
    let forMe = null;
    if (v != null && m.criterion === topCriterion) {
      forMe = part.score >= 60
        ? `내가 가장 중요하게 보는 ${part.label} 기준에서 좋은 점수를 받았어요.`
        : `내가 가장 중요하게 보는 ${part.label} 기준에서 점수가 낮아요. 꼭 확인해보세요.`;
    }
    return { key: m.key, label: m.label, value: fmt(v), meaning: m.meaning,
             reading: v == null ? '이 지표는 데이터가 없어서 계산에서 뺐어요.' : m.read(v), forMe };
  });
}

// 한 줄 요약: 기준 점수 중 가장 높은 것과 낮은 것
export function summarize(fit) {
  const scored = fit.parts.filter(p => p.score != null).sort((a, b) => b.score - a.score);
  if (scored.length < 2) return '분석할 수 있는 데이터가 부족해요.';
  const best = scored[0], worst = scored[scored.length - 1];
  return `${best.label}이 가장 큰 강점이에요. ${worst.label}은 함께 살펴보면 좋아요.`;
}
