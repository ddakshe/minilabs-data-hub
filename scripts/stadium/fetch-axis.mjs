#!/usr/bin/env node
/**
 * 경기장 장축(axis)을 OpenStreetMap 에서 계산한다.
 *
 * 앱(stadium-seats)의 구장 도식과 햇빛 계산이 이 값 하나에 걸려 있다. axis 를 알면
 * 스탠드 네 면의 방향이 기하로 정해지므로, 구단이 좌석 배치를 공개하지 않아도
 * "서측 스탠드는 오후에 해를 등진다"까지는 말할 수 있다.
 *
 * 🚨 **'가장 긴 변 = 장축' 이 아니다.** 폴리곤이 잘게 쪼개져 그려진 경기장이 있다 —
 *    인천은 정점 12개에 최장변이 48m 인데 실제 잔디는 114×73m 다. 그래서 최장변이
 *    아니라 **최소 외접 사각형(rotating calipers)** 의 긴 변을 쓴다.
 *
 * 출처: OpenStreetMap (ODbL). 각 레코드에 way id 를 남긴다.
 */
import { writeFileSync, readFileSync } from 'node:fs';

const OVERPASS = 'https://overpass-api.de/api/interpreter';

async function overpass(query) {
  // 🚨 User-Agent 를 안 보내면 406 이 온다. OSM 이용 정책상 식별 가능한 UA 를 요구한다.
  //    curl 은 자기 UA 를 보내서 되는데 node fetch 는 안 보내므로, 되는 줄 알고
  //    curl 로만 확인하면 스크립트에서 막힌다.
  /*
   * 공용 Overpass 는 자주 바쁘다. 그리고 **바쁠 때 200 으로 HTML 을 준다** —
   * res.ok 만 보면 통과한 뒤 JSON 파싱에서 엉뚱하게 죽는다. 본문을 먼저 확인한다.
   */
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      headers: {
        'User-Agent': 'minilabs-data-hub/1.0 (stadium axis; ddakshe@gmail.com)',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ data: query }),
    });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);

    const busy = /too busy|timeout|rate_limited/i.test(text) || res.status === 429;
    if (!busy || attempt === 4) {
      throw new Error(`overpass ${res.status}: ${text.slice(0, 200)}`);
    }
    const wait = attempt * 20;
    console.log(`  서버가 바쁘다. ${wait}초 뒤 재시도 (${attempt}/3)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

/** 위경도를 미터 평면으로. 경기장 하나 크기(수백 m)에서는 이 근사로 충분하다. */
function toMeters(points, lat0) {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return points.map((p) => ({
    x: p.lon * 111320 * k,
    y: p.lat * 110540,
  }));
}

/** 볼록 껍질 (Andrew monotone chain) */
function hull(pts) {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...s].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * 최소 외접 사각형. 볼록 껍질의 각 변을 축으로 놓고 넓이가 가장 작은 것을 고른다.
 * 최적 사각형의 한 변은 반드시 껍질의 한 변과 겹친다는 성질을 쓴다.
 */
export function minAreaRect(points) {
  const h = hull(points);
  let best = null;

  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const cos = Math.cos(-ang);
    const sin = Math.sin(-ang);

    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of h) {
      const u = p.x * cos - p.y * sin;
      const v = p.x * sin + p.y * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const hgt = maxV - minV;
    const area = w * hgt;
    if (!best || area < best.area) {
      best = { area, w, h: hgt, ang };
    }
  }
  return best;
}

/**
 * 장축 방위각(도, 정북 0 · 동 90). 0~180 으로 접는다 — 장축은 방향이 아니라 선이다.
 *
 * atan2(dy, dx) 는 동쪽을 0 으로 재는 수학 각도다. 방위각은 북쪽이 0 이고 시계 방향이라
 * 90 - deg 로 바꾼다. 이 변환을 빼먹으면 축이 90도 돌아간 채 그럴듯해 보인다.
 */
export function axisFromRect(rect) {
  // 긴 변이 장축이다. w 가 짧으면 축을 90도 돌린다.
  const ang = rect.w >= rect.h ? rect.ang : rect.ang + Math.PI / 2;
  const deg = (ang * 180) / Math.PI;
  // 🚨 반올림을 먼저 하고 접는다. 순서를 바꾸면 179.98 이 180.0 으로 반올림돼
  //    범위(0 이상 180 미만)를 벗어난다 — 실제로는 0°(남북)인데 180° 로 표시된다.
  const rounded = Number((((90 - deg) % 180) + 180).toFixed(1));
  return Number((rounded % 180).toFixed(1));
}

async function main() {
  const targets = JSON.parse(readFileSync(new URL('./targets.json', import.meta.url), 'utf8'));

  // 경기장 중심 반경 150m 안의 축구 잔디를 한 번에 받는다
  const clauses = targets
    /*
     * 🚨 sport=soccer 로 좁히지 않는다. 수원월드컵의 잔디(way/175910272)에는 sport
     *    태그가 아예 없어서 그 조건 하나로 통째로 놓쳤다. OSM 은 태그가 고르지 않다 —
     *    있는 태그를 믿기보다 **크기로 거른다**(아래 정규 규격 필터). 그쪽이 훨씬 튼튼하다.
     */
    .map((t) => `way["leisure"="pitch"](around:150,${t.lat},${t.lon});`)
    .join('\n  ');
  const data = await overpass(`[out:json][timeout:300];\n(\n  ${clauses}\n);\nout geom;`);

  const out = [];
  for (const t of targets) {
    // 중심에서 가장 가깝고 가장 큰 잔디를 고른다 — 보조구장이 함께 잡힐 수 있다
    const near = data.elements
      .filter((e) => e.geometry?.length >= 4)
      .map((e) => {
        const lat0 = e.geometry.reduce((s, p) => s + p.lat, 0) / e.geometry.length;
        const lon0 = e.geometry.reduce((s, p) => s + p.lon, 0) / e.geometry.length;
        const d = Math.hypot((lat0 - t.lat) * 110540, (lon0 - t.lon) * 111320 * Math.cos((t.lat * Math.PI) / 180));
        const rect = minAreaRect(toMeters(e.geometry, t.lat));
        return { e, d, rect, long: Math.max(rect.w, rect.h), short: Math.min(rect.w, rect.h) };
      })
      .filter((x) => x.d < 150)
      // 정규 축구장은 대략 100~110 × 64~75m 다. 보조구장·풋살장을 걸러낸다.
      .filter((x) => x.long > 90 && x.long < 130 && x.short > 55 && x.short < 90)
      .sort((a, b) => a.d - b.d);

    if (near.length === 0) {
      out.push({ ...t, axis: null, osm: null, note: '반경 150m 안에서 정규 규격 잔디를 찾지 못했다' });
      continue;
    }
    const win = near[0];
    out.push({
      ...t,
      axis: axisFromRect(win.rect),
      pitch: { long: Math.round(win.long), short: Math.round(win.short) },
      osm: `way/${win.e.id}`,
      license: 'OpenStreetMap (ODbL)',
    });
  }

  writeFileSync(
    new URL('../../stadium/axis.json', import.meta.url),
    JSON.stringify({ fetched: new Date().toISOString(), stadiums: out }, null, 2) + '\n',
  );
  const ok = out.filter((o) => o.axis !== null).length;
  console.log(`axis 계산 ${ok}/${out.length}`);
  for (const o of out) {
    console.log(
      `  ${o.name.padEnd(18)} ${o.axis === null ? '실패 — ' + o.note : `${String(o.axis).padStart(5)}°  ${o.pitch.long}×${o.pitch.short}m  ${o.osm}`}`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
