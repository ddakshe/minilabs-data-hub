// Usage: node scripts/debug-lotte.mjs 0352
import { chromium } from 'playwright'

const cstrCd = process.argv[2] || '0352'
const url = `https://www.lotteshopping.com/shopnow/cntsList?cstrCd=${cstrCd}`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

console.log(`\n▶ 접속: ${url}`)
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)

const info = await page.evaluate(() => {
  // 이벤트 카드 관련 클래스 수집
  const classes = new Set()
  for (const el of document.querySelectorAll('[class]')) {
    for (const cls of el.classList) {
      if (/card|item|event|list|thumb|tit|title|date|period|news|content/i.test(cls))
        classes.add(`${el.tagName.toLowerCase()}.${cls}`)
    }
    if (classes.size > 50) break
  }

  // 카드처럼 생긴 요소 샘플 (a 태그 포함, 텍스트 있는 것)
  const cards = [...document.querySelectorAll('a[href], li, article')].filter(el => {
    const t = el.innerText?.trim()
    return t && t.length > 5 && t.length < 200
  }).slice(0, 8).map(el => ({
    tag: el.tagName,
    class: el.className.slice(0, 60),
    href: el.href?.slice(0, 80) || '',
    text: el.innerText?.trim().slice(0, 100),
  }))

  return { classes: [...classes], cards }
})

console.log('\n[ 이벤트 관련 클래스 ]')
info.classes.forEach(c => console.log(' ', c))

console.log('\n[ 카드 샘플 ]')
info.cards.forEach(c => console.log(' ', JSON.stringify(c)))

await browser.close()
