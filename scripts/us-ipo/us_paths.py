"""출력 경로. 테스트에서 US_IPO_DATA_DIR 로 갈아끼울 수 있다."""
import os
import pathlib

DATA_DIR = pathlib.Path(
    os.environ.get('US_IPO_DATA_DIR')
    or pathlib.Path(__file__).resolve().parents[2] / 'us-ipo'
)
OUTPUT = DATA_DIR / 'ipo.json'
