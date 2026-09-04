// 사용자가 제보한 동네 마트 전단.
//
// 공식 8곳(fetch-mart-flyer.mjs)과 **파일을 나눈다**. 저쪽은 매일 leaflets.json 을
// 통째로 다시 쓰기 때문에, 같은 파일에 넣으면 제보가 다음 실행에서 지워진다.
//
// 파이프라인:
//   구글폼 → 응답시트(responses, 이메일 포함·비공개)
//          → publish 탭(승인된 행만·이메일 제외) → 웹에 게시(CSV)  ← 여기서 읽는다
//          → Drive 이미지 다운로드 → sips 리사이즈 → community.json
//
// 🔑 사람이 시트에서 `approved` 체크박스를 켠 행만 publish 탭에 나타난다.
//    즉 **이 스크립트는 승인 여부를 판단하지 않는다** — 이미 걸러진 것만 본다.
//
// 🔑 행사 종료일이 지난 제보는 여기서 뺀다. 제보는 주간 갱신이 안 되므로
//    (스크래퍼와 달리 사람이 다시 올려야 한다) 만료를 안 하면 낡은 전단이 영영 남는다.
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// publish 탭만 게시한 CSV. 전체 문서가 아니라 이 탭이어야 응답자 이메일이 안 나간다.
const CSV_URL =
  process.env.COMMUNITY_CSV_URL ||
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTVyiSXRLtPtPzDquxIN4Ju6Kiajm2NQBEY_O6KPOGw2oKRcJ02iUsXOBfhcKkQKmwfceyw60QJKqMM/pub?gid=1989970789&single=true&output=csv";

const OUT_JSON = "mart-flyer/community.json";
const IMG_DIR = "mart-flyer/img/community";
const MAX_WIDTH = 1080; // 앱은 폭 390 논리픽셀 — 3배수면 충분하고 원본은 대개 그보다 크다
const MAX_PAGES = 10; // 폼의 파일 개수 상한과 같게

// 폼 드롭다운 라벨 → leaflets.json 의 region id. 폼 선택지가 17개 시도로 고정이라
// 자유 입력이 아니고, 그래서 이 표만 맞으면 어긋날 일이 없다.
const REGION_ID = {
  서울: "seoul", 경기: "gyeonggi", 인천: "incheon", 부산: "busan",
  대구: "daegu", 광주: "gwangju", 대전: "daejeon", 울산: "ulsan",
  세종: "sejong", 강원: "gangwon", 충북: "chungbuk", 충남: "chungnam",
  전북: "jeonbuk", 전남: "jeonnam", 경북: "gyeongbuk", 경남: "gyeongnam",
  제주: "jeju",
};

/**
 * RFC4180 CSV 파서.
 *
 * 직접 쓰는 이유: 제보 필드는 사람이 자유롭게 적는 값이라 마트 이름에 쉼표가
 * 들어올 수 있고("마트, 그 옆"), 구글은 그걸 따옴표로 감싸 내보낸다.
 * split(",") 로 자르면 그 순간 열이 밀린다.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } // "" → 리터럴 따옴표
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Drive 링크에서 파일 ID.
 * 폼 업로드 응답은 `https://drive.google.com/open?id=<ID>` 형태로 오지만,
 * 구글이 형식을 바꾼 전례가 있어 `/d/<ID>/` 형태도 함께 받는다.
 */
function driveFileId(url) {
  return (
    url.match(/[?&]id=([\w-]+)/)?.[1] ||
    url.match(/\/d\/([\w-]+)/)?.[1] ||
    null
  );
}

/**
 * YYYY-MM-DD 로 정규화.
 *
 * 🚨 게시된 CSV 의 날짜는 **숫자로 온다**(예: `46275`). 구글 시트는 날짜를
 *    1899-12-30 부터의 경과 일수로 저장하는데, QUERY() 결과 셀에는 표시 서식이
 *    없어서 원시 값이 그대로 나간다. 시트에서 눈으로 보면 멀쩡한 날짜라
 *    이걸 모르면 "승인했는데 아무 일도 안 일어난다"로만 보인다(2026-09-04 실제로 겪음).
 *
 * 문자열 형태(`2026-09-05`, `2026. 9. 5`)도 함께 받는다 — 시트 수식을 바꿔
 * TEXT() 로 감싸는 날이 와도 깨지지 않게.
 */
