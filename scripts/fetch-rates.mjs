#!/usr/bin/env node
// 금융감독원 금융상품통합비교공시 → rate-lens/rates.json
//
// rate-lens-mini(금리 돋보기) 앱이 raw URL 로 그대로 읽어간다.
// 공시는 매월 20일경 개시되지만 개별 금융회사의 정정 신고가 이후에도 매일 붙으므로
// 워크플로우는 매일 실행하고, 변경이 있을 때만 커밋한다.
//
// 로컬 실행:
//   FINLIFE_API_KEY=<key> node scripts/fetch-rates.mjs
//   FINLIFE_API_KEY=<key> node scripts/fetch-rates.mjs --dry-run

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { TARGETS, COMPANY_GROUPS, loadApiKey, fetchPage } from './finlife.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = resolve(ROOT, 'rate-lens/rates.json');
const MAX_PAGES = 20; // 안전장치. 실제로는 4페이지가 최대.

// ---------------------------------------------------------------------------
// 수집
// ---------------------------------------------------------------------------

async function collect(target, apiKey) {
  const baseList = [];
  const optionList = [];
  let maxPage = 1;
  let totalCount = null;

  for (let page = 1; page <= maxPage && page <= MAX_PAGES; page += 1) {
    const result = await fetchPage(target.endpoint, target.topFinGrpNo, page, apiKey);
    maxPage = Number(result.max_page_no) || 1;
    totalCount = Number(result.total_count);
    baseList.push(...(result.baseList ?? []));
    optionList.push(...(result.optionList ?? []));
    console.error(
      `  ${target.endpoint} ${target.topFinGrpNo} p${page}/${maxPage} ` +
        `base=${result.baseList?.length ?? 0} opt=${result.optionList?.length ?? 0}`,
    );
  }

  return { baseList, optionList, maxPage, totalCount };
}

/**
 * 금융회사 개요를 fin_co_no 로 조회할 수 있게 모은다.
 *
 * 점포 지역이 특히 중요하다. 상품의 87%가 저축은행이고 대부분 지역 기반이라,
 * 대구 사는 사람에게 서울·부산에만 점포가 있는 저축은행을 1위로 보여주는 것은
 * 실질적으로 의미가 없다. 그 사실을 숨기지 않는다.
 */
async function collectCompanies(apiKey) {
  const byCode = new Map();
  for (const group of COMPANY_GROUPS) {
    const result = await fetchPage('companySearch', group, 1, apiKey);
    for (const b of result.baseList ?? []) {
      byCode.set(b.fin_co_no, {
        name: line(b.kor_co_nm) ?? '(회사명 없음)',
        url: text(b.homp_url),
        tel: text(b.cal_tel),
        areas: [],
      });
    }
    for (const o of result.optionList ?? []) {
      // exis_yn === 'Y' 인 지역에만 점포가 있다
      if (o.exis_yn !== 'Y') continue;
      const c = byCode.get(o.fin_co_no);
      const area = line(o.area_nm);
      if (c && area && !c.areas.includes(area)) c.areas.push(area);
    }
    console.error(`  companySearch ${group} → ${result.baseList?.length ?? 0}개사`);
  }
  return byCode;
}

// ---------------------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------------------

