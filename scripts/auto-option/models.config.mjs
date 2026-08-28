/**
 * 어떤 차종을 어떤 서식으로 굽고, 무엇을 예외로 손볼지.
 *
 * ⚠️ **차종별 예외는 파서가 아니라 여기에 쓴다.**
 *
 * 예전에 카니발의 잘못된 트림("9인승")을 parse-kia.mjs 의 정규식으로 걸렀다.
 * 카니발 하나 때문에 **기아 전 차종이 통과하는 코드**를 건드린 것이고, 언젠가
 * "9인승" 이 진짜 트림인 차가 오면 조용히 깨진다. 예외는 예외인 차종에만 붙어야 한다.
 *
 * 예외를 여기 모아 두면
 *   - 어느 차종에 무슨 손을 댔는지 한 곳에서 보이고
 *   - 그 손질이 다른 차종으로 번지지 않고
 *   - 새 서식이 필요한 차종이 생겨도 코드가 아니라 이 표만 늘어난다.
 *
 * ── 쓸 수 있는 항목 ──────────────────────────────────────────────
 *   parser       필수. 'kia' | 'kia-ev' | 'hyundai'
 *   brand,label  화면에 나갈 이름
 *   source       원본 후보. kia(...)/hyundai(...) 에 슬러그를 넘긴다.
 *                슬러그가 바뀐 차종은 옛 이름도 함께 넘긴다 — 최신 파일이 이긴다
 *   skip         굽지 않는다. 값은 **이유** — 왜 빠졌는지 모르면 나중에 못 고친다
 *   grid         격자를 손으로 지정(0-based). 자동 선택(가장 큰 격자)이 틀릴 때만
 *   dropTrims    잘못 잡힌 트림 이름
 *   dropOptions  잘못 잡힌 옵션 이름 (문자열 또는 정규식)
 *   renameTrims  { 원래이름: 바꿀이름 }
 *   fix(model)   마지막 수단. 위 항목으로 안 되는 것만
 */

/*
  ⚠️ 주소를 고정하지 않는다. 제조사가 연식마다 파일명을 바꾼다 —
  avante-price.pdf(2023) / avante-2026-price.pdf / venue-2027-price.pdf,
  게다가 슬러그까지 바뀐다(sonata → sonata-the-edge, ioniq5 → ioniq-5).

  한때 `<모델>-price.pdf` 로 고정했다가 **현대 13종이 2~4년 된 가격표**로 등록됐다.
  그랜저는 2022년 10월 파일이었다. 가격 계산기에서 3년 전 가격은 그냥 틀린 가격이다.

  그래서 후보를 전부 조회해 **Last-Modified 가 가장 최근인 것**을 고른다
  (resolve-sources.mjs). 연식 규칙을 코드가 추측하지 않으므로 내년에도 그대로 돈다.
*/

/**
 * 기아. 연식이 파일명에 안 들어간다(2026-08 기준).
 *
 * 기아는 정규 파일명(price_sportage.pdf)을 **계속 갱신**하고 구세대를 별도 이름으로
 * 남긴다(price_sportageql.pdf = 구형 스포티지, 2024-12). 그래서 정규 이름만 봐도
 * 현행이다 — 현대와 정반대다(현대는 신형에 새 이름을 만들고 옛 이름을 방치한다).
 *
 * 그래도 풀체인지 이름 후보를 함께 둔다. 현대에서 정확히 이 함정에 빠져 구형
 * 아반떼 가격을 서빙한 적이 있다. 옛 파일이 걸려도 최신이 이기므로 해롭지 않다.
 */
const kia = (...slugs) => ({
  base: 'https://www.kia.com/content/dam/kwp/kr/ko/vehicles/pdf/price',
  names: (s, y) =>
    y ? [] : [`price_${s}.pdf`, `price_the_new_${s}.pdf`, `price_the_all_new_${s}.pdf`],
  slugs,
});

