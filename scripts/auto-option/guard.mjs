/**
 * 새로 구운 데이터를 커밋해도 되는지 본다.
 *
 * 사용: node scripts/auto-option/guard.mjs <이전.json> <신규.json>
 * 종료코드 0 = 커밋해도 됨 · 2 = 수상함(커밋하지 말고 사람이 볼 것) · 1 = 오류
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────
 * 파서는 PDF 레이아웃에 의존한다. 제조사가 가격표 서식을 조금만 바꿔도 파서는
 * **에러 없이 쓰레기를 뽑는다** — 트림을 못 찾아 차종이 통째로 빠지거나, 칼럼이
 * 밀려 엉뚱한 금액이 들어온다. 그게 자동 커밋되면 앱을 쓰는 사람이 틀린 가격을 본다.
 *
 * bake.mjs 의 검증은 "이 차종 하나가 말이 되는가" 만 본다. 여기서는 **이전 결과와
 * 비교해** "이번 변화가 말이 되는가" 를 본다. 가격표 갱신은 보통 몇 %p 움직이지,
 * 차종이 사라지거나 값이 반토막 나지 않는다.
 *
 * 의심스러우면 **커밋하지 않는다.** 하루 늦게 갱신되는 것보다 틀린 값이 나가는 게
 * 훨씬 나쁘다. 옛 데이터는 최소한 한때 사실이었다.
 */
import { existsSync, readFileSync } from 'node:fs';

const [oldPath, newPath] = process.argv.slice(2);
if (!newPath) {
  console.error('사용: node guard.mjs <이전.json> <신규.json>');
  process.exit(1);
}

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const next = load(newPath);

// 첫 수집이면 비교할 대상이 없다. bake 의 자체 검증만 믿는다.
if (!existsSync(oldPath)) {
  console.log('이전 데이터가 없다 — 첫 수집으로 보고 통과시킨다.');
  process.exit(0);
}
const prev = load(oldPath);

const byId = (list) => new Map(list.map((m) => [m.id, m]));
const P = byId(prev);
const N = byId(next);

/** 커밋을 막는 사유 */
const blocking = [];
/** 사람이 알아둘 만한 변화 (막지는 않는다) */
const notes = [];

// 1) 차종이 사라졌다 — 파서가 그 서식을 못 읽게 된 것이 가장 흔한 원인이다.
const gone = [...P.keys()].filter((id) => !N.has(id));
if (gone.length > 0) {
  const names = gone.map((id) => P.get(id).model).join(', ');
  // 하나쯤은 제조사가 단종시켰을 수 있다. 둘 이상 한꺼번에 사라지면 파서 쪽이다.
  (gone.length >= 2 ? blocking : notes).push(`차종 ${gone.length}종이 사라졌다: ${names}`);
}

const added = [...N.keys()].filter((id) => !P.has(id));
if (added.length > 0) notes.push(`차종 ${added.length}종이 늘었다: ${added.map((id) => N.get(id).model).join(', ')}`);

// 2) 전체 규모가 급감했다
if (next.length < prev.length * 0.8) {
  blocking.push(`차종 수 급감: ${prev.length} → ${next.length}`);
}
const optCount = (l) => l.reduce((n, m) => n + m.options.length, 0);
if (optCount(next) < optCount(prev) * 0.7) {
  blocking.push(`옵션 총수 급감: ${optCount(prev)} → ${optCount(next)}`);
}

// 3) 차종별로 트림이 반토막 났다
for (const [id, p] of P) {
  const n = N.get(id);
  if (!n) continue;
  if (n.trims.length < Math.max(2, p.trims.length * 0.5)) {
    blocking.push(`${p.model}: 트림 ${p.trims.length} → ${n.trims.length}`);
  }
}

// 4) 기본가가 상식 밖으로 움직였다.
//    연식변경으로 몇 %p 오르는 건 정상이다. 30% 는 칼럼이 밀렸다는 뜻에 가깝다.
for (const [id, p] of P) {
  const n = N.get(id);
  if (!n) continue;
  for (const t of p.trims) {
    const m = n.trims.find((x) => x.name === t.name);
    if (!m) continue;
    const diff = (m.price - t.price) / t.price;
    if (Math.abs(diff) > 0.3) {
      blocking.push(`${p.model} ${t.name}: ${t.price}만 → ${m.price}만 (${(diff * 100).toFixed(0)}%)`);
    } else if (Math.abs(diff) > 0.02) {
      notes.push(`${p.model} ${t.name}: ${t.price}만 → ${m.price}만`);
    }
  }
}

const same = JSON.stringify(prev) === JSON.stringify(next);
const lines = [];
lines.push(same ? '변경 없음.' : `변경 있음 · 차종 ${prev.length} → ${next.length}`);
if (notes.length > 0) lines.push('', '변화:', ...notes.slice(0, 30).map((s) => `  · ${s}`));
if (notes.length > 30) lines.push(`  · … 외 ${notes.length - 30}건`);
if (blocking.length > 0) lines.push('', '⛔ 커밋을 막는 사유:', ...blocking.map((s) => `  · ${s}`));
console.log(lines.join('\n'));

if (blocking.length > 0) {
  console.error('\n의심스러운 변화라 커밋하지 않는다. 파서나 원본 서식을 확인할 것.');
  process.exit(2);
}
process.exit(0);