function toIsoDate(s) {
  const t = String(s ?? "").trim();
  if (!t) return null;

  // 시트 일련번호. 소수부(시각)는 버린다. 25569 = 1970-01-01 로 유닉스 epoch 로 옮긴다.
  if (/^\d+(\.\d+)?$/.test(t)) {
    const serial = Math.floor(Number(t));
    if (serial < 20000 || serial > 80000) return null; // 1954~2119 밖이면 날짜가 아니다
    return new Date((serial - 25569) * 86400000).toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** 파일명에 쓸 안전한 슬러그. 한글은 그대로 두면 URL·파일시스템에서 골치라 뺀다. */
function slug(s) {
  return (
    (s || "")
      .replace(/[^\w가-힣]+/g, "")
      .replace(/[가-힣]/g, "") // 한글 제거 후 남는 영숫자만
      .slice(0, 12)
      .toLowerCase() || "x"
  );
}

const kstToday = () =>
  new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function download(fileId, dest) {
  // uc?export=download 는 큰 파일에서 바이러스 검사 인터스티셜 HTML 을 준다.
  // usercontent 도메인이 그 단계를 건너뛴다(폼 업로드는 10MB 이하라 대개 무관하지만
  // 실패하면 이미지 대신 HTML 이 저장돼 조용히 깨진 카드가 된다).
  const url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const type = res.headers.get("content-type") || "";
  const buf = Buffer.from(await res.arrayBuffer());
  // 폴더가 비공개면 구글은 200 + 로그인 HTML 을 준다. 확장자만 믿으면 안 된다.
  if (!/^image\/|application\/pdf/.test(type)) {
    throw new Error(`이미지가 아님 (${type}) — Drive 폴더 공유 설정 확인`);
  }
  await fs.writeFile(dest, buf);
  return buf.length;
}

/**
 * 폭이 MAX_WIDTH 를 넘을 때만 줄인다. macOS 전용(self-hosted 맥).
 *
 * 🚨 `sips -Z` 는 폭이 아니라 **긴 변**을 맞춘다. 전단은 세로로 길어서
 *    -Z 1080 을 주면 높이가 1080 이 되고 폭은 740 으로 깎인다 — 전단 글씨가 뭉개진다.
 *    폭 기준으로 줄이려면 `--resampleWidth` 다.
 *
 * 🚨 **이미 작은 이미지는 건드리지 않는다.** 무조건 재인코딩하면 파일이 오히려 커진다
 *    (2026-09-04 실측: 151KB → 316KB). 커지면 되돌린다.
 */
async function shrink(file) {
  try {
    const { stdout } = await run("sips", ["-g", "pixelWidth", file], { timeout: 15000 });
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] || 0);
    if (!width || width <= MAX_WIDTH) return; // 충분히 작다 — 그대로 두는 게 최선이다

    const before = (await fs.stat(file)).size;
    const backup = `${file}.orig`;
    await fs.copyFile(file, backup);

    await run("sips", ["--resampleWidth", String(MAX_WIDTH), file], { timeout: 30000 });

    const after = (await fs.stat(file)).size;
    if (after >= before) await fs.rename(backup, file); // 줄어들지 않았으면 원본이 낫다
    else await fs.unlink(backup).catch(() => {});
  } catch {
    // 리사이즈 실패가 제보 전체를 막을 이유는 없다. 원본 크기로 남긴다.
    await fs.unlink(`${file}.orig`).catch(() => {});
  }
}