/**
 * 현대. 파일명이 세 축으로 흩어져 있다.
 *
 *   접두어   (없음) / the-new- / the-all-new-
 *   연식     (없음) / -2027 / -2026 ...
 *   구분자   -price.pdf / **_price.pdf**
 *
 * 실제로 쓰이는 조합들:
 *   avante-2026-price.pdf          2026 아반떼 (연식변경)
 *   the-all-new-avante_price.pdf   디 올 뉴 아반떼 (풀체인지) ← 언더스코어
 *   the-new-staria_price.pdf       더 뉴 스타리아
 *   venue-2027-price.pdf
 *
 * 하이픈만 보다가 풀체인지 신형 아반떼를 통째로 놓치고 구형 가격을 서빙한 적이 있다.
 * 축을 하나라도 빼면 그런 일이 또 생긴다. 전부 조회해 최신을 고른다.
 */
const hyundai = (...slugs) => ({
  base: 'https://www.hyundai.com/contents/repn-car/catalog',
  names: (s, y) => {
    const stems = [s, `the-new-${s}`, `the-all-new-${s}`];
    const tail = y ? `-${y}` : '';
    return stems.flatMap((stem) => [`${stem}${tail}-price.pdf`, `${stem}${tail}_price.pdf`]);
  },
  slugs,
});

