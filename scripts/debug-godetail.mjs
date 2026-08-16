import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()

await page.goto('https://www.ehyundai.com/newPortal/SN/SN_0101000.do?branchCd=B00174000', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(1500)

const fnSrc = await page.evaluate(() => {
  return typeof goDetail === 'function' ? goDetail.toString().slice(0, 800) : 'not found'
})
console.log('goDetail:', fnSrc)

await browser.close()
