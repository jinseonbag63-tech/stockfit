// 주가 흐름 화면의 "왜 움직였을까?" 카드: 시장·업종 대비 비교, 크게 움직인 날, 공시·뉴스, 증권가 시각
// 계산은 서버(src/clues.js)가 하고, 여기서는 그리기만 해요. 종목 주가 흐름을 불러온 뒤 따로 불러와요.
// app.js가 initClues({ $, esc, api })로 필요한 도구를 넘겨줘요.

let $, esc, api;
let seq = 0; // 다른 종목을 연달아 검색했을 때 늦게 온 결과는 버림

const pct = v => (v == null ? '-' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const chg = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const day = d => (d.length === 8 ? `${d.slice(4, 6)}.${d.slice(6, 8)}` : `${d.slice(5, 7)}.${d.slice(8, 10)}`);
const newsDay = iso => { const d = new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString(); return `${d.slice(5, 7)}.${d.slice(8, 10)}`; };
const link = (url, text) => (/^https?:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));
const flag = level => (level === 'warning' ? '<span class="feed-flag warn">주의</span>' : level === 'important' ? '<span class="feed-flag">중요</span>' : '');
const KIND_CLASS = { market: 'market', sector: 'sector', own: 'own', quiet: 'quiet', nodata: 'quiet' };

export function initClues(deps) { ({ $, esc, api } = deps); }

export async function loadClues(code) {
  const my = ++seq;
  $('clueBody').hidden = true;
  $('clueStatus').hidden = false;
  $('clueStatus').textContent = '단서를 찾는 중이에요…';
  try {
    const d = await api(`/api/clues?q=${encodeURIComponent(code)}`);
    if (my !== seq) return;
    render(d);
  } catch (e) {
    if (my === seq) $('clueStatus').textContent = e.message;
  }
}

function render(d) {
  $('clueStatus').hidden = true;
  $('clueBody').hidden = false;
  $('clueSectorHead').textContent = d.sector ? `같은 업종 (${d.sector.name})` : '같은 업종';

  // 1) 시장·업종과 비교
  $('clueCompare').innerHTML = d.compare.map(c => `<tr>
      <td><strong>${c.label}</strong></td>
      <td class="num chg ${chg(c.stock)}"><strong>${pct(c.stock)}</strong></td>
      <td class="num chg ${chg(c.sector)}">${c.sector == null ? '<span class="meta">준비 중</span>' : pct(c.sector)}</td>
      <td class="num chg ${chg(c.market)}">${c.market == null ? '<span class="meta">준비 중</span>' : pct(c.market)}</td>
      <td><span class="clue-verdict ${KIND_CLASS[c.verdict?.kind] ?? ''}">${esc(c.verdict?.text ?? '-')}</span></td></tr>`).join('');

  // 2) 크게 움직인 날과 그날 앞뒤 공시·뉴스
  $('clueDaysNote').textContent = `최근 20거래일 중 하루 ±${d.bigLimit}% 이상`;
  $('clueDays').innerHTML = d.bigDays.length ? d.bigDays.map(b => {
    const found = [...b.disclosures.map(x => `<li><span class="clue-tag">공시</span>${flag(x.level)} ${link(x.url, x.title)}</li>`),
                   ...b.news.map(x => `<li><span class="clue-tag news">뉴스</span> ${link(x.url, x.title)} <span class="meta">${esc(x.source ?? '')}</span></li>`)];
    return `<li>
      <p class="clue-day"><strong>${day(b.date)}</strong> <b class="chg ${chg(b.change)}">${pct(b.change)}</b>
        <span class="meta">그날 업종 ${pct(b.sector)} · 시장 ${pct(b.market)}</span></p>
      ${found.length ? `<ul class="clue-found">${found.join('')}</ul>` : '<p class="meta clue-none">그날 앞뒤로 찾은 공시·뉴스가 없어요. (뉴스는 최근 기사만 찾을 수 있어요)</p>'}
    </li>`;
  }).join('') : '<li class="meta">최근 20거래일 동안 하루에 크게 움직인 날은 없었어요.</li>';

  // 3) 최근 1개월 공시, 4) 최근 뉴스
  $('clueDisc').innerHTML = !d.disclosuresEnabled ? '<li class="meta">DART 키가 있어야 볼 수 있어요.</li>'
    : d.disclosures.length ? d.disclosures.map(x => `<li><span class="meta">${day(x.date)}</span> ${flag(x.level)} ${link(x.url, x.title)}
        ${x.explain ? `<span class="clue-explain">${esc(x.explain)}</span>` : ''}</li>`).join('')
    : '<li class="meta">최근 1개월 동안 공시가 없었어요.</li>';
  $('clueNewsNote').textContent = d.news.oldest ? `${newsDay(d.news.oldest)} 이후 기사` : '';
  $('clueNews').innerHTML = !d.newsEnabled ? '<li class="meta">네이버 검색 키가 있어야 볼 수 있어요.</li>'
    : d.news.items.length ? d.news.items.map(x => `<li><span class="meta">${newsDay(x.date)}</span> ${link(x.url, x.title)} <span class="meta">${esc(x.source ?? '')}</span></li>`).join('')
    : '<li class="meta">최근 뉴스를 찾지 못했어요.</li>';

  // 5) 증권가 시각
  const a = d.analyst;
  const total = a.up + a.down + a.other;
  $('clueAnalystCount').innerHTML = !d.newsEnabled ? '' : total
    ? `목표주가 <b class="chg up">상향 ${a.up}건</b> · <b class="chg down">하향 ${a.down}건</b> · 그 밖의 의견 ${a.other}건 <span class="meta">(기사 제목 기준)</span>`
    : '최근 30일 동안 증권사 의견 기사를 찾지 못했어요.';
  $('clueAnalyst').innerHTML = !d.newsEnabled ? '<li class="meta">네이버 검색 키가 있어야 볼 수 있어요.</li>'
    : a.items.map(x => `<li><span class="meta">${newsDay(x.date)}</span>
        ${x.tone === 'up' ? '<span class="sig up">상향</span>' : x.tone === 'down' ? '<span class="sig down">하향</span>' : ''}
        ${link(x.url, x.title)} <span class="meta">${esc(x.source ?? '')}</span></li>`).join('');
}
