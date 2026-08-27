// ⚠️ 생성된 사본이다. 고치지 말 것.
// 원본: market-close-mini/pipeline/paths.mjs
// 갱신: node pipeline/sync-to-hub.mjs
/**
 * 산출물 루트. 로컬은 `out/`, minilabs-data-hub 에서는 `market-close/` 다.
 *
 * 스크립트를 두 저장소에 두 벌로 두면 반드시 갈라진다. 경로만 환경변수로 빼서
 * **같은 파일이 양쪽에서 그대로 돌게** 한다 (pipeline/sync-to-hub.mjs 가 복사한다).
 */
export const OUT = process.env.MC_OUT ?? 'out';
export const p = (...parts) => [OUT, ...parts].join('/');
