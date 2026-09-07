// OCR 조각 → 집회 항목. 경기남부 표 전용.
//
// 좌표를 쓰는 이유: 이 표는 셀 하나가 위아래 두 줄을 차지한다(날짜 줄 + 시간 줄).
// y 만으로 행을 묶으면 관할서 셀이 옆 행으로 밀린다. 실제로 8.29 글에서
//   이천 | 8.29(토) | 창천동 …          ← 여기까지는 맞고
//   8.30(일) | 서울구치소 1주차장 내      ← 관할서가 빠진 줄
//   의왕 | 11:45~13:00 | 1,000          ← 관할서가 다음 줄로 밀림
// 이렇게 갈라졌다. 실제 행은 "의왕 · 8.30(일) 11:45~13:00 · 서울구치소 · 1,000".
//
// 그래서 **관할서 열의 셀을 행 앵커로 삼는다.** 표의 한 행에는 관할서가 정확히
// 하나이므로, 앵커 사이의 중점으로 y 밴드를 잘라 나머지 셀을 나눠 담으면
// 밀린 셀이 제자리를 찾는다.

const HEADERS = ['관할서', '시간', '장소', '인원', '비고']

/** 헤더 줄을 찾아 열 중심 x 를 얻는다. 못 찾으면 표가 아니다. */
function findColumns(boxes) {
  const cand = boxes.filter((b) => HEADERS.some((h) => b.t.replace(/\s/g, '').startsWith(h)))
  if (cand.length < 3) return null
  // 헤더는 같은 y 에 모여 있다. 가장 많이 모인 y 를 헤더 줄로 본다.
  const byY = new Map()
  for (const b of cand) {
    const key = [...byY.keys()].find((k) => Math.abs(k - b.y) < 0.02)
    if (key == null) byY.set(b.y, [b])
    else byY.get(key).push(b)
  }
  const row = [...byY.values()].sort((a, b) => b.length - a.length)[0]
  if (!row || row.length < 3) return null

  const cols = {}
  for (const b of row) {
    const name = HEADERS.find((h) => b.t.replace(/\s/g, '').startsWith(h))
    if (name) cols[name] = b.x + b.w / 2
  }
  return { cols, headerY: row[0].y }
}

/** 가장 가까운 열 이름 */
function assignColumn(box, cols) {
  const cx = box.x + box.w / 2
  let best = null
  let bestD = Infinity
  for (const [name, x] of Object.entries(cols)) {
    const d = Math.abs(cx - x)
    if (d < bestD) { bestD = d; best = name }
  }
  return best
}

const isTime = (s) => /^\d{1,2}\s*:\s*\d{2}\s*[~∼-]/.test(s.replace(/\s/g, ''))
const isDate = (s) => /^\d{1,2}\.\d{1,2}\s*[([]/.test(s.trim())
const isCount = (s) => /^[\d,]+\s*(명)?$/.test(s.trim())

/**
 * OCR 조각들을 표 행으로 되돌린다.
 * @returns [{ station, dateText, timeText, place, peopleText }]
 */
export function parseTable(boxes) {
  const found = findColumns(boxes)
  if (!found) return []
  const { cols, headerY } = found
  if (cols['관할서'] == null) return []

  const body = boxes.filter((b) => b.y < headerY - 0.005 && !b.t.startsWith('※'))

  // 관할서 열에 떨어지는 셀 = 행 앵커
  const anchors = body
    .filter((b) => assignColumn(b, cols) === '관할서')
    .sort((a, b) => b.y - a.y)
  if (anchors.length === 0) return []

  // 앵커 사이 중점으로 y 밴드를 자른다
  const bands = anchors.map((a, i) => {
    const upper = i === 0 ? 1 : (anchors[i - 1].y + a.y) / 2
    const lower = i === anchors.length - 1 ? 0 : (a.y + anchors[i + 1].y) / 2
    return { station: a.t.replace(/\s/g, ''), upper, lower, cells: [] }
  })

  for (const b of body) {
    if (assignColumn(b, cols) === '관할서') continue
    const band = bands.find((z) => b.y <= z.upper && b.y > z.lower)
    if (band) band.cells.push(b)
  }

  return bands.map((z) => {
    z.cells.sort((a, b) => b.y - a.y || a.x - b.x)
    const time = [], date = [], count = [], place = []
    for (const c of z.cells) {
      const col = assignColumn(c, cols)
      const t = c.t.trim()
      if (col === '시간') (isDate(t) ? date : time).push(t)
      else if (col === '인원' && isCount(t)) count.push(t)
      else if (col === '장소') place.push(t)
      // 비고는 버린다 — 주최·목적이 적힐 수 있는 칸이라 이 앱은 다루지 않는다
      else if (col === '인원' && isTime(t)) time.push(t)
    }
    return {
      station: z.station,
      dateText: date.join(' ') || null,
      timeText: time.join(' ') || null,
      place: place.join(' ').replace(/\s+/g, ' ').trim() || null,
      peopleText: count[0] ?? null,
    }
  })
}
