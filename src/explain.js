// 지표를 초보자용 문장으로 풀어주는 모듈 (규칙 기반)
// 각 지표마다: 용어 뜻 + 이 회사 수치의 의미 + 평가 근거(업종 비교/기준표) + 내 성향 기준에서의 의미

const round1 = v => (Math.round(v * 10) / 10).toLocaleString('ko-KR');
const unit = u => v => `${round1(v)}${u}`;

const TEXT = {
  debtRatio: {
    fmt: unit('%'),
    meaning: '회사 자기 돈(자본) 대비 빌린 돈(부채)의 비율이에요. 100%면 빌린 돈과 자기 돈이 같다는 뜻이에요.',
    read: v => v < 50 ? '빌린 돈이 아주 적어서 재무 부담이 낮아요.'
      : v < 100 ? '빌린 돈이 자기 돈보다 적어서 안정적인 편이에요.'
      : v < 200 ? '빌린 돈이 자기 돈보다 많은 편이라 경기가 나쁠 때 부담이 될 수 있어요.'
      : '빌린 돈이 자기 돈의 2배가 넘어서 재무 부담이 큰 편이에요.',
  },
  currentRatio: {
    fmt: unit('%'),
    meaning: '1년 안에 현금으로 바꿀 수 있는 자산이 1년 안에 갚을 빚보다 얼마나 많은지예요.',
    read: v => v < 100 ? '1년 안에 갚을 빚이 바로 쓸 수 있는 자산보다 많아요.'
      : v < 150 ? '단기 빚을 갚을 여력이 있는 편이에요.'
      : '단기 빚을 갚을 여력이 넉넉해요.',
  },
  interestCoverage: {
    fmt: v => (v >= 99 ? '이자 부담 없음' : `${round1(v)}배`),
    meaning: '본업으로 번 돈(영업이익)이 1년 이자의 몇 배인지예요. 1배보다 낮으면 번 돈으로 이자도 다 못 내요.',
    read: v => v < 1 ? '본업으로 번 돈으로 이자를 다 내지 못해요.'
      : v < 3 ? '이자는 내지만 여유가 크지 않아요.'
      : v < 10 ? '이자를 내고도 여유가 있어요.'
      : '이자 부담이 거의 없는 수준이에요.',
  },
  altmanZ: {
    fmt: v => round1(v),
    meaning: '재무제표 숫자 4개로 회사가 어려워질 위험을 보는 점수예요(Altman Z″). 2.6 이상은 안전, 1.1 미만은 위험 구간이에요.',
    read: v => v < 1.1 ? '부실 위험 구간이에요. 꼭 자세히 살펴보세요.'
      : v < 2.6 ? '안전과 위험 사이의 회색 구간이에요.'
      : '부실 위험이 낮은 안전 구간이에요.',
  },
  operatingMargin: {
    fmt: unit('%'),
    meaning: '100원어치를 팔았을 때 본업으로 남긴 이익이 몇 원인지 보여줘요.',
    read: v => v < 0 ? '본업에서 손해를 보고 있어요.'
      : v < 5 ? '팔아도 남는 돈이 적은 편이에요.'
      : v < 10 ? '보통 수준으로 이익을 남기고 있어요.'
      : v < 20 ? '이익을 꽤 잘 남기는 편이에요.'
      : '팔 때마다 많은 이익을 남기고 있어요.',
  },
  roe: {
    fmt: unit('%'),
    meaning: '주주가 맡긴 돈 100원으로 1년 동안 몇 원을 벌었는지예요.',
    read: v => v < 0 ? '작년에는 주주 돈으로 손실을 냈어요.'
      : v < 5 ? '맡긴 돈에 비해 버는 돈이 적은 편이에요.'
      : v < 10 ? '무난한 수준으로 돈을 불리고 있어요.'
      : '맡긴 돈을 효율적으로 불리고 있어요.',
  },
  grossProfitability: {
    fmt: unit('%'),
    meaning: '회사 전체 자산 대비 매출총이익(매출 − 원가)이에요. 높을수록 적은 자산으로 많이 남기는 회사예요.',
    read: v => v < 10 ? '자산에 비해 남기는 돈이 적은 편이에요.'
      : v < 25 ? '보통 수준이에요.'
      : '자산에 비해 많이 남기는 편이에요.',
  },
  accruals: {
    fmt: unit('%'),
    meaning: '장부상 이익과 실제 들어온 현금의 차이예요. 이익보다 현금이 많이 들어올수록(값이 낮을수록) 이익을 믿을 만해요.',
    read: v => v > 5 ? '이익에 비해 실제 들어온 현금이 적어요. 이익의 질을 확인해보세요.'
      : v > 0 ? '이익과 현금이 비슷한 수준이에요.'
      : '이익보다 실제 들어온 현금이 많아서 이익을 믿을 만해요.',
  },
  revenueGrowth: {
    fmt: unit('%'),
    meaning: '1년 전보다 매출이 얼마나 늘었거나 줄었는지예요.',
    read: v => v < 0 ? '작년보다 매출이 줄었어요.'
      : v < 5 ? '매출이 거의 제자리예요.'
      : v < 15 ? '매출이 꾸준히 늘고 있어요.'
      : '매출이 빠르게 늘고 있어요.',
  },
  revenueCagr3y: {
    fmt: v => `연 ${round1(v)}%`,
    meaning: '2년 전부터 올해까지 매출이 1년에 평균 몇 %씩 늘었는지예요. 한 해의 우연을 덜 타요.',
    read: v => v < 0 ? '몇 년째 매출이 줄고 있어요.'
      : v < 5 ? '매출이 천천히 늘고 있어요.'
      : v < 15 ? '매출이 꾸준히 늘고 있어요.'
      : '매출이 빠르게 늘고 있어요.',
  },
  growthConsistency: {
    fmt: v => `${Math.round(v)}%`,
    meaning: '최근 2년 동안 매출과 영업이익이 전년보다 늘어난 횟수의 비율이에요.',
    read: v => v >= 75 ? '거의 매년 성장했어요.' : v >= 50 ? '성장한 해와 아닌 해가 섞여 있어요.' : '성장이 들쭉날쭉하거나 줄어든 해가 많아요.',
  },
  dividendYield: {
    fmt: unit('%'),
    meaning: '주가 대비 1년에 받는 배당금 비율이에요. 은행 이자율처럼 생각하면 쉬워요.',
    read: v => v < 1 ? '배당은 거의 기대하기 어려워요.'
      : v < 3 ? '적당한 수준의 배당을 줘요.'
      : '배당을 넉넉하게 주는 편이에요.',
  },
  dividendSpread: {
    fmt: v => `${v > 0 ? '+' : ''}${round1(v)}%p`,
    meaning: '배당수익률에서 국고채 3년 금리를 뺀 값이에요. 플러스면 안전한 국채보다 배당이 더 많다는 뜻이에요.',
    read: v => v < 0 ? '국채 이자보다 배당이 적어요.' : v < 1 ? '국채 이자와 비슷한 수준이에요.' : '국채 이자보다 배당이 많아요.',
  },
  payoutRatio: {
    fmt: unit('%'),
    meaning: '1년 동안 번 돈 중 몇 %를 주주에게 배당으로 나눠줬는지예요. 너무 높으면 배당을 줄일 위험이 커요.',
    read: v => v < 20 ? '번 돈 대부분을 회사에 다시 투자하고 있어요.'
      : v <= 60 ? '번 돈 일부를 주주와 나누고 있어서 꾸준히 이어가기 좋은 수준이에요.'
      : v <= 100 ? '번 돈의 많은 부분을 배당으로 줘서, 이익이 줄면 배당이 줄어들 수 있어요.'
      : '번 돈보다 배당을 더 줬어요. 오래 이어가기 어려울 수 있어요.',
  },
  dividendStreak: {
    fmt: v => `3년 중 ${v}년`,
    meaning: '최근 3년 동안 배당을 준 해가 몇 번인지예요.',
    read: (v, m) => v === 0 ? '최근 3년 동안 배당이 없었어요.'
      : m.dividendCut ? '배당은 했지만 작년보다 줄였어요.'
      : v === 3 ? '3년 내내 배당을 줬어요.' : '배당을 준 해와 안 준 해가 있어요.',
  },
  per: {
    fmt: v => `${round1(v)}배`,
    meaning: '회사 전체 가격(시가총액)이 1년 이익의 몇 배인지예요. 낮을수록 이익에 비해 싸게 거래된다는 뜻이에요.',
    read: v => v < 10 ? '이익에 비해 낮은 가격에 거래되고 있어요.'
      : v < 20 ? '이익에 비해 보통 수준의 가격이에요.'
      : '이익에 비해 높은 가격이에요. 앞으로의 성장이 기대되거나 비싸다는 뜻일 수 있어요.',
  },
  pbr: {
    fmt: v => `${round1(v)}배`,
    meaning: '회사 전체 가격(시가총액)이 장부상 순자산의 몇 배인지예요. 1배보다 낮으면 장부 가치보다 싸게 거래돼요.',
    read: v => v < 1 ? '장부상 가치보다 낮은 가격이에요.'
      : v < 2 ? '장부상 가치와 비슷하거나 조금 높은 가격이에요.'
      : '장부상 가치보다 꽤 높은 가격이에요.',
  },
  volatility: {
    fmt: v => `연 ${round1(v)}%`,
    meaning: '최근 1년 동안 주가가 얼마나 크게 오르내렸는지예요. 높을수록 주가가 많이 흔들려요.',
    read: v => v < 20 ? '주가 움직임이 비교적 잔잔해요.'
      : v < 35 ? '주가가 보통 수준으로 움직여요.'
      : v < 50 ? '주가가 크게 오르내리는 편이에요.'
      : '주가가 아주 크게 흔들려요.',
  },
  maxDrawdown: {
    fmt: unit('%'),
    meaning: '최근 1년 중 가장 높았던 때 대비 가장 많이 떨어졌던 폭이에요. 최악의 순간에 얼마나 잃을 수 있었는지 보여줘요.',
    read: v => v > -15 ? '크게 떨어진 적이 없어요.'
      : v > -30 ? '한때 꽤 떨어진 적이 있어요.'
      : '한때 큰 폭으로 떨어진 적이 있어요.',
  },
};

