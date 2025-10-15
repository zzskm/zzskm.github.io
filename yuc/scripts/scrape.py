
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os, sys, csv, logging, time, random
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = "https://park.yuc.co.kr"
XML_API = ROOT + "/usersite/userSiteParkingLotInfo?regionCd=&parkinglotDivisionCd=&_={ts}"

ARTIFACT_DIR = os.environ.get("ARTIFACT_DIR", "yuc/artifacts")
OUTPUT_CSV = os.environ.get("OUTPUT_CSV", "yuc/parking_log.csv")

os.makedirs(ARTIFACT_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "application/xml, text/xml, */*; q=0.01",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": ROOT + "/views/parkinglot/info/info.html",
    "Origin": ROOT,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-Requested-With": "XMLHttpRequest",
}

def build_session() -> requests.Session:
    s = requests.Session()
    retries = Retry(
        total=6,
        connect=6,
        read=6,
        status=3,
        backoff_factor=2.0,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["HEAD", "GET", "OPTIONS"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retries, pool_connections=2, pool_maxsize=2)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update(HEADERS)

    # Warm-up
    for path in ("/", "/views/parkinglot/info/info.html", "/views/parkinglot/info/info.js"):
        url = ROOT + path
        try:
            s.get(url, timeout=(20, 30))
            time.sleep(0.5)
        except Exception as e:
            logging.debug("워밍업 실패(무시): %s => %s", url, e)
    return s

def fetch_xml_text(session: requests.Session, attempt: int) -> str:
    ts = int(time.time() * 1000)
    url = XML_API.format(ts=ts)
    time.sleep(random.uniform(0.3, 0.8))
    timeout = (45, 60)
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    txt = r.text
    if txt.lstrip().startswith("<!DOCTYPE") or txt.lstrip().startswith("<html"):
        dump = os.path.join(ARTIFACT_DIR, f"non_xml_attempt{attempt}.html")
        with open(dump, "w", encoding="utf-8") as f:
            f.write(txt)
        raise ValueError("HTML 응답 감지(차단 가능성). non_xml_attempt*.html 확인")
    if not txt.lstrip().startswith("<"):
        dump = os.path.join(ARTIFACT_DIR, f"non_xml_attempt{attempt}.txt")
        with open(dump, "w", encoding="utf-8") as f:
            f.write(txt[:2000])
        raise ValueError("XML 형식이 아님. non_xml_attempt*.txt 확인")
    return txt

def parse_available(root: ET.Element) -> int:
    total = 0
    for rd in root.findall(".//resultData"):
        val = (rd.findtext("parkd_current_num") or "").strip()
        if val.isdigit():
            total += int(val)
    return total

def scrape():
    logging.info("스크랩 시작")
    session = build_session()
    last_err = None
    for attempt in range(1, 7):
        try:
            xml_text = fetch_xml_text(session, attempt)
            with open(os.path.join(ARTIFACT_DIR, f"raw_{attempt}.xml"), "w", encoding="utf-8") as f:
                f.write(xml_text)
            root = ET.fromstring(xml_text)
            avail = parse_available(root)
            KST = timezone(timedelta(hours=9))
            ts = datetime.now(KST)
            ts_str = ts.strftime("%Y-%m-%d %H:%M:%S%z")
            return ts_str, avail
        except Exception as e:
            last_err = e
            logging.warning("실패 (시도 %s): %s", attempt, e)
            time.sleep(min(90, (2 ** attempt) + random.uniform(0.5, 1.5)))
    logging.error("실패: 모든 재시도 실패")
    if last_err:
        raise last_err
    raise RuntimeError("모든 재시도 실패")

def main():
    try:
        ts_str, avail = scrape()
        is_new = not os.path.exists(OUTPUT_CSV)
        with open(OUTPUT_CSV, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if is_new:
                w.writerow(["timestamp_kst", "available_sum"])
            w.writerow([ts_str, avail])
        print(f"OK: {ts_str} available_sum={avail}")
    except Exception as e:
        with open(os.path.join(ARTIFACT_DIR, "last_error.txt"), "w", encoding="utf-8") as f:
            f.write(repr(e))
        logging.error("에러: %s", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
