/*
 * WGS84(위경도) → EPSG:5186 (Korea 2000 / Central Belt 2010) 정방향 투영.
 *
 * 왜 필요한가: 학구도 Shapefile 의 .prj 는 `Korea_2000_Korea_Central_Belt_2010` 이고
 * 좌표가 미터 단위 TM 이다. 반면 학교 위치 CSV 는 위경도(WGS84)로 온다.
 * **두 좌표계를 섞으면 point-in-polygon 이 조용히 전부 false 가 된다** — 예외가 안 난다.
 *
 * 파라미터(EPSG:5186): GRS80 · 원점위도 38° · 중앙자오선 127° · 축척 1.0 · FE 200000 · FN 600000.
 * Korea 2000(GRS80)과 WGS84 는 datum 차이가 cm 급이라 datum 변환은 생략한다
 * (학구 폴리곤 경계 판정에는 무의미한 오차다).
 */
const A = 6378137.0                    // GRS80 장반경
const F = 1 / 298.257222101            // GRS80 편평률
const E2 = F * (2 - F)
const EP2 = E2 / (1 - E2)

const LON0 = (127.0 * Math.PI) / 180
const LAT0 = (38.0 * Math.PI) / 180
const K0 = 1.0
const FE = 200000.0
const FN = 600000.0

/** 자오선호장 */
function meridian(phi) {
  return A * (
    (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi
    - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi)
  )
}
const M0 = meridian(LAT0)

/** @returns {[number, number]} [x, y] 미터 */
export function toKorea2000(lon, lat) {
  const phi = (lat * Math.PI) / 180
  const lam = (lon * Math.PI) / 180
  const sinPhi = Math.sin(phi)
  const cosPhi = Math.cos(phi)
  const tanPhi = Math.tan(phi)

  const N = A / Math.sqrt(1 - E2 * sinPhi * sinPhi)
  const T = tanPhi * tanPhi
  const C = EP2 * cosPhi * cosPhi
  const Aa = (lam - LON0) * cosPhi

  const x = FE + K0 * N * (
    Aa + ((1 - T + C) * Aa ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120
  )
  const y = FN + K0 * (
    meridian(phi) - M0 + N * tanPhi * (
      (Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
      + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720
    )
  )
  return [x, y]
}
