// sports-scrapers.mjs — Sports ranking scrapers for 이세상 랭킹
//
// Usage:
//   node scripts/sources/sports-scrapers.mjs          # self-test
//
// Each export returns an array of:
//   { rank, prev, name, value, detail, flag, highlight? }

import * as cheerio from 'cheerio'

// ───────────────────────── helpers ─────────────────────────

const WIKI_UA = 'minilabs-data-hub/1.0 (+https://github.com/ddakshe/minilabs-data-hub)'

async function fetchWikiHtml(page, section) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=text&section=${section}&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } })
  if (!res.ok) throw new Error(`Wikipedia API HTTP ${res.status}: ${page}`)
  const json = await res.json()
  if (json.error) throw new Error(`Wikipedia: ${json.error.info}`)
  return cheerio.load(json.parse.text['*'])
}

/** Fetch section list for a Wikipedia page, return array of { index, line, level } */
async function fetchWikiSections(page) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=sections&format=json`
  const res = await fetch(url, { headers: { 'User-Agent': WIKI_UA } })
  if (!res.ok) throw new Error(`Wikipedia sections API HTTP ${res.status}: ${page}`)
  const json = await res.json()
  if (json.error) throw new Error(`Wikipedia: ${json.error.info}`)
  return json.parse.sections
}

/** Find section index by matching title (case-insensitive substring) */
async function findSection(page, ...titlePatterns) {
  const sections = await fetchWikiSections(page)
  for (const pattern of titlePatterns) {
    const lower = pattern.toLowerCase()
    const found = sections.find((s) => s.line.toLowerCase().includes(lower))
    if (found) return Number(found.index)
  }
  return null
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌐'
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}

const COUNTRY_KR = {
  US: '미국', CN: '중국', JP: '일본', DE: '독일', IN: '인도',
  GB: '영국', FR: '프랑스', IT: '이탈리아', CA: '캐나다', BR: '브라질',
  RU: '러시아', KR: '대한민국', AU: '호주', ES: '스페인', MX: '멕시코',
  NL: '네덜란드', NO: '노르웨이', SE: '스웨덴', AT: '오스트리아',
  PL: '폴란드', RS: '세르비아', BG: '불가리아', CH: '스위스',
  DK: '덴마크', CZ: '체코', RO: '루마니아', HR: '크로아티아',
  BE: '벨기에', PT: '포르투갈', AR: '아르헨티나', CO: '콜롬비아',
  UY: '우루과이', CL: '칠레', EC: '에쿠아도르', PE: '페루',
  MA: '모로코', SN: '세네갈', NG: '나이지리아', CM: '카메룬',
  EG: '이집트', DZ: '알제리', GH: '가나', CI: '코트디부아르',
  TN: '튀니지', IR: '이란', SA: '사우디아라비아', QA: '카타르',
  NZ: '뉴질랜드', MC: '모나코', BY: '벨라루스', KZ: '카자흐스탄',
  GE: '조지아', FI: '핀란드', TR: '튀르키예', IE: '아일랜드',
  HU: '헝가리', UA: '우크라이나', GR: '그리스', IL: '이스라엘',
  TH: '태국', PH: '필리핀', ZA: '남아공', KE: '케냐', ET: '에티오피아',
  JM: '자메이카', PY: '파라과이', BO: '볼리비아', VE: '베네수엘라',
  CU: '쿠바', PA: '파나마', CR: '코스타리카', HN: '온두라스',
  GT: '과테말라', SV: '엘살바도르', DO: '도미니카공화국',
  HT: '아이티', NI: '니카라과', TT: '트리니다드토바고',
  SG: '싱가포르', MY: '말레이시아', ID: '인도네시아', VN: '베트남',
  PK: '파키스탄', BD: '방글라데시', LK: '스리랑카', MM: '미얀마',
  UZ: '우즈베키스탄', AZ: '아제르바이잔', AM: '아르메니아',
  AF: '아프가니스탄', IQ: '이라크', SY: '시리아', LB: '레바논',
  JO: '요르단', KW: '쿠웨이트', BH: '바레인', OM: '오만',
  YE: '예멘', LY: '리비아', SD: '수단', AO: '앙골라',
  MZ: '모잠비크', MG: '마다가스카르', CD: '콩고민주', TZ: '탄자니아',
  SK: '슬로바키아', SI: '슬로베니아', LT: '리투아니아', LV: '라트비아',
  EE: '에스토니아', BA: '보스니아', AL: '알바니아', MK: '북마케도니아',
  ME: '몬테네그로', IS: '아이슬란드', MT: '몰타', CY: '키프로스',
  LU: '룩셈부르크', SC: '스코틀랜드', WLS: 'W', NIR: 'N',
}

function krName(code, fallback) { return COUNTRY_KR[code] || fallback }

// Nationality adjective → ISO2
const NATIONALITY_TO_ISO2 = {
  Italian: 'IT', British: 'GB', German: 'DE', Dutch: 'NL',
  Spanish: 'ES', French: 'FR', Monegasque: 'MC', Australian: 'AU',
  Finnish: 'FI', Mexican: 'MX', Canadian: 'CA', Japanese: 'JP',
  Thai: 'TH', 'New Zealander': 'NZ', Danish: 'DK', Swiss: 'CH',
  Polish: 'PL', Russian: 'RU', Brazilian: 'BR', Argentine: 'AR',
  American: 'US', Chinese: 'CN', Swedish: 'SE', Austrian: 'AT',
  Serbian: 'RS', Bulgarian: 'BG', Norwegian: 'NO', Czech: 'CZ',
  Greek: 'GR', Belarusian: 'BY', Kazakh: 'KZ', Georgian: 'GE',
  Croatian: 'HR', Romanian: 'RO', Korean: 'KR', Indian: 'IN',
  Colombian: 'CO', Chilean: 'CL', Ecuadorian: 'EC', Peruvian: 'PE',
  Moroccan: 'MA', Senegalese: 'SN', Nigerian: 'NG', Cameroonian: 'CM',
  Tunisian: 'TN', Iranian: 'IR', Uzbek: 'UZ', Ukrainian: 'UA',
  Irish: 'IE', Portuguese: 'PT', Hungarian: 'HU', Slovak: 'SK',
  Slovenian: 'SI', Turkish: 'TR', Belgian: 'BE', South_African: 'ZA',
  'South African': 'ZA', Kenyan: 'KE', Ethiopian: 'ET', Jamaican: 'JM',
  Filipino: 'PH', Cuban: 'CU', Dominican: 'DO', Venezuelan: 'VE',
  Paraguayan: 'PY', Bolivian: 'BO', Uruguayan: 'UY', Panamanian: 'PA',
  Azerbaijani: 'AZ', Armenian: 'AM', Icelandic: 'IS',
}

// IOC code → ISO2
const IOC_TO_ISO2 = {
  USA: 'US', GER: 'DE', GBR: 'GB', FRA: 'FR', ITA: 'IT', NOR: 'NO',
  SWE: 'SE', JPN: 'JP', RUS: 'RU', AUS: 'AU', HUN: 'HU', KOR: 'KR',
  CAN: 'CA', BRA: 'BR', ESP: 'ES', NED: 'NL', SUI: 'CH', AUT: 'AT',
  POL: 'PL', CZE: 'CZ', BEL: 'BE', RSA: 'ZA', ETH: 'ET', KEN: 'KE',
  ARG: 'AR', MEX: 'MX', COL: 'CO', TUR: 'TR', UKR: 'UA', IND: 'IN',
  CHN: 'CN', DEN: 'DK', NZL: 'NZ', FIN: 'FI', IRI: 'IR', CRO: 'HR',
  ROU: 'RO', SRB: 'RS', POR: 'PT', GRE: 'GR', BLR: 'BY', NGR: 'NG',
  URU: 'UY', PAR: 'PY', CHI: 'CL', PER: 'PE', ECU: 'EC', MAR: 'MA',
  SEN: 'SN', CMR: 'CM', TUN: 'TN', ALG: 'DZ', GHA: 'GH', CIV: 'CI',
  EGY: 'EG', QAT: 'QA', KSA: 'SA', WAL: 'GB', SCO: 'GB', NIR: 'GB',
}

// English country name → ISO2 (for FIFA tables etc.)
const ENNAME_TO_ISO2 = {
  'United States': 'US', 'United Kingdom': 'GB', France: 'FR',
  Germany: 'DE', Italy: 'IT', Spain: 'ES', Netherlands: 'NL',
  Belgium: 'BE', Portugal: 'PT', Brazil: 'BR', Argentina: 'AR',
  Uruguay: 'UY', Colombia: 'CO', Mexico: 'MX', Japan: 'JP',
  'South Korea': 'KR', Australia: 'AU', Iran: 'IR', 'Saudi Arabia': 'SA',
  Croatia: 'HR', Morocco: 'MA', Switzerland: 'CH', Denmark: 'DK',
  Sweden: 'SE', Norway: 'NO', Austria: 'AT', Poland: 'PL',
  'Czech Republic': 'CZ', Romania: 'RO', Serbia: 'RS', Turkey: 'TR',
  Ukraine: 'UA', Russia: 'RU', England: 'GB', Scotland: 'GB',
  Wales: 'GB', 'Northern Ireland': 'GB', Ireland: 'IE',
  Canada: 'CA', Chile: 'CL', Ecuador: 'EC', Peru: 'PE',
  Paraguay: 'PY', Venezuela: 'VE', Bolivia: 'BO',
  China: 'CN', India: 'IN', Thailand: 'TH', Vietnam: 'VN',
  Indonesia: 'ID', Philippines: 'PH', Malaysia: 'MY',
  'New Zealand': 'NZ', 'South Africa': 'ZA', Nigeria: 'NG',
  Senegal: 'SN', Cameroon: 'CM', Ghana: 'GH', Egypt: 'EG',
  Algeria: 'DZ', Tunisia: 'TN', 'Ivory Coast': 'CI',
  "Côte d'Ivoire": 'CI', Kenya: 'KE', Ethiopia: 'ET',
  Hungary: 'HU', Greece: 'GR', Finland: 'FI', Iceland: 'IS',
  Qatar: 'QA', 'United Arab Emirates': 'AE', Israel: 'IL',
  Panama: 'PA', 'Costa Rica': 'CR', Honduras: 'HN', Jamaica: 'JM',
  'Trinidad and Tobago': 'TT', Cuba: 'CU', 'Dominican Republic': 'DO',
  Guatemala: 'GT', 'El Salvador': 'SV', Nicaragua: 'NI', Haiti: 'HT',
  Slovakia: 'SK', Slovenia: 'SI', 'Bosnia and Herzegovina': 'BA',
  Albania: 'AL', 'North Macedonia': 'MK', Montenegro: 'ME',
  Georgia: 'GE', Armenia: 'AM', Azerbaijan: 'AZ', Kazakhstan: 'KZ',
  Uzbekistan: 'UZ', Iraq: 'IQ', Syria: 'SY', Lebanon: 'LB',
  Jordan: 'JO', Oman: 'OM', Bahrain: 'BH', Kuwait: 'KW',
  'Sri Lanka': 'LK', Pakistan: 'PK', Bangladesh: 'BD',
  Singapore: 'SG', Luxembourg: 'LU', Malta: 'MT', Cyprus: 'CY',
  Lithuania: 'LT', Latvia: 'LV', Estonia: 'EE', Belarus: 'BY',
  Moldova: 'MD', Bulgaria: 'BG', Libya: 'LY', Sudan: 'SD',
  'DR Congo': 'CD', Tanzania: 'TZ', Uganda: 'UG', Angola: 'AO',
  Mozambique: 'MZ', Zimbabwe: 'ZW', Zambia: 'ZM', Congo: 'CG',
  Mali: 'ML', 'Burkina Faso': 'BF', Niger: 'NE', Guinea: 'GN',
  Benin: 'BJ', Togo: 'TG', 'Sierra Leone': 'SL', Liberia: 'LR',
  Gabon: 'GA', 'Equatorial Guinea': 'GQ', Madagascar: 'MG',
  Mauritania: 'MR', 'Cabo Verde': 'CV', 'Cape Verde': 'CV',
  Myanmar: 'MM', Cambodia: 'KH', Laos: 'LA', Nepal: 'NP',
  Tajikistan: 'TJ', Kyrgyzstan: 'KG', Turkmenistan: 'TM',
  Mongolia: 'MN', Afghanistan: 'AF',
}

/** Resolve a country name (possibly with IOC code in brackets) to ISO2 */
function resolveCountryISO2(name) {
  const clean = name.replace(/\s*\(.*?\)\s*/g, '').replace(/\[.*?\]/g, '').replace(/\*+/g, '').trim()
  // Try IOC code in brackets
  const iocMatch = name.match(/\(([A-Z]{3})\)/)
  if (iocMatch && IOC_TO_ISO2[iocMatch[1]]) return IOC_TO_ISO2[iocMatch[1]]
  // Try direct mapping
  if (ENNAME_TO_ISO2[clean]) return ENNAME_TO_ISO2[clean]
  // Try nationality
  if (NATIONALITY_TO_ISO2[clean]) return NATIONALITY_TO_ISO2[clean]
  return null
}

// ───────────────── Player name Korean translations ─────────────────

const PLAYER_KR = {
  // Tennis - Men
  'Jannik Sinner': '야닉 시너',
  'Carlos Alcaraz': '카를로스 알카라스',
  'Alexander Zverev': '알렉산더 즈베레프',
  'Novak Djokovic': '노바크 조코비치',
  'Daniil Medvedev': '다닐 메드베데프',
  'Taylor Fritz': '테일러 프리츠',
  'Casper Ruud': '카스페르 루드',
  'Alex de Minaur': '알렉스 데 미노르',
  'Andrey Rublev': '안드레이 루블레프',
  'Grigor Dimitrov': '그리고르 디미트로프',
  'Stefanos Tsitsipas': '스테파노스 치치파스',
  'Holger Rune': '홀거 루네',
  'Tommy Paul': '토미 폴',
  'Ben Shelton': '벤 셸튼',
  'Frances Tiafoe': '프랜시스 티아포',
  'Hubert Hurkacz': '후베르트 후르카츠',
  'Sebastian Korda': '세바스찬 코르다',
  'Lorenzo Musetti': '로렌초 무세티',
  'Felix Auger-Aliassime': '펠릭스 오제-알리아심',
  'Jack Draper': '잭 드레이퍼',
  // Tennis - Women
  'Iga Świątek': '이가 시비옹테크',
  'Aryna Sabalenka': '아리나 사발렌카',
  'Coco Gauff': '코코 가우프',
  'Elena Rybakina': '엘레나 리바키나',
  'Jessica Pegula': '제시카 페굴라',
  'Jasmine Paolini': '야스민 파올리니',
  'Qinwen Zheng': '정친원',
  'Barbora Krejčíková': '바르보라 크레이치코바',
  'Danielle Collins': '다니엘 콜린스',
  'Daria Kasatkina': '다리아 카사트키나',
  'Madison Keys': '매디슨 키스',
  'Mirra Andreeva': '미라 안드레예바',
  'Emma Navarro': '엠마 나바로',
  'Anna Kalinskaya': '안나 칼린스카야',
  'Donna Vekić': '도나 베키치',
  'Paula Badosa': '파울라 바도사',
  // Golf - Men
  'Scottie Scheffler': '스코티 셰플러',
  'Xander Schauffele': '잰더 쇼플리',
  'Rory McIlroy': '로리 매킬로이',
  'Collin Morikawa': '콜린 모리카와',
  'Ludvig Åberg': '루드비그 오베리',
  'Wyndham Clark': '윈덤 클라크',
  'Viktor Hovland': '빅토르 호블란',
  'Patrick Cantlay': '패트릭 캔틀레이',
  'Jon Rahm': '존 람',
  'Tommy Fleetwood': '토미 플릿우드',
  'Bryson DeChambeau': '브라이슨 디섐보',
  'Sahith Theegala': '사히스 티갈라',
  'Hideki Matsuyama': '마쓰야마 히데키',
  'Shane Lowry': '셰인 라우리',
  'Sungjae Im': '임성재',
  'Tom Kim': '김주형',
  'Si Woo Kim': '김시우',
  'Byeong Hun An': '안병훈',
  // Golf - Women
  'Nelly Korda': '넬리 코르다',
  'Lilia Vu': '릴리아 부',
  'Jin Young Ko': '고진영',
  'Sei Young Kim': '김세영',
  'Lydia Ko': '고리디아(리디아 고)',
  'Hyo Joo Kim': '김효주',
  'In Gee Chun': '전인지',
  'Minjee Lee': '이민지',
  'Amy Yang': '양희영',
  'Atthaya Thitikul': '아타야 티티쿤',
  'Celine Boutier': '셀린 부티에',
  'Charley Hull': '찰리 헐',
  'Rose Zhang': '로즈 장',
  'Jeeno Thitikul': '지노 티티쿤',
  'Ruoning Yin': '인루오닝',
  'Hannah Green': '한나 그린',
  // Chess
  'Magnus Carlsen': '마그누스 칼센',
  'Fabiano Caruana': '파비아노 카루아나',
  'Hikaru Nakamura': '히카루 나카무라',
  'Ding Liren': '딩리런',
  'Ian Nepomniachtchi': '이안 네폼니아치',
  'Alireza Firouzja': '알리레자 피루자',
  'Gukesh D': '구케시 D',
  'D. Gukesh': '구케시 D',
  'Anish Giri': '아니시 기리',
  'Wei Yi': '웨이이',
  'Viswanathan Anand': '비스와나탄 아난드',
  'Praggnanandhaa R': '프라그난난다 R',
  'R. Praggnanandhaa': '프라그난난다 R',
  'Nodirbek Abdusattorov': '노디르벡 압두사토로프',
  'Arjun Erigaisi': '아르준 에리가이시',
  // Boxing
  'Naoya Inoue': '이노우에 나오야',
  'Oleksandr Usyk': '올렉산드르 우시크',
  'Terence Crawford': '테렌스 크로퍼드',
  'Saul Alvarez': '사울 알바레스',
  'Canelo Alvarez': '카넬로 알바레스',
  'Dmitry Bivol': '드미트리 비볼',
  'Tyson Fury': '타이슨 퓨리',
  'Gervonta Davis': '저본타 데이비스',
  'Errol Spence Jr.': '에럴 스펜스 주니어',
  'Shakur Stevenson': '샤쿠르 스티븐슨',
  'Jesse Rodriguez': '제시 로드리게스',
  // UFC
  'Islam Makhachev': '이슬람 마카체프',
  'Alex Pereira': '알렉스 페레이라',
  'Jon Jones': '존 존스',
  'Leon Edwards': '리온 에드워즈',
  'Ilia Topuria': '일리아 토푸리아',
  'Alexander Volkanovski': '알렉산더 볼카노프스키',
  'Sean O\'Malley': '숀 오말리',
  'Dricus du Plessis': '드리커스 뒤 플레시',
  'Max Holloway': '맥스 할로웨이',
  'Charles Oliveira': '찰스 올리베이라',
  'Valentina Shevchenko': '발렌티나 셰브첸코',
  'Belal Muhammad': '벨랄 무하마드',
  'Tom Aspinall': '톰 아스피널',
  'Merab Dvalishvili': '메랍 드발리쉬빌리',
  'Demetrious Johnson': '드미트리어스 존슨',
  'Kamaru Usman': '카마루 우스만',
  // Marathon
  'Kelvin Kiptum': '켈빈 킵텀',
  'Eliud Kipchoge': '엘리우드 킵초게',
  'Kenenisa Bekele': '케네니사 베켈레',
  'Dennis Kimetto': '데니스 키메토',
  'Wilson Kipsang': '윌슨 킵상',
  'Patrick Makau': '패트릭 마카우',
  'Haile Gebrselassie': '하일레 게브르셀라시에',
  'Titus Ekiru': '티투스 에키루',
  'Birhanu Legese': '비르하누 레게세',
  'Mosinet Geremew': '모시네트 게레메우',
  'Sisay Lemma': '시사이 레마',
  'Sabastian Sawe': '세바스찬 사웨',
  'Benson Kipruto': '벤슨 킵루토',
  'John Korir': '존 코리르',
  'Abel Kipchumba': '아벨 킵춤바',
  'Deresa Geleta': '데레사 겔레타',
}

/** Try to translate a player name to Korean */
function playerKr(name) {
  if (!name) return name
  const clean = name.replace(/\s+/g, ' ').trim()
  return PLAYER_KR[clean] || clean
}

// Country name in Korean for FIFA teams
const FIFA_COUNTRY_KR = {
  Argentina: '아르헨티나', France: '프랑스', Brazil: '브라질',
  England: '잉글랜드', Belgium: '벨기에', Croatia: '크로아티아',
  Netherlands: '네덜란드', Portugal: '포르투갈', Italy: '이탈리아',
  Spain: '스페인', 'United States': '미국', Mexico: '멕시코',
  Morocco: '모로코', Switzerland: '스위스', Germany: '독일',
  Colombia: '콜롬비아', Uruguay: '우루과이', Denmark: '덴마크',
  Japan: '일본', Senegal: '세네갈', Iran: '이란', 'South Korea': '대한민국',
  Australia: '호주', Ukraine: '우크라이나', Nigeria: '나이지리아',
  Sweden: '스웨덴', Turkey: '튀르키예', Peru: '페루', Austria: '오스트리아',
  'Czech Republic': 'Czechia', Wales: '웨일스', Poland: '폴란드',
  Serbia: '세르비아', Hungary: '헝가리', Scotland: '스코틀랜드',
  Chile: '칠레', Ecuador: '에쿠아도르', Cameroon: '카메룬',
  Egypt: '이집트', Algeria: '알제리', Canada: '캐나다', Qatar: '카타르',
  Norway: '노르웨이', Romania: '루마니아', 'Costa Rica': '코스타리카',
  Paraguay: '파라과이', 'Saudi Arabia': '사우디아라비아',
  Ghana: '가나', 'Ivory Coast': '코트디부아르', "Côte d'Ivoire": '코트디부아르',
  Tunisia: '튀니지', Greece: '그리스', Ireland: '아일랜드',
  Slovenia: '슬로베니아', Slovakia: '슬로바키아',
  'North Macedonia': '북마케도니아', 'Bosnia and Herzegovina': '보스니아',
  Iceland: '아이슬란드', Albania: '알바니아', Montenegro: '몬테네그로',
  Finland: '핀란드', 'Republic of Korea': '대한민국', Korea: '대한민국',
  'Korea Republic': '대한민국',
}

// ───────────────────────── FIFA Rankings ─────────────────────────

async function scrapeFootballTeam() {
  // 정확한 페이지: "FIFA Men's World Ranking" (Ranking 단수, apostrophe 직접)
  // sec0에 Top 20 테이블. Row0=공백, Row1=제목, Row2=header(Rank|Change|Team|Points), Row3~=data
  const $ = await fetchWikiHtml("FIFA Men's World Ranking", 0)
  const rows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 3) return // skip blank + title + header
    const cells = $(this).find('td, th')
    if (cells.length < 4) return
    const rank = parseInt($(cells[0]).text().trim())
    if (!rank || rank > 20) return
    const teamName = $(cells[2]).text().replace(/\[.*?\]/g, '').trim()
    const points = parseFloat($(cells[3]).text().replace(/,/g, '').trim()) || 0
    const iso2 = resolveCountryISO2(teamName)
    const nameKr = FIFA_COUNTRY_KR[teamName] || (iso2 ? krName(iso2, teamName) : teamName)
    rows.push({ rank, name: nameKr, enName: teamName, points, iso2 })
  })
  if (rows.length < 5) throw new Error('football-team: parsed fewer than 5 rows')
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank, prev: r.rank, name: r.name,
    value: r.points ? `${r.points.toFixed(2)}점` : '-',
    detail: `${r.enName}. FIFA 세계 랭킹. Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🌐',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

