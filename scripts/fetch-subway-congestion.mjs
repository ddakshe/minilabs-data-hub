import fs from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.SEOUL_OPEN_API_KEY;
if (!KEY) {
  console.error('SEOUL_OPEN_API_KEY is not set');
  process.exit(1);
}

const SERVICE = 'subwConfusion';
const PAGE = 1000;

async function fetchPage(start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${KEY}/json/${SERVICE}/${start}/${end}/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const body = json[SERVICE];
  if (body?.RESULT?.CODE && body.RESULT.CODE !== 'INFO-000') {
    throw new Error(`${body.RESULT.CODE}: ${body.RESULT.MESSAGE}`);
  }
  return body;
}

const first = await fetchPage(1, PAGE);
const total = first.list_total_count;
console.log(`total rows: ${total}`);

const rows = [...first.row];
for (let start = PAGE + 1; start <= total; start += PAGE) {
  const end = Math.min(start + PAGE - 1, total);
  console.log(`fetching ${start}~${end}`);
  const page = await fetchPage(start, end);
  rows.push(...page.row);
}

console.log(`collected ${rows.length} rows`);

const outDir = path.resolve('subway-congestion');
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, 'congestion.json');
await fs.writeFile(outPath, JSON.stringify(rows));

const sizeKB = (await fs.stat(outPath)).size / 1024;
console.log(`wrote ${outPath} (${sizeKB.toFixed(1)} KB)`);
