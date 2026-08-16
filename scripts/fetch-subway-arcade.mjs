import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const INF_ID = 'OA-12927';
const INF_SEQ = 1;
const DATASET_URL = `https://data.seoul.go.kr/dataList/${INF_ID}/F/1/datasetView.do`;
const FILE_DOWN_URL = 'https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?useCache=false';

const OUT_DIR = path.resolve('subway-arcade');
const ARCADE_PATH = path.join(OUT_DIR, 'arcade.json');
const STATS_PATH = path.join(OUT_DIR, 'stats.json');
const META_PATH = path.join(OUT_DIR, 'meta.json');

const EXPECTED_HEADER = [
  '연번', '상가유형', '호선', '역명', '상가번호',
  '면적(제곱미터)', '영업업종', '계약시작일자', '계약종료일자',
  '월임대료', '사업진행단계',
];

async function fetchLatestFileMeta() {
  const res = await fetch(DATASET_URL);
  if (!res.ok) throw new Error(`dataset page HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  const rows = [];
  $('#fileDownList tbody tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 6) return;
    const filename = $(tds[2]).find('span').attr('title')?.trim();
    const onclick = $(tds[2]).find('span').attr('onclick') || '';
    const m = onclick.match(/downloadFile\(['"]?(\d+)['"]?\)/);
    const seq = m ? Number(m[1]) : null;
    const modified = $(tds[4]).text().trim();
    if (filename && seq != null) {
      rows.push({ filename, seq, modified });
    }
  });

  if (rows.length === 0) throw new Error('No files found on dataset page');

  // 1번 row가 항상 최신이지만, 안전망: csv 파일 + 파일명 날짜 기준 최대값
  const csvRows = rows.filter(r => r.filename.toLowerCase().endsWith('.csv'));
  if (csvRows.length === 0) throw new Error('No CSV files found');

  const dateOf = (r) => {
    const m = r.filename.match(/(\d{8})/);
    return m ? m[1] : '00000000';
  };
  csvRows.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  return csvRows[0];
}

async function downloadCsv(seq) {
  const body = new URLSearchParams({
    infId: INF_ID,
    infSeq: String(INF_SEQ),
    seq: String(seq),
  });
  const res = await fetch(FILE_DOWN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`file download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // cp949 → utf-8
  const decoder = new TextDecoder('euc-kr');
  return decoder.decode(buf);
}

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
      else if (c === '\r') {/* skip */}
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function normalizeStation(name) {
  // "서울(1)역" → "서울역", "오목교역" → "오목교역"
  return name.replace(/\(\d+\)/g, '').trim();
}

function normalizeRows(table) {
  const [header, ...body] = table;
  for (let i = 0; i < EXPECTED_HEADER.length; i++) {
    if ((header[i] || '').trim() !== EXPECTED_HEADER[i]) {
      throw new Error(`Schema mismatch at col ${i}: expected "${EXPECTED_HEADER[i]}", got "${header[i]}"`);
    }
  }
  return body
    .filter(r => r.length >= EXPECTED_HEADER.length && r[0].trim())
    .map(r => ({
      no: Number(r[0]),
      type: r[1].trim(),
      line: r[2].trim(),
      station: normalizeStation(r[3]),
      stationRaw: r[3].trim(),
      shopNo: r[4].trim(),
      areaSqm: r[5] ? Number(r[5]) : null,
      business: r[6].trim() || null,
      contractStart: r[7].trim() || null,
      contractEnd: r[8].trim() || null,
      monthlyRent: r[9] ? Number(r[9]) : null,
      progressStep: r[10].trim() || null,
    }));
}

function buildStats(rows) {
  const operating = rows.filter(r => r.monthlyRent && r.monthlyRent > 0 && r.areaSqm);

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const round = (n) => Math.round(n);

  const byLine = {};
  for (const r of operating) {
    (byLine[r.line] ||= []).push(r);
  }
  const lineStats = Object.fromEntries(
    Object.entries(byLine).map(([line, items]) => [line, {
      count: items.length,
      avgRent: round(avg(items.map(i => i.monthlyRent))),
      avgRentPerSqm: round(avg(items.map(i => i.monthlyRent / i.areaSqm))),
    }])
  );

  const byBusiness = {};
  for (const r of operating) {
    if (!r.business) continue;
    (byBusiness[r.business] ||= []).push(r);
  }
  const businessStats = Object.fromEntries(
    Object.entries(byBusiness).map(([biz, items]) => [biz, {
      count: items.length,
      avgRent: round(avg(items.map(i => i.monthlyRent))),
      avgRentPerSqm: round(avg(items.map(i => i.monthlyRent / i.areaSqm))),
    }])
  );

  const typeCount = {};
  for (const r of rows) typeCount[r.type] = (typeCount[r.type] || 0) + 1;

  return {
    total: rows.length,
    operatingCount: operating.length,
    vacantCount: rows.filter(r => r.type === '공실').length,
    biddingCount: rows.filter(r => r.type === '입찰진행').length,
    typeCount,
    lineStats,
    businessStats,
  };
}

async function readMeta() {
  try {
    return JSON.parse(await fs.readFile(META_PATH, 'utf-8'));
  } catch { return null; }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const meta = await fetchLatestFileMeta();
  console.log(`Latest file: ${meta.filename} (seq=${meta.seq}, modified=${meta.modified})`);

  const prev = await readMeta();
  if (prev && prev.seq === meta.seq && prev.modified === meta.modified) {
    console.log('No changes — skipping download.');
    return;
  }

  console.log('Change detected — downloading...');
  const csv = await downloadCsv(meta.seq);
  const table = parseCsv(csv);
  const rows = normalizeRows(table);
  console.log(`Parsed ${rows.length} rows.`);

  const stats = buildStats(rows);

  const newMeta = {
    filename: meta.filename,
    seq: meta.seq,
    modified: meta.modified,
    fetchedAt: new Date().toISOString(),
    sourceUrl: DATASET_URL,
    license: '공공누리 제3유형 (출처표시·변경금지)',
    provider: '서울교통공사',
    rowCount: rows.length,
  };

  await fs.writeFile(ARCADE_PATH, JSON.stringify(rows));
  await fs.writeFile(STATS_PATH, JSON.stringify(stats, null, 2));
  await fs.writeFile(META_PATH, JSON.stringify(newMeta, null, 2));

  const arcadeKB = (await fs.stat(ARCADE_PATH)).size / 1024;
  console.log(`wrote ${ARCADE_PATH} (${arcadeKB.toFixed(1)} KB)`);
  console.log(`wrote ${STATS_PATH}`);
  console.log(`wrote ${META_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