async function scrapeFootballWomen() {
  // 정확한 페이지: "FIFA Women's World Ranking" (Ranking 단수, apostrophe 직접)
  // sec0에 Top 20 테이블 있음. Cols: Rank(0)|Change(1)|Team(2)|Points(3)
  const $ = await fetchWikiHtml("FIFA Women's World Ranking", 0)
  const rows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 2) return // header + sub-header
    const cells = $(this).find('td, th')
    if (cells.length < 4) return
    const rank = parseInt($(cells[0]).text().trim())
    if (!rank || rank > 20) return
    const teamName = $(cells[2]).text().replace(/\[.*?\]/g, '').trim()
    const points = parseFloat($(cells[3]).text().replace(/,/g, '').trim()) || 0
    const iso2 = resolveCountryISO2(teamName)
    const nameKr = FIFA_COUNTRY_KR[teamName] || (iso2 ? krName(iso2, teamName) : teamName)
    rows.push({ rank, name: nameKr, enName: teamName, points, iso2 })
  })
  if (rows.length < 5) throw new Error('football-women: parsed fewer than 5 rows')
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank, prev: r.rank, name: r.name,
    value: r.points ? `${r.points.toFixed(2)}점` : '-',
    detail: `${r.enName}. FIFA 여자 세계 랭킹. Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🌐',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

// ───────────────────────── Tennis Rankings ─────────────────────────

/** Generic tennis ranking scraper for ATP/WTA Wikipedia pages */
async function scrapeTennisRanking(page, label) {
  // Try multiple possible section names
  const sec = await findSection(page, 'Current rankings', 'Current top 20', 'Current top 10',
    'Singles rankings', 'Singles', 'Rankings')
  if (sec == null) throw new Error(`${label}: could not find rankings section`)
  const $ = await fetchWikiHtml(page, sec)
  const rows = []

  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    const texts = []
    cells.each(function () { texts.push($(this).text().trim()) })

    let rank = null, playerName = null, points = null, country = null
    for (let j = 0; j < texts.length; j++) {
      const num = parseInt(texts[j])
      if (rank == null && num > 0 && num <= 500) { rank = num; continue }
      // Skip change column (arrows, +/-, numbers after rank)
      if (rank != null && playerName == null) {
        // Skip if it looks like a change indicator
        if (/^[0-9▲▼△▽=→←+\-–—]*$/.test(texts[j]) || texts[j] === '') continue
        // Could be a country name (short) before player name
        if (texts[j].length <= 3 && /^[A-Z]+$/.test(texts[j])) {
          country = texts[j]; continue
        }
        playerName = texts[j]; continue
      }
      if (rank != null && playerName != null && points == null) {
        const pval = parseInt(texts[j].replace(/,/g, ''))
        if (!isNaN(pval) && pval > 50) { points = pval; break }
      }
    }

    if (rank == null || !playerName) return
    playerName = playerName.replace(/\[.*?\]/g, '').replace(/\*+/g, '').trim()
    if (rank <= 20) {
      // Try to find nationality from flag img alt text
      let iso2 = null
      const flagImg = $(cells.eq(0)).parent().find('img[alt]').first()
      if (flagImg.length) {
        const alt = flagImg.attr('alt') || ''
        // ISO3 from flag filename or alt text
        const m3 = alt.match(/([A-Z]{3})/)
        if (m3 && IOC_TO_ISO2[m3[1]]) iso2 = IOC_TO_ISO2[m3[1]]
      }
      if (!iso2 && country) iso2 = IOC_TO_ISO2[country] || null

      rows.push({ rank, name: playerName, points, iso2, country })
    }
  })

  if (rows.length < 3) throw new Error(`${label}: parsed fewer than 3 rows`)
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank,
    prev: r.rank,
    name: playerKr(r.name),
    value: r.points ? `${r.points.toLocaleString('ko-KR')}점` : '-',
    detail: `${r.name}. ${label}. Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🌐',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

