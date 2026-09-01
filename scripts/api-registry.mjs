#!/usr/bin/env node
/**
 * api-registry.mjs — 어느 워크플로가 어느 API 를 얼마나 먹는지 표로 만든다.
 *
 *   node scripts/api-registry.mjs           docs/api-budget.md 갱신
 *   node scripts/api-registry.mjs --check    갱신 없이 검사만 (CI 용)
 *
 * ## 왜 필요한가
 *
 * `DART_API_KEY` 를 **5개 워크플로가 나눠 쓴다**(한도 20,000/일). `DATA_GO_KR_KEY` 는
 * 7개다. 그런데 어느 워크플로가 얼마나 먹는지 적어 둔 곳이 없어서, 새 배치를 붙일 때
 * **남은 한도를 모르고 붙이게 된다.** 한도를 넘기면 그 키를 쓰는 형제 앱이 같이 멈춘다.
 *
 * ## 스캔이 진실, 선언이 예산
 *
 * 워크플로 목록과 cron 은 `.github/workflows/` 를 **읽어서** 얻는다. 손으로 관리하지
 * 않으므로 틀릴 수가 없다. 한도와 호출량은 코드가 알 수 없어 `docs/api-limits.json`
 * 에 선언한다.
 *
 * 🔑 **스캔에서 나왔는데 선언이 없으면 「미신고」로 뜬다.** 그게 이 스크립트의 핵심이다 —
 *    누군가 새 워크플로에 키를 붙이면 다음 실행에서 바로 드러난다. 표를 손으로
 *    유지하면 이 드리프트를 절대 못 잡는다.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WF_DIR = join(ROOT, '.github', 'workflows');
const LIMITS = join(ROOT, 'docs', 'api-limits.json');
const OUT = join(ROOT, 'docs', 'api-budget.md');
const CHECK_ONLY = process.argv.includes('--check');

/** 예산 표는 소수점이 의미 없다. 0.4회/일 같은 값만 한 자리로 남긴다. */
const round = (n) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n));

/**
 * cron 다섯 칸에서 하루 실행 횟수를 어림한다. 정확한 파서가 아니라 **예산용 추정**이다.
 *
 * 🚨 **다섯 칸을 다 봐야 한다.** 처음엔 분·시·요일만 읽고 일·월을 버렸는데,
 *    `0 0 1 4,5 *`(연 2회, 4·5월 1일)가 **하루 2회**로 잡혀 예산이 4,000배 부풀었다
 *    (2026-09-01). 연 1~2회 도는 무거운 배치가 정확히 이 모양이라, 버리면 안 되는
 *    칸만 골라 버린 셈이었다.
 */
function runsPerDay(cron) {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const count = (field, total) => {
    if (field === '*') return total;
    if (field.startsWith('*/')) return Math.floor(total / Number(field.slice(2)));
    return field.split(',').filter(Boolean).length;
  };
  const perHour = min === '*' ? 60 : count(min, 60);
  const hours = count(hour, 24);
  // 날짜·월·요일 제한은 비율로 환산한다 (평일만이면 5/7, 4·5월만이면 2/12)
  const domFrac = dom === '*' ? 1 : count(dom, 31) / 31;
  const monFrac = mon === '*' ? 1 : count(mon, 12) / 12;
  const dowFrac = dow === '*' ? 1 : count(dow, 7) / 7;
  return perHour * hours * domFrac * monFrac * dowFrac;
}

// ── 스캔 ────────────────────────────────────────────────────────────
const files = readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
/**
 * 🚨 **시크릿만 스캔하면 셀프호스티드 워크플로가 통째로 투명해진다.**
 * `fetch-dividend-kr.yml` 은 GitHub Secrets 를 쓰지 않고 러너의
 * `~/.config/stock-tools/dart.env` 를 직접 읽는다 — DART 를 4,000콜 쓰는데
 * `secrets.` 스캔에는 한 줄도 안 걸린다 (2026-09-01 실측).
 * 무거운 배치일수록 셀프호스티드로 옮겨져 있어서, **관리에서 빠지면 안 될 것만
 * 골라 빠지는** 구조였다. 파일 기반 자격증명도 같이 잡는다.
 */
