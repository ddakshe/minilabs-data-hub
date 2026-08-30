import test from 'node:test'
import assert from 'node:assert/strict'
import { SLOTS, slotForKurly, OASIS_CATEGORIES } from './slots.mjs'

test('국/탕/찌개는 soup 슬롯이다', () => {
  assert.equal(slotForKurly([2, 16, 1174, 1177]), 'soup')
})

test('주방용품은 배제한다 — 밥상에 주걱이 오르면 안 된다', () => {
  assert.equal(slotForKurly([2, 11, 94, 476]), null)
})

test('양념/오일은 배제한다', () => {
  assert.equal(slotForKurly([2, 27, 178, 767]), null)
})

test('배제 카테고리는 슬롯 매칭보다 우선한다', () => {
  // 국 카테고리와 주방용품이 함께 붙은 상품은 배제되어야 한다
  assert.equal(slotForKurly([1174, 11]), null)
})

test('매핑에 없는 카테고리는 null 이다', () => {
  assert.equal(slotForKurly([2, 99999]), null)
})

test('빈 배열은 null 이다', () => {
  assert.equal(slotForKurly([]), null)
})

test('SLOTS 는 6개 슬롯을 갖는다', () => {
  assert.deepEqual(SLOTS, ['soup', 'main', 'banchan', 'kimchi', 'tofu', 'snack'])
})

test('오아시스 카테고리는 모두 유효한 슬롯을 가리킨다', () => {
  for (const c of OASIS_CATEGORIES) {
    assert.ok(SLOTS.includes(c.slot), `${c.label}(${c.id}) 의 슬롯 ${c.slot} 이 SLOTS 에 없다`)
  }
})

test('오아시스 카테고리 ID는 중복되지 않는다', () => {
  const ids = OASIS_CATEGORIES.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('좁은 카테고리가 넓은 카테고리보다 앞에 온다 — 순서는 장식이 아니다', () => {
  const first = (slot) => OASIS_CATEGORIES.findIndex((c) => c.slot === slot)
  const last = (slot) => OASIS_CATEGORIES.findLastIndex((c) => c.slot === slot)
  for (const narrow of ['kimchi', 'soup', 'tofu']) {
    assert.ok(last(narrow) < first('banchan'), `${narrow} 가 banchan 뒤에 있다 — kimchi/tofu 슬롯이 빈다`)
  }
  assert.ok(last('banchan') < first('main'), 'banchan 이 main 뒤에 있다 — 간편식이 반찬을 채간다')
})
