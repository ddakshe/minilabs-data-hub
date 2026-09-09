/*
 * 최소 Shapefile 리더 — .dbf(속성) + .shp(폴리곤 지오메트리).
 *
 * 왜 직접 파싱하나: 러너와 로컬 어디에도 GDAL/geopandas 가 없고, 이 용도에 필요한 건
 * "폴리곤 하나에 점이 들어가나" 뿐이라 의존성을 늘릴 이유가 없다.
 *
 * ── 함정 (전부 실측) ────────────────────────────────────────
 * 1) **.dbf 는 EUC-KR 이다** (.cpg 파일이 그렇게 선언한다). UTF-8 로 읽으면 학구명이 깨진다.
 * 2) **.shp 헤더 길이 단위는 16비트 워드다.** 파일 길이 필드에 2를 곱해야 바이트가 된다.
 * 3) **지오메트리를 전부 메모리에 펼치지 않는다.** 초등 통학구역 .shp 만 52MB 라
 *    7,140개 폴리곤의 좌표를 JS 배열로 올리면 수백 MB 가 된다. 레코드 오프셋과 bbox 만
 *    미리 훑고, 좌표는 bbox 를 통과한 후보에 대해서만 그때 읽는다.
 * 4) **폴리곤은 여러 링(구멍·다중부분)으로 온다.** 링별로 홀짝 판정을 누적해야
 *    도넛 모양 학구에서 구멍이 제대로 뚫린다.
 */

/** .dbf 속성 테이블 → { fields: string[], rows: Record<string,string>[] } */
export function readDbf(buf, encoding = 'euc-kr') {
  const dec = new TextDecoder(encoding)
  const nRec = buf.readUInt32LE(4)
  const headerLen = buf.readUInt16LE(8)
  const recLen = buf.readUInt16LE(10)

  const fields = []
  for (let off = 32; off < headerLen - 1; off += 32) {
    if (buf[off] === 0x0d) break
    const nameEnd = buf.indexOf(0x00, off) - off
    const name = dec.decode(buf.subarray(off, off + (nameEnd > 0 && nameEnd < 11 ? nameEnd : 11)))
    fields.push({ name, length: buf[off + 16] })
  }

  const rows = []
  for (let i = 0; i < nRec; i++) {
    const base = headerLen + i * recLen
    if (buf[base] === 0x2a) continue // 삭제 표시 레코드
    const row = {}
    let o = base + 1
    for (const f of fields) {
      row[f.name] = dec.decode(buf.subarray(o, o + f.length)).trim()
      o += f.length
    }
    rows.push(row)
  }
  return { fields: fields.map((f) => f.name), rows }
}

const SHAPE_POLYGON = 5

/**
 * .shp 을 훑어 레코드별 bbox 와 오프셋만 세운다. 좌표는 rings(i) 로 필요할 때 읽는다.
 * @returns {{count:number, bbox:Float64Array, rings:(i:number)=>number[][][]}}
 */
export function indexShp(buf) {
  const fileLen = buf.readUInt32BE(24) * 2 // 함정 2: 워드 단위
  const offsets = []
  const bboxes = []

  let p = 100
  while (p + 8 <= fileLen) {
    const contentLen = buf.readUInt32BE(p + 4) * 2
    const body = p + 8
    const type = buf.readInt32LE(body)
    if (type === SHAPE_POLYGON) {
      offsets.push(body)
      bboxes.push(
        buf.readDoubleLE(body + 4), buf.readDoubleLE(body + 12),
        buf.readDoubleLE(body + 20), buf.readDoubleLE(body + 28),
      )
    } else {
      offsets.push(-1)
      bboxes.push(NaN, NaN, NaN, NaN)
    }
    p = body + contentLen
  }

  const bbox = Float64Array.from(bboxes)
  return {
    count: offsets.length,
    bbox,
    rings(i) {
      const body = offsets[i]
      if (body < 0) return []
      const nParts = buf.readInt32LE(body + 36)
      const nPoints = buf.readInt32LE(body + 40)
      const partsOff = body + 44
      const ptsOff = partsOff + 4 * nParts
      const out = []
      for (let k = 0; k < nParts; k++) {
        const s = buf.readInt32LE(partsOff + 4 * k)
        const e = k + 1 < nParts ? buf.readInt32LE(partsOff + 4 * (k + 1)) : nPoints
        const ring = new Array(e - s)
        for (let j = s; j < e; j++) {
          ring[j - s] = [buf.readDoubleLE(ptsOff + 16 * j), buf.readDoubleLE(ptsOff + 16 * j + 8)]
        }
        out.push(ring)
      }
      return out
    },
  }
}

/** 링 집합에 대한 홀짝(even-odd) 판정. 구멍이 있는 폴리곤도 올바르게 처리한다. */
export function pointInRings(x, y, rings) {
  let inside = false
  for (const ring of rings) {
    const n = ring.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = ring[i]
      const [xj, yj] = ring[j]
      if ((yi > y) !== (yj > y)) {
        if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
      }
    }
  }
  return inside
}
