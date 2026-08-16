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
DOC_CACHE = DATA_DIR / 'doc_cache.json'
