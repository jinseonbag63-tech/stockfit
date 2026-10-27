// 화면 전환: 주소(#analysis, #watch, #compare, #trend)에 따라 화면 하나만 보여줘요.
// body[data-view]를 바꾸면 style.css가 .view-이름 요소만 보이게 해요.

const VIEWS = ['analysis', 'watch', 'compare', 'trend'];
const listeners = {};

// 그 화면이 보일 때마다 실행할 일 (그래프 다시 그리기 등)
export function onShowView(name, fn) { (listeners[name] ??= []).push(fn); }

export const currentView = () => document.body.dataset.view;

// 다른 화면으로 이동 (이미 그 주소면 hashchange가 안 생겨서 직접 맞춤)
export function goTo(name) {
  if (location.hash === `#${name}`) sync();
  else location.hash = `#${name}`;
}

function sync() {
  const hash = location.hash.slice(1);
  const name = VIEWS.includes(hash) ? hash : 'analysis';
  const changed = document.body.dataset.view !== name;
  document.body.dataset.view = name;
  document.querySelectorAll('.menu a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
  if (changed) window.scrollTo(0, 0);
  for (const fn of listeners[name] ?? []) fn();
}

export function initViews() {
  window.addEventListener('hashchange', sync);
  sync();
}
