// 경기남부경찰청 "오늘의 주요집회" 게시판 접근 계층.
//
// 서울과 다른 점이 셋이다:
//   1. WAF 가 307 로 TMOSHCooKie 를 심고 자기 자신으로 리다이렉트한다.
//      쿠키를 들고 다시 때려야 통과한다. (fetch 기본 리다이렉트로는 안 된다)
//   2. 상세가 GET 이 아니라 폼 POST 다. GET 은 500.
//   3. 본문에 텍스트가 없다. 표가 JPG 첨부 하나로만 올라온다 → OCR 필요.

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'

const ORIGIN = 'https://www.ggpolice.go.kr'
export const LIST_URL = `${ORIGIN}/main/bbslist.do?bbsId=FD2`
const VIEW_URL = `${ORIGIN}/main/bbsview.do`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 쿠키 항아리. 서버가 심는 WAF 쿠키를 들고 다녀야 해서 직접 관리한다. */
export function makeJar() {
  return new Map()
}

function absorb(jar, res) {
  const raw = res.headers.getSetCookie?.() ?? []
  for (const line of raw) {
    const [pair] = line.split(';')
    const idx = pair.indexOf('=')
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * 리다이렉트를 손으로 따라가며 쿠키를 축적한다.
 * WAF 는 "쿠키 심고 같은 URL 로 307" 을 한 번 하므로 보통 1홉이면 끝난다.
 */
async function request(jar, url, { method = 'GET', body, referer } = {}) {
  let current = url
  for (let hop = 0; hop < 5; hop++) {
    const headers = {
      'User-Agent': UA,
      'Accept-Language': 'ko-KR,ko;q=0.9',
      ...(referer ? { Referer: referer } : {}),
      ...(jar.size ? { Cookie: cookieHeader(jar) } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    }
    // 리다이렉트된 뒤에는 POST 본문을 다시 보내지 않는다 (WAF 는 GET 으로 되돌린다).
    const res = await fetch(current, {
      method: hop === 0 ? method : 'GET',
      headers,
      body: hop === 0 ? body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    })
    absorb(jar, res)

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`${res.status} 인데 Location 이 없다: ${current}`)
      current = new URL(loc, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${current}`)
    return res
  }
  throw new Error(`리다이렉트가 끝나지 않는다: ${url}`)
}

export async function fetchText(jar, url, opts) {
  const res = await request(jar, url, opts)
  return res.text()
}

export async function fetchBuffer(jar, url, opts) {
  const res = await request(jar, url, opts)
  return Buffer.from(await res.arrayBuffer())
}

/** 목록 → [{ seq, title }]. 최신순 그대로. */
export async function fetchList(jar) {
  const html = await fetchText(jar, LIST_URL)
  const out = []
  const re = /bbsView\('(\d+)'\)[^>]*>([\s\S]*?)<\/a>/g
  for (const m of html.matchAll(re)) {
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
    if (title) out.push({ seq: m[1], title })
  }
  return out
}

/** 상세 → { html, imageUrl }. 첨부 이미지가 없으면 imageUrl 은 null. */
export async function fetchDetail(jar, seq) {
  const body = new URLSearchParams({
    orgId: 'MAIN',
    bbsId: 'FD2',
    contentSeq: String(seq),
    pageIndex: '1',
    search_word: '',
  }).toString()
  const html = await fetchText(jar, VIEW_URL, { method: 'POST', body, referer: LIST_URL })
  const m = html.match(/href="((?:\.\/)?download\.do\?[^"]+)"/)
  const imageUrl = m ? new URL(m[1].replace(/^\.\//, ''), `${ORIGIN}/main/`).toString() : null
  await sleep(300) // 게시판에 부담 주지 않는다
  return { html, imageUrl }
}