/** 장문 필드용. 개행을 보존한다 — spcl_cnd 의 개행은 우대조건 항목 구분자다. */
function text(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 한 줄 필드용(회사명·상품명). 공시 원본 상품명에도 생 개행이 섞여 들어온다
 * (예: "제주Dream\n정기예금\n(개인/만기\n지급식)"). 앱의 순위 리스트는 한 줄 렌더가 전제다.
 */
function line(value) {
  const t = text(value);
  return t === null ? null : t.replace(/\s+/g, ' ');
}

/**
 * 금리는 숫자여야 한다. 결측(null)과 0.0 은 의미가 완전히 다르므로 절대 섞지 않는다.
 * 0 으로 떨어뜨리면 "금리 0%인 상품"이 되어 순위가 조용히 오염된다.
 */
function rate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalize(collected, companyInfo) {
  const companies = [];
  const companyIndex = new Map();
  const products = [];
  const productIndex = new Map();
  const rates = [];
  const warnings = [];
  const dclsMonths = new Set();

  for (const { target, baseList, optionList } of collected) {
    for (const b of baseList) {
      const key = `${b.fin_co_no}:${b.fin_prdt_cd}:${target.type}`;
      if (productIndex.has(key)) {
        warnings.push(`중복 상품 키: ${key} (${b.kor_co_nm} ${b.fin_prdt_nm})`);
        continue;
      }
      const companyName = line(b.kor_co_nm) ?? '(회사명 없음)';
      if (!companyIndex.has(companyName)) {
        companyIndex.set(companyName, companies.length);
        // 회사 개요는 fin_co_no 로 조인한다. 회사명은 표기가 흔들릴 수 있다.
        const info = companyInfo.get(b.fin_co_no);
        if (!info) warnings.push(`회사 개요 없음: ${b.fin_co_no} ${companyName}`);
        companies.push({
          name: companyName,
          url: info?.url ?? null,
          tel: info?.tel ?? null,
          areas: info?.areas ?? [],
        });
      }
      if (b.dcls_month) dclsMonths.add(String(b.dcls_month));

      productIndex.set(key, products.length);
      products.push({
        co: b.fin_co_no,
        cd: b.fin_prdt_cd,
        type: target.type,
        group: target.group,
        company: companyIndex.get(companyName),
        name: line(b.fin_prdt_nm) ?? '(상품명 없음)',
        spclCnd: text(b.spcl_cnd),
        mtrtInt: text(b.mtrt_int),
        joinWay: text(b.join_way),
        joinMember: text(b.join_member),
        joinDeny: text(b.join_deny),
        maxLimit: b.max_limit === null || b.max_limit === undefined ? null : Number(b.max_limit),
        etcNote: text(b.etc_note),
      });
    }

    for (const o of optionList) {
      const key = `${o.fin_co_no}:${o.fin_prdt_cd}:${target.type}`;
      const pi = productIndex.get(key);
      if (pi === undefined) {
        warnings.push(`고아 금리행: ${key} ${o.save_trm}개월`);
        continue;
      }
      const term = Number(o.save_trm);
      if (!Number.isFinite(term)) {
        warnings.push(`save_trm 파싱 실패: ${key} "${o.save_trm}"`);
        continue;
      }
      const base = rate(o.intr_rate);
      if (base === null) warnings.push(`기본금리 결측: ${key} ${term}개월`);

      rates.push({
        p: pi,
        term,
        base, // intr_rate  — 우대조건을 하나도 안 채웠을 때 받는 금리
        top: rate(o.intr_rate2), // intr_rate2 — 우대조건을 전부 채워야 나오는 최고금리
        // 같은 (상품,기간)에 여러 행이 온다. 예금은 단리/복리, 적금은 정액/자유적립식.
        // 무손실로 전부 보존하고 대표행 선택은 앱에서 한다.
        intrType: text(o.intr_rate_type),
        rsrvType: text(o.rsrv_type),
      });
    }
  }

  if (dclsMonths.size !== 1) {
    warnings.push(`dcls_month가 섞여 있음: ${[...dclsMonths].join(', ')}`);
  }

  return {
    snapshot: {
      dclsMonth: [...dclsMonths].sort().pop() ?? null,
      generatedAt: new Date().toISOString(),
      source: '금융감독원 금융상품통합비교공시',
      sourceUrl: 'https://finlife.fss.or.kr',
      companies,
      products,
      rates,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------

function report(snapshot, collected, warnings) {
  const { products, rates } = snapshot;
  const count = (pred) => products.filter(pred).length;
  const lines = [];

  lines.push(`기준월: ${snapshot.dclsMonth}`);
  const withUrl = snapshot.companies.filter((c) => c.url).length;
  const withArea = snapshot.companies.filter((c) => c.areas.length > 0).length;
  lines.push(
    `회사 ${snapshot.companies.length} (홈페이지 ${withUrl} · 점포지역 ${withArea}) · ` +
      `상품 ${products.length} · 금리행 ${rates.length}`,
  );
  for (const { target, totalCount, baseList, maxPage } of collected) {
    const flag = baseList.length === totalCount ? '' : '  ← total_count 불일치!';
    lines.push(
      `  - ${target.type}/${target.group}: ${baseList.length}/${totalCount} (${maxPage}p)${flag}`,
    );
  }
  lines.push(
    `  예금 ${count((p) => p.type === 'deposit')} · 적금 ${count((p) => p.type === 'saving')} / ` +
      `은행 ${count((p) => p.group === 'bank')} · 저축은행 ${count((p) => p.group === 'savings')}`,
  );
  lines.push(`기본금리 결측 ${rates.filter((r) => r.base === null).length}행`);

  const json = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(json, 'utf-8');
  lines.push(`${(bytes / 1024).toFixed(1)}KB raw / ${(gzipSync(json).length / 1024).toFixed(1)}KB gzip`);

  if (warnings.length) {
    lines.push(`경고 ${warnings.length}건:`);
    for (const w of warnings.slice(0, 20)) lines.push(`  ! ${w}`);
    if (warnings.length > 20) lines.push(`  ... 외 ${warnings.length - 20}건`);
  } else {
    lines.push('경고 없음');
  }
  return lines.join('\n');
}

/** 수집이 명백히 망가졌을 때 정상 데이터를 덮어쓰지 않도록 막는다. */
function assertSane(snapshot, collected) {
  if (!snapshot.dclsMonth) throw new Error('dcls_month 를 찾지 못했습니다.');
  if (snapshot.products.length < 500) {
    throw new Error(`상품 수가 비정상적으로 적습니다: ${snapshot.products.length} (기대 700+)`);
  }
  if (snapshot.rates.length < 2000) {
    throw new Error(`금리행이 비정상적으로 적습니다: ${snapshot.rates.length} (기대 4000+)`);
  }
  // companySearch 가 조용히 실패하면 홈페이지·점포 지역이 통째로 비게 된다.
  const withUrl = snapshot.companies.filter((c) => c.url).length;
  if (withUrl < snapshot.companies.length * 0.9) {
    throw new Error(`회사 홈페이지 정보가 비정상적으로 적습니다: ${withUrl}/${snapshot.companies.length}`);
  }

  for (const { target, baseList, totalCount } of collected) {
    if (baseList.length !== totalCount) {
      throw new Error(
        `${target.endpoint}/${target.topFinGrpNo}: 수집 ${baseList.length} ≠ total_count ${totalCount}`,
      );
    }
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const apiKey = loadApiKey();

  console.error('금감원 finlife 수집 중...');
  const collected = [];
  for (const target of TARGETS) {
    collected.push({ target, ...(await collect(target, apiKey)) });
  }

  console.error('금융회사 개요 수집 중...');
  const companyInfo = await collectCompanies(apiKey);

  const { snapshot, warnings } = normalize(collected, companyInfo);
  console.log(report(snapshot, collected, warnings));
  assertSane(snapshot, collected);

  if (dryRun) {
    console.error('\n--dry-run: 파일을 쓰지 않았습니다.');
    return;
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(snapshot)}\n`, 'utf-8');
  console.error(`\n생성: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(`\n실패: ${err.message}`);
  process.exit(1);
});
