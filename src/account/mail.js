// 메일 보내기
// - .env에 SMTP 설정이 있으면 실제로 발송 (SSL 465 포트: Gmail, 네이버 등)
// - 설정이 없으면 보내지 않고 서버 터미널에 내용을 출력 (개발·시연용)
import tls from 'node:tls';
import crypto from 'node:crypto';

// .env는 server.js에서 읽으므로 설정값은 보낼 때마다 확인
const config = () => ({
  host: process.env.SMTP_HOST?.trim(),
  port: Number(process.env.SMTP_PORT) || 465,
  user: process.env.SMTP_USER?.trim(),
  pass: process.env.SMTP_PASS?.trim(),
  from: (process.env.MAIL_FROM || process.env.SMTP_USER || '').trim(),
});
export const mailConfigured = () => { const c = config(); return Boolean(c.host && c.user && c.pass); };

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

function buildMessage({ from, to, subject, text }) {
  const body = b64(text.replace(/\r?\n/g, '\r\n')).replace(/.{76}/g, '$&\r\n');
  return [
    `From: StockFit <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1] || 'stockfit.local'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

// 최소한의 SMTP 대화: 인사 → 로그인 → 보내는 사람/받는 사람 → 본문 → 종료
async function smtpSend(c, mail) {
  const socket = tls.connect({ host: c.host, port: c.port, servername: c.host });
  socket.setEncoding('utf8');
  socket.setTimeout(15000, () => socket.destroy(new Error('메일 서버 응답 시간이 초과됐어요.')));

  const replies = [];
  let wake = null;
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (/^\d{3}(?: |$)/.test(line)) { replies.push(line); wake?.(); } // 여러 줄 응답의 마지막 줄만
    }
  });
  const broken = new Promise((_, reject) => {
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('메일 서버 연결이 끊겼어요.')));
  });
  broken.catch(() => {});

  async function reply() {
    while (!replies.length) await new Promise(r => { wake = r; });
    wake = null;
    return replies.shift();
  }
  async function step(line, expect, label = line) {
    if (line != null) socket.write(`${line}\r\n`);
    const r = await Promise.race([reply(), broken]);
    if (!r.startsWith(expect)) throw new Error(`메일 서버가 거절했어요 (${label}): ${r}`);
  }

  try {
    await step(null, '220', '연결');
    await step('EHLO localhost', '250');
    await step('AUTH LOGIN', '334');
    await step(b64(c.user), '334', '아이디');
    await step(b64(c.pass), '235', '비밀번호');
    await step(`MAIL FROM:<${c.from}>`, '250');
    await step(`RCPT TO:<${mail.to}>`, '250');
    await step('DATA', '354');
    await step(`${buildMessage({ ...mail, from: c.from })}\r\n.`, '250', '본문');
    await step('QUIT', '221').catch(() => {});
  } finally {
    socket.end();
  }
}

export async function sendMail(mail) {
  if (!mailConfigured()) {
    console.log([
      '',
      '──── 메일 (SMTP 설정이 없어서 실제로 보내지 않고 여기에 표시해요) ────',
      `받는 사람: ${mail.to}`,
      `제목: ${mail.subject}`,
      '',
      mail.text,
      '──────────────────────────────────────────────',
      '',
    ].join('\n'));
    return;
  }
  try {
    await smtpSend(config(), mail);
  } catch (err) {
    console.error('[메일 발송 실패]', err.message);
    throw Object.assign(new Error('메일을 보내지 못했어요. 잠시 후 다시 시도해주세요.'), { status: 502 });
  }
}

export const verifyMail = (name, link) => ({
  subject: '[StockFit] 이메일 인증을 완료해주세요',
  text: `${name}님, StockFit에 가입해주셔서 고마워요.

아래 링크를 누르면 이메일 인증이 완료돼요. (24시간 동안 유효)
${link}

직접 가입하지 않았다면 이 메일은 무시하셔도 돼요.`,
});

export const resetMail = (name, link) => ({
  subject: '[StockFit] 비밀번호 재설정 안내',
  text: `${name}님, 비밀번호 재설정을 요청하셨어요.

아래 링크에서 새 비밀번호를 정할 수 있어요. (30분 동안 유효, 한 번만 사용 가능)
${link}

요청하지 않았다면 이 메일은 무시하셔도 돼요. 비밀번호는 바뀌지 않아요.`,
});
