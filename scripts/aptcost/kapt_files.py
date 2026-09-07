"""K-apt 자료실 엑셀 내려받기.

전국 관리비는 OpenAPI 로 긁으면 답이 안 나온다. 단지 22,298 곳 × 항목 × 개월을
단지코드 하나씩 불러야 하는데 개발계정 한도가 상세기능당 5,000/일이다.
반면 K-apt 자료실에는 **연도별 전체 관리비가 엑셀 한 장**으로 올라온다
(2018~2026, 주 1회 재추출). 그래서 벌크는 여기서 받고, OpenAPI 는 최신 달
증분용으로만 쓴다.

⚠️ 직접 URL 접근은 막혀 있다. `boardView.do?seq=...` 를 GET 하면
   "정상적인 접근이 아닙니다" 스크립트만 돌아온다. 목록 페이지에서 세션과
   CSRF 를 받고, 목록의 listForm 을 POST 로 흉내내야 게시글 컨텍스트가 선다.
   그 컨텍스트가 있어야 fileListData / fileDownload 가 200 을 준다.

⚠️ 첨부는 DEXT5 업로더 위젯이 감싸고 있어 평범한 <a href> 가 없다.
   파일 키는 게시글 안의 순번(1,2,…)이라 게시글 컨텍스트 없이는 의미가 없다.

흐름:
    1) GET  /web/board/webReference/boardList.do        세션 + _csrf
    2) POST /web/board/webReference/boardView.do        listForm (seq·boardType·scodeT·_csrf)
    3) POST /web/board/webReference/fileListData.do     → XML <seq><fileName>
    4) GET  /cmm/file/BOARD/fileDownload.do?key=&fileName=

자료실 탭(scodeT):
    01 기본정보 · 02 필지고유번호 · 03 관리비정보 · 04 면적정보 · 05 일반/기타
"""

from __future__ import annotations

import http.cookiejar
import json
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

BASE = "https://www.k-apt.go.kr"
LIST_URL = f"{BASE}/web/board/webReference/boardList.do"
VIEW_URL = f"{BASE}/web/board/webReference/boardView.do"
LIST_AJAX_URL = f"{BASE}/web/board/webReference/boardListAjax.do"
FILELIST_URL = f"{BASE}/web/board/webReference/fileListData.do?seq=BOARD_FILE"
DOWNLOAD_URL = f"{BASE}/cmm/file/BOARD/fileDownload.do"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)

# 자료실 게시글 seq. 연도별 파일은 seq 가 고정이고 첨부만 매주 재추출된다.
# (파일명 앞의 날짜가 추출일이라 매주 바뀐다 — 파일명으로 캐시하면 안 된다)
COST_SEQ_BY_YEAR = {
    2018: 4226, 2019: 4227, 2020: 4228, 2021: 4229,
    2022: 5144, 2023: 5145, 2024: 5146,
    2025: 123541, 2026: 129991,
}
BASIS_SEQ = 134925  # 단지 기본정보 (주 1회 새 게시글이 올라온다 — 아래 find_latest 로 찾는다)
AREA_SEQ = 20       # 단지 면적정보


@dataclass
class Attachment:
    board_seq: int
    key: int
    file_name: str


