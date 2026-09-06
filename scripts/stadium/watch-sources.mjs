#!/usr/bin/env node
/**
 * 경기장 좌석 데이터의 출처 페이지가 바뀌었는지 감시한다.
 *
 *   node scripts/stadium/watch-sources.mjs            # 확인만
 *   node scripts/stadium/watch-sources.mjs --save     # 현재 상태를 기준선으로 저장
 *   node scripts/stadium/watch-sources.mjs --json     # 기계가 읽을 출력
 *
 * 왜 필요한가: 좌석 가격은 시즌마다 바뀌고, 구단이 배치도 이미지를 새 파일명으로
 * 갈아끼우며, URL 자체가 사라지기도 한다(2026-09 조사 중 kbl.or.kr/game/schedule 이
 * 404 였다). 데이터는 원격 JSON 이라 스토어 심사 없이 고칠 수 있지만,
 * **바뀐 줄 모르면 고칠 수도 없다.**
 *
 * 🚨 이 스크립트의 핵심은 해시가 아니라 정규화다.
 *    페이지를 통째로 해시하면 매 요청 바뀌는 값 때문에 항상 "변경됨"이 뜨고,
 *    그러면 아무도 경고를 안 본다. 실제로 출처 페이지들에 이런 것들이 있었다 —
 *      · 시설공단: form_csrf_token, URL 안의 jsessionid
 *      · KBO(ASP.NET): __VIEWSTATE, __EVENTVALIDATION
 *      · 광고/애널리틱스 nonce, 캐시버스터 쿼리
 *    NOISE 목록이 곧 이 스크립트의 정확도다. 오탐이 나면 여기에 추가한다.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = join(ROOT, 'stadium', 'sources.json');
const STATE = join(ROOT, 'stadium', 'watch-state.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 매 요청 바뀌지만 내용과 무관한 것들. 오탐의 원인이므로 여기서 지운다. */
const NOISE = [
  // 세션·CSRF
  [/;jsessionid=[^"'?&\s]*/gi, ''],
  [/name="form_csrf_token"[^>]*value="[^"]*"/gi, 'name="form_csrf_token"'],
  [/name="__(VIEWSTATE|VIEWSTATEGENERATOR|EVENTVALIDATION)"[^>]*value="[^"]*"/gi, 'name="__$1"'],
  [/\b(csrf|xsrf|_token|authenticity_token)["'\s:=]+[A-Za-z0-9_\-]{8,}/gi, '$1='],
  // 캐시버스터·타임스탬프 쿼리
  [/([?&])(_|v|ver|t|ts|rnd|cb)=\d{6,}/gi, '$1$2='],
  // nonce
  [/nonce="[^"]*"/gi, 'nonce=""'],
  // 방문자 수·현재 시각처럼 매번 바뀌는 표기
  [/\d{4}[-.]\d{2}[-.]\d{2}\s+\d{2}:\d{2}:\d{2}/g, ''],
  // 공백 정규화 (마지막)
  [/\s+/g, ' '],
];

/** 좌석·가격과 무관한 껍데기. 여기가 바뀌어도 알 필요 없다. */
const CHROME = [
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<!--[\s\S]*?-->/g,
  /<(header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi,
];

/** 배치도·가격표로 보이는 이미지 */
const IMG_GOOD = /seat|ticket|좌석|배치|price|가격|stadium|ti_/i;
const IMG_BAD = /logo|icon|btn|banner|sns|common|bg_|sprite|blank/i;

/**
 * 출처별 무시 규칙. sources JSON 의 `ignore: ["정규식", ...]`.
 *
 * 회전 배너·후원사 위젯처럼 **새로고침마다 내용이 바뀌는 영역**을 지운다.
 * (대전 하나시티즌 ti.php 의 '후원의 집' 위젯이 매 요청 다른 가게를 보여준다)
 */
function normalize(html, ignore = []) {
  let s = html;
  for (const re of CHROME) s = s.replace(re, ' ');
  for (const pat of ignore) s = s.replace(new RegExp(pat, 'gi'), ' ');
  for (const [re, to] of NOISE) s = s.replace(re, to);
  return s.trim();
}

/**
 * 이미지 파일명 집합.
 *
 * 구단은 배치도를 고칠 때 **날짜가 박힌 새 파일명으로 갈아끼운다**
 * (ticket_20260625_01.png → ticket_20270110_01.png). 그래서 파일명 집합의
 * 변화가 내용 변화보다 오히려 선명한 신호다.
 */
function imageNames(html, base, ignore = []) {
  for (const pat of ignore) html = html.replace(new RegExp(pat, 'gi'), ' ');
  const out = new Set();
  const re = /(?:src|data-src)=["']([^"']+\.(?:jpg|jpeg|png|gif|webp))["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (!IMG_GOOD.test(src) || IMG_BAD.test(src)) continue;
    try {
      out.add(new URL(src, base).pathname.split('/').pop());
    } catch {
      out.add(src.split('/').pop());
    }
  }
  return [...out].sort();
}

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function check(src) {
  const headers = { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' };
  // 🚨 Referer 가 없으면 403 이 나는 구단이 있다 (인천에서 확인).
  if (src.referer) headers.Referer = src.referer;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25_000);
  try {
    const res = await fetch(src.url, { headers, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return { status: `HTTP ${res.status}` };
    const html = await res.text();
    if (html.length < 500) return { status: 'SPA?', hash: null, images: [], bytes: html.length };
    return {
      status: 'ok',
      hash: sha(normalize(html, src.ignore)),
      images: imageNames(html, res.url, src.ignore),
      bytes: html.length,
    };
  } catch (e) {
    return { status: e.name === 'AbortError' ? '시간초과' : `실패: ${e.message.slice(0, 40)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── 실행 ──────────────────────────────────────────────────────

const save = process.argv.includes('--save');
const asJson = process.argv.includes('--json');

if (!existsSync(SOURCES)) {
  console.error(`출처 목록이 없다: ${SOURCES}`);
  process.exit(1);
}
const sources = JSON.parse(readFileSync(SOURCES, 'utf8'));
const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { checked: null, entries: {} };

const now = {};
const changes = [];

// 동시에 6개까지
const queue = [...sources];
async function worker() {
  while (queue.length) {
    const src = queue.shift();
    const cur = await check(src);
    now[src.id] = cur;
    const old = prev.entries[src.id];

    if (!old) {
      changes.push({ id: src.id, name: src.name, kind: '신규', detail: cur.status });
    } else if (cur.status !== 'ok' && old.status === 'ok') {
      changes.push({ id: src.id, name: src.name, kind: '접근 불가', detail: cur.status });
    } else if (cur.status === 'ok' && old.status === 'ok') {
      if (cur.hash !== old.hash) {
        /*
          🚨 바로 알리지 않고 한 번 더 받아 확인한다.
             회전 배너·A/B 테스트처럼 매 요청 달라지는 영역이 남아 있으면
             영원히 '변경됨'이 뜨고, 그러면 아무도 경고를 안 본다.
             두 번째도 첫 번째와 같으면 진짜 변경, 다르면 '불안정'으로 보고해
             사람이 ignore 규칙을 추가하게 한다.
        */
        const again = await check(src);
        if (again.status === 'ok' && again.hash === cur.hash) {
          changes.push({ id: src.id, name: src.name, kind: '내용 변경', detail: `${old.bytes} → ${cur.bytes} bytes` });
        } else if (again.status === 'ok') {
          changes.push({
            id: src.id, name: src.name, kind: '불안정',
            detail: '같은 시각 두 요청의 내용이 다르다 — sources JSON 에 ignore 규칙이 필요하다',
          });
          now[src.id] = old; // 기준선을 오염시키지 않는다
          continue;
        }
      }
      const added = cur.images.filter((i) => !old.images.includes(i));
      const gone = (old.images ?? []).filter((i) => !cur.images.includes(i));
      if (added.length || gone.length) {
        changes.push({
          id: src.id, name: src.name, kind: '이미지 교체',
          detail: [added.length ? `+${added.join(', ')}` : '', gone.length ? `-${gone.join(', ')}` : ''].filter(Boolean).join(' / '),
        });
      }
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const report = { checked: new Date().toISOString(), previous: prev.checked, changes };

if (asJson) {
  console.log(JSON.stringify(report, null, 1));
} else {
  const ok = Object.values(now).filter((e) => e.status === 'ok').length;
  console.log(`\n출처 ${sources.length}곳 · 정상 ${ok} · 이전 확인 ${prev.checked?.slice(0, 10) ?? '없음'}`);
  if (!changes.length) {
    console.log('변경 없음\n');
  } else {
    console.log('');
    for (const c of changes) console.log(`  [${c.kind}] ${c.name}\n      ${c.detail}`);
    console.log('');
  }
  for (const s of sources) {
    const e = now[s.id];
    if (e.status !== 'ok') console.log(`  ⚠️ ${s.name}: ${e.status}`);
  }
}

if (save) {
  writeFileSync(STATE, JSON.stringify({ checked: report.checked, entries: now }, null, 1));
  console.log(`기준선 저장: ${STATE}`);
}

// 변경이 있으면 종료코드 1 — cron/CI 에서 알림 조건으로 쓴다
process.exit(changes.length ? 1 : 0);
