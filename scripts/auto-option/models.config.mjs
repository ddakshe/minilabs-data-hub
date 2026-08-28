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
 *   url          원본 가격표 PDF 주소. 받아서 캐시에 두고 파싱한다
 *   skip         굽지 않는다. 값은 **이유** — 왜 빠졌는지 모르면 나중에 못 고친다
 *   grid         격자를 손으로 지정(0-based). 자동 선택(가장 큰 격자)이 틀릴 때만
 *   dropTrims    잘못 잡힌 트림 이름
 *   dropOptions  잘못 잡힌 옵션 이름 (문자열 또는 정규식)
 *   renameTrims  { 원래이름: 바꿀이름 }
 *   fix(model)   마지막 수단. 위 항목으로 안 되는 것만
 */

/** 기아 가격표. 모델 슬러그만 갈아끼우면 된다. */
const kia = (s) => `https://www.kia.com/content/dam/kwp/kr/ko/vehicles/pdf/price/price_${s}.pdf`;
/** 현대 가격표. 디렉터리 이름이 catalog 지만 -price 로 끝나는 쪽이 가격표다. */
const hyundai = (s) => `https://www.hyundai.com/contents/repn-car/catalog/${s}-price.pdf`;

/** @type {Array<Record<string, unknown>>} */
export const MODELS = [
  // ── 기아 내연 ──────────────────────────────────────────────────
  { id: 'morning', label: '모닝', brand: '기아', parser: 'kia', url: kia('morning') },
  { id: 'ray', label: '레이', brand: '기아', parser: 'kia', url: kia('ray') },
  { id: 'seltos', label: '셀토스', brand: '기아', parser: 'kia', url: kia('seltos') },
  { id: 'k5', label: 'K5', brand: '기아', parser: 'kia', url: kia('k5') },
  { id: 'sportage', label: '스포티지', brand: '기아', parser: 'kia', url: kia('sportage') },
  {
    id: 'k8',
    label: 'K8',
    brand: '기아',
    parser: 'kia',
    url: kia('k8'),
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
  { id: 'sorento', label: '쏘렌토', brand: '기아', parser: 'kia', url: kia('sorento') },
  { id: 'tasman', label: '타스만', brand: '기아', parser: 'kia', url: kia('tasman') },
  { id: 'k9', label: 'K9', brand: '기아', parser: 'kia', url: kia('k9') },
  {
    id: 'bongo3',
    label: '봉고3',
    brand: '기아',
    parser: 'kia',
    url: kia('bongo3'),
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
    url: kia('carnival'),
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
  { id: 'ev3', label: 'EV3', brand: '기아', parser: 'kia-ev', url: kia('ev3') },
  { id: 'ev4', label: 'EV4', brand: '기아', parser: 'kia-ev', url: kia('ev4') },
  { id: 'ev5', label: 'EV5', brand: '기아', parser: 'kia-ev', url: kia('ev5') },
  { id: 'ev6', label: 'EV6', brand: '기아', parser: 'kia-ev', url: kia('ev6') },
  { id: 'ev9', label: 'EV9', brand: '기아', parser: 'kia-ev', url: kia('ev9') },
  { id: 'niro', label: '니로', brand: '기아', parser: 'kia-ev', url: kia('niro') },

  // ── 현대 ──────────────────────────────────────────────────────
  // 격자를 발행하지 않고 트림별 목록만 발행해서, 파서가 격자를 역으로 세운다.
  { id: 'avante', label: '아반떼', brand: '현대', parser: 'hyundai', url: hyundai('avante') },
  { id: 'sonata', label: '쏘나타', brand: '현대', parser: 'hyundai', url: hyundai('sonata') },
  { id: 'grandeur', label: '그랜저', brand: '현대', parser: 'hyundai', url: hyundai('grandeur') },
  { id: 'venue', label: '베뉴', brand: '현대', parser: 'hyundai', url: hyundai('venue') },
  { id: 'kona', label: '코나', brand: '현대', parser: 'hyundai', url: hyundai('kona') },
  { id: 'tucson', label: '투싼', brand: '현대', parser: 'hyundai', url: hyundai('tucson') },
  { id: 'santafe', label: '싼타페', brand: '현대', parser: 'hyundai', url: hyundai('santafe') },
  { id: 'palisade', label: '팰리세이드', brand: '현대', parser: 'hyundai', url: hyundai('palisade') },
  { id: 'staria', label: '스타리아', brand: '현대', parser: 'hyundai', url: hyundai('staria') },
  { id: 'porter2', label: '포터2', brand: '현대', parser: 'hyundai', url: hyundai('porter2') },
  { id: 'ioniq5', label: '아이오닉5', brand: '현대', parser: 'hyundai', url: hyundai('ioniq5') },
  { id: 'ioniq6', label: '아이오닉6', brand: '현대', parser: 'hyundai', url: hyundai('ioniq6') },
  { id: 'ioniq9', label: '아이오닉9', brand: '현대', parser: 'hyundai', url: hyundai('ioniq9') },
];