const ENV_FILE_TO_KEY = {
  dart: 'DART_API_KEY',
  datagokr: 'DATA_GO_KR_KEY',
  ecos: 'ECOS_API_KEY',
  toss: 'TOSS_API_KEY',
};

/** @type {Map<string, {file:string, runs:number, crons:string[], via:string}[]>} */
const usage = new Map();

for (const file of files) {
  const src = readFileSync(join(WF_DIR, file), 'utf8');
  const secrets = [...new Set([...src.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
  // 러너의 로컬 자격증명 파일을 읽는 워크플로
  const viaFile = [...new Set(
    [...src.matchAll(/config\/stock-tools\/([a-z0-9_-]+)\.env/g)]
      .map((m) => ENV_FILE_TO_KEY[m[1]])
      .filter(Boolean),
  )];
  const crons = [...src.matchAll(/cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  // schedule 이 없으면 수동/디스패치 전용이다 — 예산은 1회로 잡는다
  const runs = crons.length ? crons.reduce((s, c) => s + runsPerDay(c), 0) : 0;
  for (const s of secrets) {
    if (s === 'GITHUB_TOKEN') continue; // 한도 관리 대상이 아니다
    if (!usage.has(s)) usage.set(s, []);
    usage.get(s).push({ file, runs, crons, via: 'secrets' });
  }
  for (const s of viaFile) {
    if (usage.get(s)?.some((c) => c.file === file)) continue; // 둘 다 쓰면 한 번만
    if (!usage.has(s)) usage.set(s, []);
    usage.get(s).push({ file, runs, crons, via: '러너 파일' });
  }
}

// ── 예산과 대조 ──────────────────────────────────────────────────────
const limits = JSON.parse(readFileSync(LIMITS, 'utf8'));
const lines = [];
const problems = [];

lines.push('# API 예산 — 어느 워크플로가 어느 한도를 먹는가');
lines.push('');
lines.push('> 🤖 **자동 생성이다. 손으로 고치지 말 것** — `node scripts/api-registry.mjs` 가 다시 쓴다.');
lines.push('> 한도·호출량은 `docs/api-limits.json` 에서 고친다. 워크플로 목록과 주기는 스캔 결과다.');
lines.push('');
lines.push('**새 배치를 붙이기 전에 여기서 남은 한도를 확인한다.** 한도를 넘기면 그 키를 쓰는');
lines.push('형제 앱이 **같이 멈춘다.**');
lines.push('');

for (const [key, meta] of Object.entries(limits.apis)) {
  const consumers = usage.get(key) ?? [];
  lines.push(`## ${key}`);
  lines.push('');
  lines.push(`- **${meta.provider}** · 한도 **${meta.limitPerDay.toLocaleString()}건/일**`);
  lines.push(`- 범위: ${meta.scope}`);
  if (meta.warn) lines.push(`- 🚨 ${meta.warn}`);
  lines.push('');
  lines.push('| 워크플로 | 주기(회/일) | 콜/회 | 평균/일 | 비고 |');
  lines.push('|---|---:|---:|---:|---|');

  let total = 0;
  let peak = 0;
  for (const c of consumers.sort((a, b) => a.file.localeCompare(b.file))) {
    const b = meta.budget?.[c.file];
    if (!b) {
      problems.push(`[미신고] ${key} 를 쓰는 ${c.file} 이 api-limits.json 에 없다`);
      lines.push(`| \`${c.file}\` | ${c.runs || '수동'} | **?** | **?** | ⚠️ **미신고 — api-limits.json 에 추가할 것** |`);
      continue;
    }
    const runs = c.runs || 1; // 수동 실행은 1회로 잡는다
    const day = runs * b.callsPerRun;
    total += day;
    // 🔑 **한도를 깨는 건 평균이 아니라 버스트다.** 연 2회 4,000콜짜리는 평균으로는
    //    22/일이지만, 그날 하루는 4,000 을 먹고 같은 키를 쓰는 앱과 부딪힌다.
    peak = Math.max(peak, b.callsPerRun);
    const note = [c.via === '러너 파일' ? '🖥 러너 파일' : null, b.dataset, b.note]
      .filter(Boolean).join(' · ');
    lines.push(
      `| \`${c.file}\` | ${c.runs ? round(c.runs) : '수동'} | ${b.callsPerRun.toLocaleString()} | ${round(day).toLocaleString()} | ${note} |`,
    );
  }

  // 선언돼 있는데 스캔에 안 잡히는 것.
  // `planned: true` 면 아직 안 만든 것이고, 아니면 지워졌거나 이름이 바뀐 것이다.
  for (const [file, b] of Object.entries(meta.budget ?? {})) {
    if (consumers.some((c) => c.file === file)) continue;
    if (b.planned) {
      // 만들기 **전에** 자리를 잡아 두는 쪽이 낫다 — 붙일 여유가 있는지 먼저 보인다
      lines.push(`| \`${file}\` | 예정 | ${b.callsPerRun.toLocaleString()} | — | 📋 **예정** · ${b.note ?? ''} |`);
      peak = Math.max(peak, b.callsPerRun);
      continue;
    }
    problems.push(`[유령] ${key} 예산에 ${file} 이 있는데 그 워크플로가 없다`);
    lines.push(`| ~~\`${file}\`~~ | — | — | — | 👻 **워크플로 없음 — 예산에서 지울 것** |`);
  }

  const pct = Math.round((total / meta.limitPerDay) * 100);
  const bar = pct > 80 ? '🔴' : pct > 50 ? '🟡' : '🟢';
  lines.push(`| **합계** | | | **${round(total).toLocaleString()}** | ${bar} 평균은 한도의 **${pct}%** |`);
  lines.push('');
  const peakPct = Math.round((peak / meta.limitPerDay) * 100);
  lines.push(`> **최대 1회 소모 ${peak.toLocaleString()}건 (한도의 ${peakPct}%).** 한도를 깨는 것은`);
  lines.push('> 평균이 아니라 **버스트**다 — 무거운 배치가 도는 날은 같은 키를 쓰는 다른');
  lines.push('> 워크플로와 부딪힌다. 큰 배치는 날짜를 겹치지 않게 두거나 나눠 돌린다.');
  lines.push('');
  if (pct > 80) problems.push(`[한도] ${key} 평균이 한도의 ${pct}% 다 — 새 배치를 붙일 여유가 없다`);
  if (peakPct > 60) problems.push(`[버스트] ${key} 의 단일 실행이 한도의 ${peakPct}% 를 먹는다 — 그날 다른 워크플로가 막힐 수 있다`);
}

// 어떤 API 에도 선언이 없는 키 — 한도를 아무도 모르는 것들이다
const unknown = [...usage.keys()].filter((k) => !limits.apis[k]);
if (unknown.length) {
  lines.push('## ⬜ 한도를 모르는 키');
  lines.push('');
  lines.push('아래 키는 워크플로가 쓰고 있는데 `api-limits.json` 에 한도가 없다.');
  lines.push('**한도를 모르면 남은 여유도 모른다.** 발급처에서 확인해 채운다.');
  lines.push('');
  for (const k of unknown.sort()) {
    lines.push(`- \`${k}\` — ${usage.get(k).map((c) => `\`${c.file}\``).join(', ')}`);
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push(`스캔: 워크플로 ${files.length}개 · 관리 대상 키 ${usage.size}개 · ${new Date().toISOString().slice(0, 10)}`);
lines.push('');

if (!CHECK_ONLY) writeFileSync(OUT, lines.join('\n'));

console.log(lines.join('\n'));
if (problems.length) {
  console.error('\n🚨 확인이 필요하다:');
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}
console.error('\n✅ 미신고·유령·한도 초과 없음');
