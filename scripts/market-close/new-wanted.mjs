#!/usr/bin/env node
// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/new-wanted.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * new-wanted.mjs — 신청됐지만 아직 리포트가 없는 종목 코드를 출력한다.
 *
 * 출력은 공백으로 구분된 종목코드 한 줄. 없으면 빈 줄이다.
 * 워크플로가 이 출력을 그대로 다음 스크립트의 인자로 넘긴다.
 *
 *   node pipeline/new-wanted.mjs
 *   → 000370 000880
 */
import { existsSync, readFileSync } from 'node:fs';
import { p } from './paths.mjs';

const wantedPath = p('wanted.json');
if (!existsSync(wantedPath)) { console.log(''); process.exit(0); }

const w = JSON.parse(readFileSync(wantedPath, 'utf8'));
const missing = (w.items ?? [])
  .map((x) => x.code)
  // 리포트 디렉토리가 이미 있으면 정규 크론이 매일 갱신한다. 여기서 다시 만들 필요가 없다.
  .filter((code) => !existsSync(p(`reports/${code}/index.json`)));

console.log(missing.join(' '));