/** @type {Array<Record<string, unknown>>} */
export const MODELS = [
  // ── 기아 내연 ──────────────────────────────────────────────────
  { id: 'morning', label: '모닝', brand: '기아', parser: 'kia', source: kia('morning') },
  { id: 'ray', label: '레이', brand: '기아', parser: 'kia', source: kia('ray') },
  { id: 'seltos', label: '셀토스', brand: '기아', parser: 'kia', source: kia('seltos') },
  { id: 'k5', label: 'K5', brand: '기아', parser: 'kia', source: kia('k5') },
  { id: 'sportage', label: '스포티지', brand: '기아', parser: 'kia', source: kia('sportage') },
  {
    id: 'k8',
    label: 'K8',
    brand: '기아',
    parser: 'kia',
    source: kia('k8'),
    /*
      ⚠️ 알려진 한계 — 프레스티지(3,777만)가 빠진다. 격자 헤더가 103·259·415 줄뿐이고
      프레스티지 가격은 490 줄이라 그 뒤다. 490 이후 구간은 격자가 아니라
      "▶ 프레스티지 기본 품목 외" 형태의 **현대식 트림별 목록**이다.
      K8 가격표가 파워트레인마다 서식을 섞어 쓴다.

      격자 없이 프레스티지를 넣으면 모든 옵션이 '불가' 가 되어
      "프레스티지에선 아무것도 못 넣는다" 는 거짓이 된다. 넣지 않는다.
      제대로 하려면 한 PDF 안에서 두 서식을 함께 읽는 파서가 필요하다.
    */
  },
  { id: 'sorento', label: '쏘렌토', brand: '기아', parser: 'kia', source: kia('sorento') },
  { id: 'tasman', label: '타스만', brand: '기아', parser: 'kia', source: kia('tasman') },
  { id: 'k9', label: 'K9', brand: '기아', parser: 'kia', source: kia('k9') },
  {
    id: 'bongo3',
    label: '봉고3',
    brand: '기아',
    parser: 'kia',
    source: kia('bongo3'),
    /*
      상용 트럭이라 가격표에 적재함·축거별 표가 여러 개 얽혀 있고, 파서가 트림을
      "장    W    L", "축    D    GLS" 처럼 여러 칼럼을 붙여 읽는다. 격자 행 필터에
      걸려 최종 데이터에는 안 들어가지만, 남은 L/GL/GLS 의 기본가도 어느 축거의
      값인지 확인할 길이 없다. 옵션 계산기라는 이 앱의 성격과도 맞지 않는다.
    */
    skip: '상용 트럭. 축거·적재함별 표가 얽혀 트림 기본가를 신뢰할 수 없다',
  },

  {
    id: 'carnival',
    label: '카니발',
    brand: '기아',
    parser: 'kia',
    source: kia('carnival'),
    /*
      옵션 가격이 **트림 × 승차인원** 두 축에 걸려 있다. 같은 노블레스라도 9인승이면
      스타일 70만, 7인승이면 47만이다. 이 앱의 데이터 모델은 option.byTrim[트림] 하나뿐이라
      한 축밖에 못 담는다. 어느 쪽을 골라도 나머지 절반은 틀린 금액이 된다.

      "노블레스 9인승" 처럼 트림을 쪼개면 데이터 모델은 그대로 쓸 수 있다. 격자(287행)
      파싱도 가능하다 — 라벨이 두 행 사이에 걸쳐 있고("노블레스") 이름이 두 줄인 것도
      있지만("블랙"/"에디션") 위치로 풀린다.

      **막히는 건 기본가다.** PDF 전체에서 9인승·7인승이 금액과 함께 나오는 줄은 단
      두 개(4,592만 / 4,851만)이고, 그 격자가 속한 구간의 가격 줄은 하나뿐이다.
      격자에 있는 프레스티지·노블레스·시그니처·X-Line·블랙에디션 조합의 기본가가
      본문에 없다. 기본가 없이 격자만 넣으면 총액이 전부 틀린다.
      가격 계산기에서 틀린 금액을 넣는 건 그 차종을 빼는 것보다 나쁘다.
    */
    skip: '트림 × 승차인원 조합의 기본가가 PDF 본문에 없어 총액을 계산할 수 없다',
  },

  // ── 기아 전기 ──────────────────────────────────────────────────
  // 내연차와 가격표 서식이 다르다. 트림명이 왼쪽 칼럼에 세로로 쪼개져 있고 가격이 두 개다.
  { id: 'ev3', label: 'EV3', brand: '기아', parser: 'kia-ev', source: kia('ev3') },
  { id: 'ev4', label: 'EV4', brand: '기아', parser: 'kia-ev', source: kia('ev4') },
  { id: 'ev5', label: 'EV5', brand: '기아', parser: 'kia-ev', source: kia('ev5') },
  { id: 'ev6', label: 'EV6', brand: '기아', parser: 'kia-ev', source: kia('ev6') },
  { id: 'ev9', label: 'EV9', brand: '기아', parser: 'kia-ev', source: kia('ev9') },
  { id: 'niro', label: '니로', brand: '기아', parser: 'kia-ev', source: kia('niro') },

  // ── 현대 ──────────────────────────────────────────────────────
  // 격자를 발행하지 않고 트림별 목록만 발행해서, 파서가 격자를 역으로 세운다.
  { id: 'avante', label: '아반떼', brand: '현대', parser: 'hyundai', source: hyundai('avante') },
  { id: 'sonata', label: '쏘나타', brand: '현대', parser: 'hyundai', source: hyundai('sonata', 'sonata-the-edge') },
  { id: 'grandeur', label: '그랜저', brand: '현대', parser: 'hyundai', source: hyundai('grandeur') },
  { id: 'venue', label: '베뉴', brand: '현대', parser: 'hyundai', source: hyundai('venue') },
  { id: 'kona', label: '코나', brand: '현대', parser: 'hyundai', source: hyundai('kona') },
  { id: 'tucson', label: '투싼', brand: '현대', parser: 'hyundai', source: hyundai('tucson') },
  { id: 'santafe', label: '싼타페', brand: '현대', parser: 'hyundai', source: hyundai('santafe') },
  { id: 'palisade', label: '팰리세이드', brand: '현대', parser: 'hyundai', source: hyundai('palisade') },
  { id: 'staria', label: '스타리아', brand: '현대', parser: 'hyundai', source: hyundai('staria', 'staria-lounge') },
  { id: 'porter2', label: '포터2', brand: '현대', parser: 'hyundai', source: hyundai('porter2') },
  { id: 'ioniq5', label: '아이오닉5', brand: '현대', parser: 'hyundai', source: hyundai('ioniq5', 'ioniq-5') },
  { id: 'ioniq6', label: '아이오닉6', brand: '현대', parser: 'hyundai', source: hyundai('ioniq6', 'ioniq-6') },
  { id: 'ioniq9', label: '아이오닉9', brand: '현대', parser: 'hyundai', source: hyundai('ioniq9') },
];
