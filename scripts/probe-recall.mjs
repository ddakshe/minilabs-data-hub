/**
 * 소비자24 리콜 OpenAPI 접속 진단 — **수집하지 않는다. 되는지만 본다.**
 *
 * 왜 필요한가:
 * 이 API 키들은 신청 당시 등록한 IP(집 공인 IP, LG유플러스) 기준으로 발급됐다.
 * GitHub Actions 러너는 IP 가 고정되지 않는다. 문서에 IP 검증 언급은 없지만 확인된 건
 * 로컬 실행뿐이라(2026-08-15), 수집기를 다 만들고 나서 실패하면 원인 찾기가 번거롭다.
 * 그래서 러너에서 카테고리당 1건씩만 찔러보고 결과를 표로 남긴다.
 *
 * 러너의 공인 IP 도 함께 찍는다 — 실패했을 때 IP 문제인지 판정하려면 그 값이 있어야 한다.
 *
 * 키는 `RECALL_API_KEYS` 하나에 JSON 맵으로 넣는다. 카테고리마다 키가 달라 13개인데
 * GitHub secret 을 13개 만드는 것보다 낫다.
 *   {"0101":"...","0201":"...", ...}
 */

/* recall-mini 의 scripts/fetch-fixtures.mjs 와 같은 값이어야 한다 */
const ENDPOINT = 'https://www.consumer.go.kr/openapi/recall/contents/index.do';

/** MVP 대상 9개. 위생용품(5건)·축산물(1건)·먹는물(0건)·해외리콜은 앱에서 제외했다 */
const CATEGORIES = [
  { id: '0101', name: '공산품' },
  { id: '0201', name: '식품' },
  { id: '0204', name: '의약품' },
  { id: '0205', name: '의약외품' },
  { id: '0206', name: '화장품' },
  { id: '0207', name: '의료기기' },
  { id: '0301', name: '자동차' },
  { id: '0401', name: '생활화학제품' },
  { id: '0405', name: '생활방사선제품' },
];

function parseKeys() {
  const raw = process.env.RECALL_API_KEYS;
  if (!raw) {
    console.error('RECALL_API_KEYS 가 비어 있다. secret 을 설정할 것.');
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('RECALL_API_KEYS 가 JSON 이 아니다:', e.message);
    process.exit(1);
  }
}

/** 러너 공인 IP. 실패해도 진단을 멈추지 않는다 */
async function runnerIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(8000),
    });
    return (await res.json()).ip;
  } catch {
    return '(확인 실패)';
  }
}

async function probe(cat, key) {
  // cntPerPage=1 — 되는지만 보면 되므로 최소로 부른다
  const url =
    `${ENDPOINT}?serviceKey=${key}&pageNo=1&cntPerPage=1&cntntsId=${cat.id}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const xml = await res.text();

    const code = xml.match(/<code>(\d+)<\/code>/)?.[1] ?? '(없음)';
    const msg = xml.match(/<codeMsg>([\s\S]*?)<\/codeMsg>/)?.[1]?.trim() ?? '';
    const items = (xml.match(/<content>/g) ?? []).length;

    return {
      ...cat,
      http: res.status,
      code,
      msg,
      items,
      // code 00 이고 레코드가 실제로 왔을 때만 성공으로 친다.
      // 200 + code 00 인데 0건이면 뭔가 잘못된 것이다.
      ok: res.ok && code === '00' && items > 0,
      // 원인 판정용. 인증 실패 메시지는 대개 여기 드러난다
      head: xml.slice(0, 160).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return { ...cat, http: 0, code: 'ERR', msg: e.message, items: 0, ok: false, head: '' };
  }
}

const keys = parseKeys();
const ip = await runnerIp();

console.log(`러너 공인 IP: ${ip}`);
console.log(`신청 IP 와 다르면, 아래가 실패했을 때 IP 를 1순위로 의심할 것.\n`);

const results = [];
for (const cat of CATEGORIES) {
  const key = keys[cat.id];
  if (!key) {
    results.push({ ...cat, http: 0, code: 'NOKEY', msg: '키 없음', items: 0, ok: false, head: '' });
    continue;
  }
  results.push(await probe(cat, key));
}

console.log('카테고리        HTTP  code   건수  메시지');
console.log('─'.repeat(70));
for (const r of results) {
  const mark = r.ok ? '✅' : '❌';
  console.log(
    `${mark} ${r.name.padEnd(14)} ${String(r.http).padStart(4)}  ${r.code.padEnd(6)} ${String(r.items).padStart(4)}  ${r.msg.slice(0, 30)}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n성공 ${results.length - failed.length} / ${results.length}`);

if (failed.length) {
  console.log('\n실패 응답 앞부분 (원인 판정용):');
  for (const r of failed) console.log(`  [${r.name}] ${r.head || r.msg}`);
}

// GitHub Actions 요약 패널에도 남긴다
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  const lines = [
    '## 리콜 API 접속 진단',
    '',
    `- 러너 공인 IP: \`${ip}\``,
    `- 성공: **${results.length - failed.length} / ${results.length}**`,
    '',
    '| | 카테고리 | HTTP | code | 건수 | 메시지 |',
    '|---|---|---:|---|---:|---|',
    ...results.map(
      (r) =>
        `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.http} | \`${r.code}\` | ${r.items} | ${r.msg.slice(0, 40)} |`,
    ),
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

// 하나라도 실패하면 빨간 실행으로 남긴다 — 조용히 넘어가면 진단의 의미가 없다
process.exit(failed.length ? 1 : 0);
