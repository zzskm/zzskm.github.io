# -*- coding: utf-8 -*-
"""
수지노외 공영주차장 크롤러 (API 호출, 간결화)

개선 요약
- requests로 API 호출, XML 파싱
- 간단한 CSV 읽기/쓰기
- 최소 재시도 및 에러 처리
- 기본 로깅, 아티팩트 저장 간소화
"""

import csv, logging, re, requests, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
import xml.etree.ElementTree as ET

# 설정
KST = timezone(timedelta(hours=9))
API_URL = "https://park.yuc.co.kr/usersite/userSiteParkingLotInfo?regionCd=&parkinglotDivisionCd=&_={timestamp}"
LOT_NAME = "수지노외 공영주차장"
LOT_NAME_REGEX = r"수지\s*노외\s*공영\s*주차장"

BASE_DIR = Path(__file__).parent.parent
CSV_PATH = BASE_DIR / "parking_log.csv"
ARTIFACT_DIR = BASE_DIR / "artifacts"

RETRIES = 3
BACKOFF_BASE = 2.0

# 로깅
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("scrape")

# CSV 유틸
def setup_csv():
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(["timestamp_kst", "lot_name", "available"])

def get_last_row():
    if not CSV_PATH.exists():
        return None
    with CSV_PATH.open("r", encoding="utf-8") as f:
        lines = list(csv.reader(f))
        for line in reversed(lines):
            if len(line) >= 3:
                try:
                    return datetime.fromisoformat(line[0]), int(line[-1])
                except Exception:
                    continue
    return None

def append_csv(ts_str, lot_name, avail):
    with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow([ts_str, lot_name, avail])

# 아티팩트
def dump_artifact(xml_data, tag):
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    (ARTIFACT_DIR / f"xml_{tag}.xml").write_text(xml_data, encoding="utf-8")

# API 호출 및 파싱
def scrape_once(attempt):
    url = API_URL.format(timestamp=int(time.time() * 1000))
    logger.debug("API 호출: %s (시도 %d)", url, attempt)
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        xml_text = resp.text
        dump_artifact(xml_text, f"attempt{attempt}")

        root = ET.fromstring(xml_text)
        pattern = re.compile(LOT_NAME_REGEX, re.IGNORECASE)
        for data in root.findall(".//resultData"):
            name = data.find("park_name")
            if name is not None and pattern.search(name.text):
                cell_text = data.find("parkd_current_num").text.strip()
                if cell_text == "-":
                    return datetime.now(KST).isoformat(timespec="seconds"), 0
                num = re.search(r"\d+", cell_text.replace(",", ""))
                if num:
                    avail = int(num.group(0))
                    if avail < 0:
                        logger.warning("음수 값 보정: %d → 0", avail)
                        avail = 0
                    ts = datetime.now(KST).isoformat(timespec="seconds")
                    logger.info("%s available=%d at %s", LOT_NAME, avail, ts)
                    return ts, avail
        raise RuntimeError("주차장 데이터 없음")
    except Exception as e:
        logger.warning("실패 (시도 %d): %s", attempt, e)
        raise

# 스크랩
def scrape():
    for attempt in range(1, RETRIES + 1):
        try:
            return scrape_once(attempt)
        except Exception as e:
            if attempt == RETRIES:
                raise RuntimeError("모든 재시도 실패") from e
            time.sleep(BACKOFF_BASE * (2 ** (attempt - 1)))

# 메인
def main():
    logger.info("스크랩 시작")
    setup_csv()
    try:
        ts_str, avail = scrape()
        now = datetime.fromisoformat(ts_str)
        last = get_last_row()

        if last is None:
            append_csv(ts_str, LOT_NAME, avail)
            logger.info("%s available=%d (최초 기록)", LOT_NAME, avail)
        else:
            last_ts, last_avail = last
            if last_avail == avail and now.hour == last_ts.hour:
                logger.info("%s available=%d (동일 값 & 시간 → 생략)", LOT_NAME, avail)
            else:
                append_csv(ts_str, LOT_NAME, avail)
                logger.info("%s available=%d 기록", LOT_NAME, avail)
    except Exception as e:
        logger.error("실패: %s", e)
        sys.exit(1)
    logger.info("스크랩 완료")

if __name__ == "__main__":
    main()
