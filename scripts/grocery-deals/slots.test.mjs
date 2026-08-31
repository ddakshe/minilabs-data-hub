import test from 'node:test'
import assert from 'node:assert/strict'
import { SLOTS, slotForKurly, OASIS_CATEGORIES } from './slots.mjs'

/** 간편식 계열. 잡화라 맨 뒤에 와야 한다 */
const CONVENIENCE = [120, 57, 247, 53]

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

test('오아시스 카테고리는 유효한 슬롯이거나 배제(null)다', () => {
  for (const c of OASIS_CATEGORIES) {
    if (c.slot === null) continue
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

test('배제는 밥상 슬롯 뒤, 간편식·snack 앞에 온다', () => {
  const idx = (id) => OASIS_CATEGORIES.findIndex((c) => c.id === id)
  const firstDrop = OASIS_CATEGORIES.findIndex((c) => c.slot === null)
  const lastDrop = OASIS_CATEGORIES.findLastIndex((c) => c.slot === null)
  assert.ok(firstDrop > 0, '배제 카테고리가 없다')

  // 배제를 앞에 두면 채소 카테고리가 나물·두부를 먼저 채가서 tofu 가 30% 날아간다(실측).
  // 뒤에 두면 정상 반찬은 이미 확정된 뒤라 손실이 0 이다.
  const beforeDrop = OASIS_CATEGORIES.slice(0, firstDrop)
  for (const slot of ['kimchi', 'soup', 'tofu', 'banchan']) {
    assert.ok(
      beforeDrop.some((c) => c.slot === slot),
      `${slot} 카테고리가 배제보다 뒤에 있다 — 정상 반찬이 배제에 쓸려나간다`,
    )
    assert.ok(
      !OASIS_CATEGORIES.slice(lastDrop).some((c) => c.slot === slot),
      `${slot} 카테고리 일부가 배제 뒤에 남아 있다`,
    )
  }

  // 간편식은 잡화라 맨 뒤다. 배제·snack 이 먼저 걸러낸 뒤 남는 것만 가져간다.
  for (const id of CONVENIENCE) {
    assert.ok(idx(id) > lastDrop, `간편식 ${id} 이 배제보다 앞에 있다`)
  }
})

test('snack 이 간편식보다 먼저 온다 — 음료·시리얼을 밥상에서 걸러낸다', () => {
  const idx = (id) => OASIS_CATEGORIES.findIndex((c) => c.id === id)
  const lastSnack = OASIS_CATEGORIES.findLastIndex((c) => c.slot === 'snack')
  for (const id of CONVENIENCE) {
    assert.ok(idx(id) > lastSnack, `간편식 ${id} 이 snack 보다 앞에 있다 — 오트밀크·오곡라떼가 메인으로 온다`)
  }
})

test('완제품 단백질은 간편식보다 먼저 온다 — 소세지·떡갈비가 메인을 채운다', () => {
  const idx = (id) => OASIS_CATEGORIES.findIndex((c) => c.id === id)
  for (const protein of [17, 1195, 22, 43]) {
    for (const conv of CONVENIENCE) {
      assert.ok(idx(protein) < idx(conv), `완제품 ${protein} 이 간편식 ${conv} 보다 뒤에 있다`)
    }
  }
})
