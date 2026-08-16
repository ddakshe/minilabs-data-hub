// 현대 페이지 DOM 구조 디버그용
// Usage: node scripts/debug-hyundai.mjs B00174000
import { chromium } from 'playwright'

const branchCd = process.argv[2] || 'B00174000'
const url = `https://www.ehyundai.com/newPortal/SN/SN_0101000.do?branchCd=${branchCd}`

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

console.log(`\n▶ 접속: ${url}`)
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)

// 실제 DOM 구조 출력
const info = await page.evaluate(() => {
  // 이벤트 관련 가능성 있는 모든 클래스 수집
  const allEls = document.querySelectorAll('[class]')
  const classes = new Set()
  for (const el of allEls) {
    for (const cls of el.classList) {
      if (/event|list|item|card|promo|sale|gift|culture/i.test(cls)) {
        classes.add(`${el.tagName.toLowerCase()}.${cls}`)
      }
    }
    if (classes.size > 60) break
  }

  // li 요소 중 텍스트 있는 것 샘플
  const lis = [...document.querySelectorAll('li')].filter(el => el.innerText?.trim().length > 5)
  const liSamples = lis.slice(0, 10).map(el => ({
    class: el.className,
    text: el.innerText?.trim().slice(0, 80),
  }))

  // 탭 버튼 구조
  const tabs = [...document.querySelectorAll('a, button')].filter(el =>
    /사은|문화|쇼핑|이벤트|행사/.test(el.innerText)
  ).map(el => ({
    tag: el.tagName,
    id: el.id,
    class: el.className,
    href: el.href || '',
    text: el.innerText?.trim(),
  }))

  return { classes: [...classes], liSamples, tabs }
})

console.log('\n[ 이벤트 관련 클래스 ]')
info.classes.forEach(c => console.log(' ', c))

console.log('\n[ 탭 버튼 ]')
info.tabs.forEach(t => console.log(' ', JSON.stringify(t)))

console.log('\n[ li 샘플 ]')
info.liSamples.forEach(l => console.log(' ', JSON.stringify(l)))

await browser.close()