function basisText(item) {
  if (item.basis === 'industry') {
    // score는 "좋은 쪽으로 몇 %보다 나은지". 절반보다 좋으면 상위, 아니면 하위로 표현
    const top = Math.round(100 - item.score);
    const where = top <= 50 ? `상위 ${Math.max(1, top)}%` : `하위 ${Math.max(1, Math.round(item.score))}%`;
    return `같은 업종 ${item.peers}개 회사와 비교하면 ${where} 수준이에요. (좋을수록 상위)`;
  }
  if (item.basis === 'rule') return `평가 기준: ${item.rule}`;
  return null;
}

export function explainMetrics(metrics, profile, fit) {
  // 내가 가장 중요하게 보는 기준 (가중치 1위)
  const topCriterion = Object.entries(profile.weights).sort((a, b) => b[1] - a[1])[0][0];
  return fit.parts.flatMap(part => part.items.map(item => {
    const t = TEXT[item.key];
    const v = item.value;
    let forMe = null;
    if (v != null && part.key === topCriterion && part.score != null) {
      forMe = part.score >= 60
        ? `내가 가장 중요하게 보는 ${part.label} 기준에서 좋은 점수를 받았어요.`
        : `내가 가장 중요하게 보는 ${part.label} 기준에서 점수가 낮아요. 꼭 확인해보세요.`;
    }
    const lossPer = item.key === 'per' && metrics.perLoss;
    return {
      key: item.key, criterion: part.key, label: item.label,
      value: lossPer ? '적자' : v == null ? '정보 없음' : t.fmt(v),
      meaning: t.meaning,
      reading: lossPer ? '최근 1년 손실이라 PER을 계산할 수 없어요.'
        : v == null ? '이 지표는 데이터가 없어서 계산에서 뺐어요.' : t.read(v, metrics),
      basis: v == null && !lossPer ? null : basisText(item),
      forMe,
    };
  }));
}