async function main() {
  console.log("CSV 읽는 중…");
  const res = await fetch(CSV_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`CSV HTTP ${res.status} — 게시가 풀렸는지 확인`);
  const rows = parseCsv(await res.text());

  const header = rows[0] || [];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  for (const need of ["timestamp", "mart", "region", "start_date", "end_date", "images"]) {
    if (idx[need] == null) throw new Error(`CSV 에 '${need}' 열이 없다 — publish 탭 수식 확인`);
  }

  await fs.mkdir(IMG_DIR, { recursive: true });

  const today = kstToday();
  const leaflets = [];
  let skippedExpired = 0;

  for (const row of rows.slice(1)) {
    if (!row.some((c) => c.trim())) continue; // 빈 줄

    const mart = (row[idx.mart] || "").trim();
    const regionName = (row[idx.region] || "").trim();
    const region = REGION_ID[regionName];
    const start = toIsoDate(row[idx.start_date]);
    const end = toIsoDate(row[idx.end_date]);
    const images = (row[idx.images] || "").split(",").map((s) => s.trim()).filter(Boolean);

    if (!mart || !region || !end || !images.length) {
      console.warn(`  건너뜀(필드 부족): ${mart || "(이름없음)"} / ${regionName}`);
      continue;
    }
    if (end < today) { skippedExpired++; continue; } // 행사 끝 → 자동으로 내려간다

    // id 는 제출 시각 + 이름에서 만든다. 같은 제보는 매번 같은 id 가 나와야
    // 이미지를 다시 받지 않고, 앱에서도 카드가 튀지 않는다.
    const stamp = (row[idx.timestamp] || "").replace(/\D/g, "").slice(2, 12) || "0";
    const id = `community-${stamp}-${slug(mart)}`;

    const pages = [];
    for (const [n, url] of images.slice(0, MAX_PAGES).entries()) {
      const fileId = driveFileId(url);
      if (!fileId) { console.warn(`  드라이브 링크 아님: ${url}`); continue; }

      const name = `${id}-${n + 1}.jpg`;
      // pages 에는 img/ 기준 상대경로를 넣는다 — 앱의 pageUrl() 이 접두만 붙이면 되게.
      const rel = `community/${name}`;
      const dest = path.join(IMG_DIR, name);
      if (existsSync(dest)) { pages.push(rel); continue; } // 이미 받은 건 건드리지 않는다

      try {
        const bytes = await download(fileId, dest);
        await shrink(dest);
        const after = (await fs.stat(dest)).size;
        console.log(`  ↓ ${name}  ${(bytes / 1024 | 0)}KB → ${(after / 1024 | 0)}KB`);
        pages.push(rel);
      } catch (e) {
        console.warn(`  ✗ ${name}: ${e.message}`);
      }
    }

    if (!pages.length) { console.warn(`  건너뜀(이미지 0): ${mart}`); continue; }

    leaflets.push({
      id,
      mart: "community", // 앱의 마트 칩(공식 8곳)과 섞이지 않게 별도 키
      store: mart,
      region,
      regionGrade: "exact", // 제보자가 그 점포를 직접 찍은 것이다
      community: true,
      period: { start: start || end, end },
      pages,
    });
  }

  // 종료일이 임박한 것부터. 마감이 가까운 전단이 더 급한 정보다.
  leaflets.sort((a, b) => a.period.end.localeCompare(b.period.end));

  const out = { updatedAt: new Date().toISOString(), leaflets };
  await fs.writeFile(OUT_JSON, JSON.stringify(out, null, 2) + "\n");

  console.log(`\n제보 전단 ${leaflets.length}건 (만료로 제외 ${skippedExpired}건)`);
  await pruneOrphans(leaflets);
}

/** community.json 에서 사라진(만료된) 전단의 이미지는 지운다 — 저장소가 계속 부풀지 않게. */
async function pruneOrphans(leaflets) {
  // pages 는 'community/xxx.jpg' 라 파일명만 떼어 비교한다.
  const keep = new Set(leaflets.flatMap((l) => l.pages).map((p) => path.basename(p)));
  let removed = 0;
  for (const f of await fs.readdir(IMG_DIR).catch(() => [])) {
    if (!keep.has(f)) { await fs.unlink(path.join(IMG_DIR, f)); removed++; }
  }
  if (removed) console.log(`만료 이미지 ${removed}개 삭제`);
}

main().catch((e) => {
  console.error("실패:", e.message);
  process.exit(1);
});