async function scrapeTennisRank() {
  return scrapeTennisRanking('ATP_rankings', 'ATP 남자 단식 랭킹')
}

async function scrapeTennisWomen() {
  return scrapeTennisRanking('WTA_rankings', 'WTA 여자 단식 랭킹')
}

// ───────────────────────── Golf Rankings ─────────────────────────

async function scrapeGolfRank() {
  const page = 'Official_World_Golf_Ranking'
  const sec = await findSection(page, 'Current top', 'Current ranking', 'Rankings')
  if (sec == null) throw new Error('golf-rank: could not find rankings section')
  const $ = await fetchWikiHtml(page, sec)
  const rows = []

  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    const texts = []
    cells.each(function () { texts.push($(this).text().trim()) })

    let rank = null, playerName = null, points = null, country = null
    for (let j = 0; j < texts.length; j++) {
      const num = parseInt(texts[j])
      if (rank == null && num > 0 && num <= 500) { rank = num; continue }
      if (rank != null && playerName == null) {
        if (/^[0-9▲▼△▽=→←+\-–—]*$/.test(texts[j]) || texts[j] === '') continue
        if (texts[j].length <= 3 && /^[A-Z]+$/.test(texts[j])) { country = texts[j]; continue }
        playerName = texts[j]; continue
      }
      if (rank != null && playerName != null && points == null) {
        const pval = parseFloat(texts[j].replace(/,/g, ''))
        if (!isNaN(pval) && pval > 0) { points = pval; break }
      }
    }

    if (rank == null || !playerName) return
    playerName = playerName.replace(/\[.*?\]/g, '').replace(/\*+/g, '').trim()
    if (rank <= 20) {
      let iso2 = null
      if (country) iso2 = IOC_TO_ISO2[country] || null
      // Detect nationality from the player row's flag image
      const flagImg = $(this).find('img[alt]').first()
      if (!iso2 && flagImg.length) {
        const alt = flagImg.attr('alt') || ''
        const m3 = alt.match(/([A-Z]{3})/)
        if (m3 && IOC_TO_ISO2[m3[1]]) iso2 = IOC_TO_ISO2[m3[1]]
      }
      // Korean player detection by name
      if (!iso2 && /\b(Im|Kim|Ko|An|Lee|Yang|Choi|Park|Kang|Bae)\b/.test(playerName)) {
        iso2 = 'KR'
      }

      rows.push({ rank, name: playerName, points, iso2, country })
    }
  })

  if (rows.length < 3) throw new Error('golf-rank: parsed fewer than 3 rows')
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank,
    prev: r.rank,
    name: playerKr(r.name),
    value: r.points ? `${r.points.toFixed(2)}점` : '-',
    detail: `${r.name}. 공식 세계 골프 랭킹(OWGR). Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🌐',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

async function scrapeGolfWomen() {
  // 정확한 페이지: "Women's World Golf Rankings", sec6 = "Current top ten"
  // Cols: Rank(0)|Change(1)|Player(2)|Country(3)|Points(4)
  const $ = await fetchWikiHtml("Women's World Golf Rankings", 6)
  const rows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 5) return
    const rank = parseInt($(cells[0]).text().trim())
    if (!rank || rank > 20) return
    const player = $(cells[2]).text().replace(/\[.*?\]/g, '').trim()
    const country = $(cells[3]).text().replace(/\[.*?\]/g, '').trim()
    const points = parseFloat($(cells[4]).text().trim()) || 0
    const iso2 = resolveCountryISO2(country)
    rows.push({ rank, name: player, points, iso2, country })
  })
  if (rows.length < 3) throw new Error('golf-women: parsed fewer than 3 rows')
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank, prev: r.rank,
    name: playerKr(r.name),
    value: r.points ? `${r.points.toFixed(2)}점` : '-',
    detail: `${r.name} (${r.country}). 여자 세계 골프 랭킹. Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🌐',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

