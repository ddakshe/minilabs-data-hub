import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOasisList } from './oasis-parse.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(resolve(__dirname, 'fixtures/oasis-list-44.html'), 'utf8')
const items = parseOasisList(html)

test('고정 fixture 에서 할인 상품 59건을 파싱한다', () => {
  // 카드는 60개지만 42168 은 할인율 0%(price === orig)라 제외된다.
  // 이 숫자가 고정인 이유는 fixture 가 얼어 있기 때문이다 — 라이브 페이지의 상품 수가 아니다.
  // fixture 를 다시 받으면 이 값도 다시 세야 한다.
  assert.equal(items.length, 59)
})

test('할인율 0% 카드는 제외한다 — 0%는 특가가 아니다', () => {
  assert.ok(!items.some((i) => i.id === 42168), '0% 상품 42168 이 통과됐다')
})

test('모든 항목이 필수 필드를 갖는다', () => {
  for (const it of items) {
    assert.ok(Number.isInteger(it.id) && it.id > 0, `id 이상: ${JSON.stringify(it)}`)
    assert.ok(it.name.length > 0, `name 비어있음: ${it.id}`)
    assert.ok(Number.isInteger(it.price) && it.price > 0, `price 이상: ${it.id}`)
    assert.ok(Number.isInteger(it.orig) && it.orig > 0, `orig 이상: ${it.id}`)
    assert.ok(it.rate > 0 && it.rate <= 100, `rate 이상: ${it.id}`)
  }
})

test('상품명에 개행·탭·연속공백이 남지 않는다', () => {
  // 실측 버그: "우리쌀 떡국떡\n        \t(1kg X 1개)" 처럼 원본에 공백이 섞여 온다
  for (const it of items) {
    assert.ok(!/[\n\t]/.test(it.name), `개행/탭 잔존: ${JSON.stringify(it.name)}`)
    assert.ok(!/ {2}/.test(it.name), `연속공백 잔존: ${JSON.stringify(it.name)}`)
  }
})

test('상품명에 HTML 태그가 남지 않는다', () => {
  for (const it of items) {
    assert.ok(!/[<>]/.test(it.name), `태그 잔존: ${it.name}`)
  }
})

test('할인가는 정가보다 작다', () => {
  for (const it of items) {
    assert.ok(it.price < it.orig, `가격 역전: ${it.name} ${it.price}/${it.orig}`)
  }
})

test('빈 문자열은 빈 배열을 준다 (throw 하지 않는다)', () => {
  assert.deepEqual(parseOasisList(''), [])
})

test('연속 호출해도 같은 결과다 — g 플래그 regex 의 lastIndex 재진입', () => {
  assert.deepEqual(parseOasisList(html), parseOasisList(html))
})

test('반환 필드는 정확히 5개다 — slot/img/url 은 Task 3 이 붙인다', () => {
  assert.deepEqual(Object.keys(items[0]).sort(), ['id', 'name', 'orig', 'price', 'rate'])
})
