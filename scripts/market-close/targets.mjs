// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/targets.mjs
// 갱신: node pipeline/sync-to-hub.mjs
import { existsSync, readFileSync } from 'node:fs';
import { p } from './paths.mjs';

/**
 * 대상 종목 해석. 네 스크립트가 같은 규칙을 쓰도록 한곳에 둔다.
 *
 *   --preset            프리셋 20 (out/preset.json)
 *   --wanted            추가 신청 종목 (out/wanted.json) — 있으면 합집합
 *   005930 000660 ...   명시 지정
 */
export function resolveTargets(argv) {
  const codeArgs = argv.filter((a) => /^[0-9]{6}$/.test(a));
  const out = new Map();

  if (argv.includes('--preset') && existsSync(p('preset.json'))) {
    const preset = JSON.parse(readFileSync(p('preset.json'), 'utf8'));
    for (const x of [...preset.kospi, ...preset.kosdaq]) out.set(x.code, { code: x.code, name: x.name });
  }
  if (argv.includes('--wanted') && existsSync(p('wanted.json'))) {
    const w = JSON.parse(readFileSync(p('wanted.json'), 'utf8'));
    for (const x of w.items ?? []) out.set(x.code, { code: x.code, name: x.name });
  }
  if (codeArgs.length) {
    const master = existsSync(p('tickers.json'))
      ? new Map(JSON.parse(readFileSync(p('tickers.json'), 'utf8')).items.map((x) => [x.code, x.name]))
      : new Map();
    for (const c of codeArgs) out.set(c, { code: c, name: master.get(c) ?? c });
  }
  return [...out.values()];
}