// ───────────────────────── Chess Rankings ─────────────────────────

async function scrapeChess() {
  const page = 'FIDE_world_rankings'
  const sec = await findSection(page, 'Top players', 'Current top', 'Current ranking',
    'Open', 'Rankings', 'Top rated')
  if (sec == null) throw new Error('chess: could not find rankings section')
  const $ = await fetchWikiHtml(page, sec)
  const rows = []

  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 3) return

    const texts = []
    cells.each(function () { texts.push($(this).text().trim()) })

    let rank = null, playerName = null, rating = null, country = null
    for (let j = 0; j < texts.length; j++) {
      const num = parseInt(texts[j])
      if (rank == null && num > 0 && num <= 100) { rank = num; continue }
      if (rank != null && playerName == null) {
        if (/^[0-9▲▼△▽=→←+\-–—]*$/.test(texts[j]) || texts[j] === '') continue
        if (texts[j].length <= 3 && /^[A-Z]+$/.test(texts[j])) { country = texts[j]; continue }
        // Skip if it's clearly a rating (2600-2900 range)
        if (/^2[6-9]\d\d$/.test(texts[j])) { rating = parseInt(texts[j]); continue }
        playerName = texts[j]; continue
      }
      if (rank != null && playerName != null && rating == null) {
        const rval = parseInt(texts[j].replace(/,/g, ''))
        if (!isNaN(rval) && rval >= 2500 && rval <= 3000) { rating = rval; break }
      }
    }

    if (rank == null || !playerName) return
    playerName = playerName.replace(/\[.*?\]/g, '').replace(/\*+/g, '').trim()
    if (rank <= 20) {
      let iso2 = null
      if (country) iso2 = IOC_TO_ISO2[country] || ENNAME_TO_ISO2[country] || null
      // Check flag image
      const flagImg = $(this).find('img[alt]').first()
      if (!iso2 && flagImg.length) {
        const alt = flagImg.attr('alt') || ''
        const m3 = alt.match(/([A-Z]{3})/)
        if (m3 && IOC_TO_ISO2[m3[1]]) iso2 = IOC_TO_ISO2[m3[1]]
      }

      rows.push({ rank, name: playerName, rating, iso2, country })
    }
  })

  if (rows.length < 3) throw new Error('chess: parsed fewer than 3 rows')
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank,
    prev: r.rank,
    name: playerKr(r.name),
    value: r.rating ? `${r.rating}점` : '-',
    detail: `${r.name}. FIDE 세계 체스 랭킹. Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🌐',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

// ───────────────────────── Marathon Records ─────────────────────────

async function scrapeMarathon() {
  const page = 'Marathon_world_record_progression'
  // Try section 0 first (intro might have the records table) or "Men" section
  const sec = await findSection(page, 'Men', 'Record progression', 'Records')
  // sec5 = "Men". Table: Time(0)|Name(1)|Nationality(2)|Date(3)|Event(4)|Source(5)
  // 기록 갱신 순이므로 마지막 행이 가장 빠름 → 역순으로 읽고 선수별 중복 제거
  const $ = await fetchWikiHtml(page, 5)
  const allRows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 5) return
    const time = $(cells[0]).text().replace(/\[.*?\]/g, '').trim()
    if (!/\d:\d{2}:\d{2}/.test(time)) return
    const name = $(cells[1]).text().replace(/\[.*?\]/g, '').trim()
    const nationality = $(cells[2]).text().replace(/\[.*?\]/g, '').trim()
    const date = $(cells[3]).text().replace(/\[.*?\]/g, '').trim()
    if (name) allRows.push({ time, name, nationality, date })
  })
  // 역순 (가장 빠른 기록 먼저), 선수별 중복 제거
  allRows.reverse()
  const seen = new Set()
  const unique = []
  for (const r of allRows) {
    if (!seen.has(r.name)) { seen.add(r.name); unique.push(r) }
    if (unique.length >= 10) break
  }
  if (unique.length < 3) throw new Error('marathon: parsed fewer than 3 rows')

  return unique.map((r, i) => {
    let iso2 = null
    if (r.nationality) {
      iso2 = ENNAME_TO_ISO2[r.nationality] || NATIONALITY_TO_ISO2[r.nationality] ||
             IOC_TO_ISO2[r.nationality] || null
    }
    return {
      rank: i + 1,
      prev: i + 1,
      name: playerKr(r.name),
      value: r.time,
      detail: `${r.name}. ${r.date || ''}. 마라톤 세계기록. Wikipedia 기준.`,
      flag: iso2 ? countryFlag(iso2) : '🌐',
      ...(iso2 === 'KR' && { highlight: true }),
    }
  })
}

// ───────────────────────── Boxing P4P ─────────────────────────

async function scrapeBoxingP4p() {
  // Try "The Ring magazine pound for pound" or similar
  const page = 'The_Ring_magazine_pound_for_pound'
  let sec = null
  try {
    sec = await findSection(page, 'Current ranking', 'Current list', 'Rankings')
  } catch {
    // If page doesn't exist, try alternative
  }

  let $
  if (sec != null) {
    $ = await fetchWikiHtml(page, sec)
  } else {
    // Try alternative pages
    const altPages = [
      'List_of_current_world_boxing_champions',
      'Boxing_pound_for_pound',
    ]
    for (const alt of altPages) {
      try {
        const altSec = await findSection(alt, 'pound for pound', 'P4P', 'Current', 'Rankings')
        if (altSec != null) {
          $ = await fetchWikiHtml(alt, altSec)
          break
        }
      } catch { /* try next */ }
    }
    if (!$) throw new Error('boxing-p4p: could not find any suitable Wikipedia page')
  }

  const rows = []
  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 2) return

    const texts = []
    cells.each(function () { texts.push($(this).text().trim()) })

    let rank = null, playerName = null, record = null, country = null
    for (let j = 0; j < texts.length; j++) {
      const num = parseInt(texts[j])
      if (rank == null && num > 0 && num <= 20) { rank = num; continue }
      if (rank != null && playerName == null) {
        if (/^[0-9▲▼△▽=→←+\-–—]*$/.test(texts[j]) || texts[j] === '') continue
        if (texts[j].length <= 3 && /^[A-Z]+$/.test(texts[j])) { country = texts[j]; continue }
        playerName = texts[j]; continue
      }
      // Record like "40-0" or "28-1 (20 KOs)"
      if (rank != null && playerName != null && !record) {
        if (/\d+[–\-]\d+/.test(texts[j])) {
          record = texts[j].replace(/\[.*?\]/g, '').trim()
          continue
        }
      }
    }

    if (rank == null || !playerName) return
    playerName = playerName.replace(/\[.*?\]/g, '').replace(/\*+/g, '').trim()
    if (rank <= 15) {
      let iso2 = null
      if (country) iso2 = IOC_TO_ISO2[country] || NATIONALITY_TO_ISO2[country] || null
      const flagImg = $(this).find('img[alt]').first()
      if (!iso2 && flagImg.length) {
        const alt = flagImg.attr('alt') || ''
        const m3 = alt.match(/([A-Z]{3})/)
        if (m3 && IOC_TO_ISO2[m3[1]]) iso2 = IOC_TO_ISO2[m3[1]]
      }
      rows.push({ rank, name: playerName, record, iso2, country })
    }
  })

  if (rows.length < 3) throw new Error('boxing-p4p: parsed fewer than 3 rows')
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank,
    prev: r.rank,
    name: playerKr(r.name),
    value: r.record || '-',
    detail: `${r.name}. 파운드 포 파운드 랭킹. The Ring / Wikipedia 기준.`,
    flag: r.iso2 ? countryFlag(r.iso2) : '🥊',
    ...(r.iso2 === 'KR' && { highlight: true }),
  }))
}

// ───────────────────────── UFC P4P ─────────────────────────

async function scrapeUfcP4p() {
  // 정확한 페이지: UFC_rankings (소문자 r), sec3 = "Men's pound-for-pound"
  // Cols: Rank(0)|ISO(1)|Fighter(2)|Record(3)|Win streak(4)|...|Weight class(6)
  const page = 'UFC_rankings'
  const sec = 3 // "Men's pound-for-pound"
  const $ = await fetchWikiHtml(page, sec)
  const rows = []

  // UFC Rankings page may have a simple ordered list or a table
  // Try table first
  $('table.wikitable tr').each(function (i) {
    if (i < 1) return
    const cells = $(this).find('td, th')
    if (cells.length < 2) return

    const texts = []
    cells.each(function () { texts.push($(this).text().trim()) })

    let rank = null, playerName = null, weightClass = null
    for (let j = 0; j < texts.length; j++) {
      const num = parseInt(texts[j])
      if (rank == null && num > 0 && num <= 20) { rank = num; continue }
      if (rank != null && playerName == null) {
        if (/^[0-9▲▼△▽=→←+\-–—]*$/.test(texts[j]) || texts[j] === '') continue
        playerName = texts[j]; continue
      }
      if (rank != null && playerName != null && !weightClass && texts[j]) {
        weightClass = texts[j]
      }
    }

    if (rank == null || !playerName) return
    playerName = playerName.replace(/\[.*?\]/g, '').replace(/\*+/g, '').replace(/\(c\)/gi, '').trim()
    if (rank <= 15) {
      rows.push({ rank, name: playerName, weightClass })
    }
  })

  // If no table rows found, try ordered list
  if (rows.length < 3) {
    let listRank = 0
    $('ol li, table.wikitable td').each(function () {
      const text = $(this).text().trim()
      if (!text) return
      // Try to extract name from list items
      const match = text.match(/^(?:(\d+)\.\s*)?(.+?)(?:\s*[-–]\s*(.+))?$/)
      if (match) {
        listRank++
        const name = (match[2] || '').replace(/\[.*?\]/g, '').replace(/\(c\)/gi, '').trim()
        if (name && listRank <= 15) {
          rows.push({ rank: listRank, name, weightClass: match[3] || null })
        }
      }
    })
  }

  if (rows.length < 3) throw new Error('ufc-p4p: parsed fewer than 3 rows')
  return rows.slice(0, 10).map((r) => ({
    rank: r.rank,
    prev: r.rank,
    name: playerKr(r.name),
    value: `#${r.rank}`,
    detail: `${r.name}${r.weightClass ? ` · ${r.weightClass}` : ''}. UFC 파운드 포 파운드 랭킹. Wikipedia 기준.`,
    flag: '🥋',
    ...(r.name.includes('Korean') && { highlight: true }),
  }))
}

