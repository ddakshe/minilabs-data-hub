/*
 * report-reward 의 동네 단위 = 기초자치단체. 조례는 자치단체가 만들기 때문이다.
 *   - 일반구(수원시 장안구 등)는 모시로 묶는다: code 앞 4자리 + '0' (41111 → 41110)
 *   - 세종·제주는 광역 조례를 쓴다: 세종 36110, 제주 50000(제주시·서귀포시)
 * 목록의 진실원은 realestate/region-master.json (2026 행정구역 개편 반영).
 * orgName 은 국가법령정보센터 응답의 「지자체기관명」과 글자 단위로 같다.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

export async function loadUnits(root) {
  const master = JSON.parse(await fs.readFile(path.join(root, 'realestate', 'region-master.json'), 'utf8'))
  const units = new Map()
  for (const r of master.regions) {
    if (r.sido === '제주특별자치도') {
      units.set('50000', { code: '50000', sido: r.sido, sigungu: '제주시·서귀포시', orgName: r.sido })
      continue
    }
    if (r.sido === '세종특별자치시') {
      units.set(r.code, { code: r.code, sido: r.sido, sigungu: r.sido, orgName: r.sido })
      continue
    }
    const [city, gu] = r.sigungu.split(' ')
    const code = gu ? r.code.slice(0, 4) + '0' : r.code
    if (!units.has(code)) units.set(code, { code, sido: r.sido, sigungu: city, orgName: `${r.sido} ${city}` })
  }
  return [...units.values()].sort((a, b) => a.code.localeCompare(b.code))
}

/** 조례 제목에 들어가는 지자체 이름 — 「서울특별시 강남구 …」「수원시 …」「제주특별자치도 …」 */
export const shortName = (unit) => unit.orgName.split(' ').pop()