class KaptBoard:
    """자료실 세션 하나. 게시글을 열 때마다 컨텍스트가 갱신된다."""

    def __init__(self, timeout: int = 120):
        self._jar = http.cookiejar.CookieJar()
        self._op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self._jar)
        )
        self._op.addheaders = [("User-Agent", UA)]
        self._timeout = timeout
        self._csrf: str | None = None

    # -- 내부 --------------------------------------------------------------

    def _open(self, url: str, data: bytes | None = None, headers: dict | None = None):
        req = urllib.request.Request(url, data=data)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        return self._op.open(req, timeout=self._timeout)

    @staticmethod
    def _csrf_from(html: str) -> str | None:
        # 목록은 hidden input, 상세는 meta 태그로 준다.
        m = re.search(r'name="_csrf"\s+value="([^"]+)"', html) or re.search(
            r'name="_csrf"\s+content="([^"]+)"', html
        )
        return m.group(1) if m else None

    # -- 공개 --------------------------------------------------------------

    def start(self) -> None:
        """목록을 한 번 열어 세션과 CSRF 를 확보한다."""
        html = self._open(LIST_URL).read().decode("utf-8", "replace")
        self._csrf = self._csrf_from(html)
        if not self._csrf:
            raise RuntimeError("자료실 목록에서 _csrf 를 찾지 못했다 — 페이지 구조가 바뀌었을 수 있다")

    def open_post(self, seq: int, scode: str) -> str:
        """게시글을 POST 로 연다. 반환값은 상세 HTML."""
        if self._csrf is None:
            self.start()
        body = urllib.parse.urlencode(
            {
                "seq": str(seq),
                "boardSecret": "0",
                "boardType": "03",
                "pageNo": "1",
                "keyword": "",
                "board_pwd": "",
                "scodeT": scode,
                "_csrf": self._csrf,
            }
        ).encode()
        html = self._open(
            VIEW_URL,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded", "Referer": LIST_URL},
        ).read().decode("utf-8", "replace")
        # 상세 페이지가 새 토큰을 주면 그걸로 갈아탄다.
        self._csrf = self._csrf_from(html) or self._csrf
        return html

    def attachments(self, seq: int) -> list[Attachment]:
        """열어둔 게시글의 첨부 목록. open_post 를 먼저 부른 상태여야 한다."""
        payload = json.dumps(
            {
                "boardType": "03",
                "pageNo": "1",
                "stype": "",
                "keyword": "",
                "seq": str(seq),
                "scode": "03",
                "boardPwd": "",
                "_csrf": self._csrf,
            }
        ).encode()
        xml = self._open(
            FILELIST_URL,
            data=payload,
            headers={
                "Content-Type": "application/json;charset=UTF-8",
                "X-CSRF-TOKEN": self._csrf or "",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": LIST_URL,
            },
        ).read().decode("utf-8", "replace")
        if "<code>SCC</code>" not in xml:
            raise RuntimeError(f"첨부 목록 실패: {xml[:200]}")
        out = []
        for block in re.findall(r"<data>(.*?)</data>", xml, re.S):
            def pick(tag: str) -> str:
                m = re.search(rf"<{tag}>(.*?)</{tag}>", block, re.S)
                return (m.group(1) if m else "").strip()

            out.append(
                Attachment(
                    board_seq=int(pick("boardSeq") or seq),
                    key=int(pick("seq") or 1),
                    file_name=pick("fileName"),
                )
            )
        return out

    def download(self, att: Attachment, dest: Path) -> Path:
        """첨부 하나를 내려받는다. 2025년 관리비 파일이 65MB 라 스트리밍으로 쓴다."""
        url = (
            f"{DOWNLOAD_URL}?key={att.key}"
            f"&fileName={urllib.parse.quote(att.file_name)}"
            f"&_cb={att.board_seq}"
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        with self._open(url, headers={"Referer": LIST_URL}) as r, dest.open("wb") as f:
            ctype = r.headers.get("Content-Type", "")
            if "xml" in ctype or "html" in ctype:
                raise RuntimeError(f"파일 대신 오류 응답: {r.read()[:200]!r}")
            while chunk := r.read(1 << 20):
                f.write(chunk)
        return dest

    def fetch(self, seq: int, scode: str, out_dir: Path, tries: int = 3) -> list[Path]:
        """게시글 하나의 첨부를 전부 받는다.

        ⚠️ 게시글마다 목록을 다시 밟는다. 세션은 게시글 컨텍스트를 하나만 들고 있어서,
           한 파일을 받고 다음 게시글로 넘어가면 첨부 목록이 "잘못된 접근입니다" 를
           뱉는다(2018 을 받은 뒤 2019 에서 실측). start() 로 토큰을 새로 받으면 풀린다.
        """
        last = None
        for attempt in range(tries):
            try:
                self.start()
                self.open_post(seq, scode)
                paths = []
                for att in self.attachments(seq):
                    if not att.file_name:
                        continue
                    paths.append(self.download(att, out_dir / att.file_name))
                return paths
            except RuntimeError as e:  # 첨부 목록/다운로드가 오류 XML 을 준 경우
                last = e
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"seq={seq} 첨부 받기 실패: {last}")

    def find_latest_seq(self, scode: str) -> int:
        """탭에서 가장 최신 게시글 seq. 기본정보처럼 주마다 새 글이 올라오는 탭용.

        탭 전환은 페이지 이동이 아니라 boardListAjax.do 로 목록 조각만 갈아끼운다.
        (goList() 가 scodeT 값을 그대로 scode 로 넘긴다)
        """
        if self._csrf is None:
            self.start()
        body = urllib.parse.urlencode(
            {
                "scode": scode,
                "boardType": "03",
                "pageNo": "1",
                "stype": "",
                "keyword": "",
                "_csrf": self._csrf,
            }
        ).encode()
        html = self._open(
            LIST_AJAX_URL,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-CSRF-TOKEN": self._csrf or "",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": LIST_URL,
            },
        ).read().decode("utf-8", "replace")
        seqs = [int(s) for s in re.findall(r"goCheck\(\s*(\d+)\s*,", html)]
        if not seqs:
            raise RuntimeError(f"scode={scode} 목록에서 게시글을 찾지 못했다")
        return seqs[0]


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="K-apt 자료실 엑셀 내려받기")
    ap.add_argument("--out", default="_raw/aptcost", help="저장 디렉터리")
    ap.add_argument("--years", default="2025", help="관리비 연도 (쉼표, 'all' 가능)")
    ap.add_argument("--basis", action="store_true", help="단지 기본정보도 받는다")
    ap.add_argument("--area", action="store_true", help="단지 면적정보도 받는다")
    args = ap.parse_args()

    out = Path(args.out)
    b = KaptBoard()
    b.start()

    years = (
        sorted(COST_SEQ_BY_YEAR)
        if args.years == "all"
        else [int(y) for y in args.years.split(",") if y.strip()]
    )
    for y in years:
        seq = COST_SEQ_BY_YEAR[y]
        for p in b.fetch(seq, "03", out):
            print(f"  관리비 {y}: {p.name} ({p.stat().st_size:,} bytes)")

    if args.basis:
        seq = b.find_latest_seq("01")
        for p in b.fetch(seq, "01", out):
            print(f"  기본정보: {p.name} ({p.stat().st_size:,} bytes)")
    if args.area:
        for p in b.fetch(AREA_SEQ, "04", out):
            print(f"  면적정보: {p.name} ({p.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