// 초보자 모드용: 기준 점수를 쉬운 문장으로 (좋을 때 / 아쉬울 때)
const EASY = {
  stability: ['빚이 적고 재무가 튼튼해요.', '빚 부담이 있는 편이라 경기가 나쁠 때 흔들릴 수 있어요.'],
  profitability: ['물건이나 서비스를 팔아 이익을 잘 남겨요.', '버는 돈에 비해 남는 이익이 적은 편이에요.'],
  growth: ['회사 매출이 꾸준히 커지고 있어요.', '매출이 잘 늘지 않거나 줄고 있어요.'],
  dividend: ['주주에게 배당금을 꾸준히 나눠줘요.', '배당금은 많이 기대하기 어려워요.'],
  valuation: ['버는 돈에 비해 주가가 비싸지 않은 편이에요.', '버는 돈에 비해 주가가 비싼 편이에요.'],
  volatility: ['주가가 비교적 덜 출렁여요.', '주가가 크게 오르내리는 편이라 마음고생을 할 수 있어요.'],
};

// 내 성향에서 비중이 큰 기준부터: 60점 이상은 "맞는 점", 40점 미만은 "조심할 점"
export function beginnerSummary(fit, profile) {
  const scored = fit.parts.filter(p => p.score != null).sort((a, b) => b.weight - a.weight);
  const mine = p => (p.weight >= 0.18 ? '내가 중요하게 보는 ' : '');
  const goods = scored.filter(p => p.score >= 60).slice(0, 3)
    .map(p => `${mine(p)}${p.label}: ${EASY[p.key][0]}`);
  const cautions = scored.filter(p => p.score < 40).slice(0, 3)
    .map(p => `${mine(p)}${p.label}: ${EASY[p.key][1]}`);
  if (fit.risk?.penalty) {
    // 주가 안정성 점수가 좋으면 "다른 주식보다는 덜 출렁이지만"으로 이어서, 맞는 점과 모순처럼 보이지 않게
    const calmer = fit.parts.find(p => p.key === 'volatility')?.score >= 60;
    cautions.unshift(calmer
      ? `다른 주식들보다는 덜 출렁이는 편이지만, 주식은 원래 가격이 크게 움직일 수 있어서 ${profile.riskLevel}인 나에게는 부담이 될 수 있어요. 그래서 점수를 조금 낮췄어요.`
      : `이 종목은 주가가 크게 움직이는 편이라, ${profile.riskLevel}인 나에게는 부담이 될 수 있어요. 그래서 점수를 조금 낮췄어요.`);
  }
  if (fit.parts.find(p => p.key === 'stability')?.items.find(i => i.key === 'altmanZ')?.value < 1.1) {
    cautions.unshift('재무제표로 보면 회사가 어려워질 위험이 높은 편이에요. 꼭 신중하게 살펴보세요.');
  }
  if (!goods.length) goods.push('눈에 띄게 내 성향과 맞는 부분은 아직 없어요.');
  if (!cautions.length) cautions.push('크게 걱정할 부분은 보이지 않아요. 그래도 투자 전에 최근 소식을 꼭 확인하세요.');
  return { goods, cautions };
}

// 한 줄 요약: 기준 점수 중 가장 높은 것과 낮은 것
export function summarize(fit) {
  const scored = fit.parts.filter(p => p.score != null).sort((a, b) => b.score - a.score);
  if (scored.length < 2) return '분석할 수 있는 데이터가 부족해요.';
  const best = scored[0], worst = scored[scored.length - 1];
  return `${best.label}이 가장 큰 강점이에요. ${worst.label}은 함께 살펴보면 좋아요.`;
}