// ───────────────────────── Exports ─────────────────────────

export {
  scrapeFootballTeam as footballTeam,
  scrapeFootballWomen as footballWomen,
  scrapeTennisRank as tennisRank,
  scrapeTennisWomen as tennisWomen,
  scrapeGolfRank as golfRank,
  scrapeGolfWomen as golfWomen,
  scrapeChess as chess,
  scrapeMarathon as marathon,
  scrapeBoxingP4p as boxingP4p,
  scrapeUfcP4p as ufcP4p,
}

// Map category IDs to scraper functions (for use with fetch-rankings.mjs pattern)
export const sportsScrapers = {
  'football-team': scrapeFootballTeam,
  'football-women': scrapeFootballWomen,
  'tennis-rank': scrapeTennisRank,
  'tennis-women': scrapeTennisWomen,
  'golf-rank': scrapeGolfRank,
  'golf-women': scrapeGolfWomen,
  chess: scrapeChess,
  marathon: scrapeMarathon,
  'boxing-p4p': scrapeBoxingP4p,
  'ufc-p4p': scrapeUfcP4p,
}

// ───────────────────────── self-test ─────────────────────────

async function selfTest() {
  console.log('=== Sports Scrapers Self-Test ===\n')

  const entries = Object.entries(sportsScrapers)
  let passed = 0
  let failed = 0

  for (const [id, fn] of entries) {
    try {
      const items = await fn()
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('returned empty or non-array')
      }
      // Validate schema
      for (const item of items) {
        if (typeof item.rank !== 'number') throw new Error(`rank not number: ${JSON.stringify(item)}`)
        if (typeof item.prev !== 'number') throw new Error(`prev not number: ${JSON.stringify(item)}`)
        if (typeof item.name !== 'string' || !item.name) throw new Error(`name empty: ${JSON.stringify(item)}`)
        if (typeof item.value !== 'string') throw new Error(`value not string: ${JSON.stringify(item)}`)
        if (typeof item.detail !== 'string') throw new Error(`detail not string: ${JSON.stringify(item)}`)
        if (typeof item.flag !== 'string') throw new Error(`flag not string: ${JSON.stringify(item)}`)
      }
      console.log(`  ✓ ${id} — ${items.length} items (1위: ${items[0].name} ${items[0].value})`)
      passed++
    } catch (err) {
      console.error(`  ✗ ${id} — ${err.message}`)
      failed++
    }
    // Rate limit: 500ms between Wikipedia requests
    await new Promise((r) => setTimeout(r, 600))
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed out of ${entries.length} ===`)
  if (failed > 0) process.exitCode = 1
}

// Run self-test if executed directly
const isMain = process.argv[1] && (
  process.argv[1].endsWith('sports-scrapers.mjs') ||
  process.argv[1].includes('sports-scrapers')
)
if (isMain) {
  selfTest().catch((e) => {
    console.error('\n✗ fatal:', e.message)
    process.exit(1)
  })
}
