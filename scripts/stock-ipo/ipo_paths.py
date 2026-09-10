"""산출물 위치. 저장소 배치가 달라도 같은 스크립트를 쓰기 위해 한 곳에 모은다.

기본값은 이 허브의 배치(`{repo}/stock-ipo/`)이고, IPO_DATA_DIR 로 덮어쓸 수 있다.
"""
import os
from pathlib import Path

DATA_DIR = Path(
    os.environ.get('IPO_DATA_DIR')
    or Path(__file__).resolve().parents[2] / 'stock-ipo'
)

OUT = DATA_DIR / 'ipo.json'
# 상장 후 성적까지 담은 판. 「최근 성적」 탭이 있는 앱 버전부터 이걸 읽는다.
# 🚨 ipo.json 에 상장 건을 섞지 않으려고 파일을 나눴다 — 옛 앱 버전은 시세 붙은 건을
#    모르므로 청약 목록의 「청약 마감」 에 섞어 보여준다 (2026-09-11 · ipo_listed.legacy_items).
OUT_V2 = DATA_DIR / 'ipo-v2.json'
DOC_CACHE = DATA_DIR / 'doc_cache.json'
