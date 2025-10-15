# yuc/scripts/scrape.py

import csv, logging, re, requests, time, os, pathlib, xml.etree.ElementTree as ET, sys
from datetime import datetime

ART_DIR = pathlib.Path("artifacts")
ART_DIR.mkdir(parents=True, exist_ok=True)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0 Safari/537.36"
)

BASE = "https://park.yuc.co.kr"
INFO_PAGE = f"{BASE}/views/parkinglot/info/info"
API_URL = f"{BASE}/usersite/userSiteParkingLotInfo"

def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": UA,
        "Accept": "application/xml,text/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "ko,en;q=0.8",
        "Connection": "keep-alive",
    })
    # Session warm-up
    try:
        s.get(BASE, timeout=10)
    except Exception:
        pass
    try:
        s.get(INFO_PAGE, timeout=10, headers={"Referer": BASE})
    except Exception:
        pass
    return s

def fetch_xml_text(session: requests.Session, attempt: int) -> str:
    ts = int(time.time() * 1000)
    params = {"regionCd": "", "parkinglotDivisionCd": "", "_": str(ts)}
    headers = {
        "Referer": INFO_PAGE,
        "X-Requested-With": "XMLHttpRequest",
    }
    r = session.get(API_URL, params=params, headers=headers, timeout=20)
    if not r.encoding:
        r.encoding = "utf-8"
    text = r.text.lstrip("\ufeff").strip()

    # Quick XML check
    if not text.startswith("<"):
        dump = ART_DIR / f"non_xml_attempt{attempt}.txt"
        dump.write_text(text, encoding="utf-8", errors="ignore")
        raise ValueError("서버 응답이 XML이 아님 (본문 덤프 저장됨)")

    # Save raw xml for debugging
    (ART_DIR / f"raw_attempt{attempt}.xml").write_text(text, encoding="utf-8", errors="ignore")
    return text

def parse_xml(text: str):
    cleaned = re.sub(r"^\s+", "", text)
    return ET.fromstring(cleaned)

def scrape_once(session: requests.Session, attempt: int):
    xml_text = fetch_xml_text(session, attempt)
    root = parse_xml(xml_text)
    ts = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    total_avail = 0
    for rd in root.findall(".//resultData"):
        val = rd.findtext("parkd_current_num") or "0"
        try:
            total_avail += int(val)
        except ValueError:
            pass
    return ts, total_avail

def scrape(max_retry: int = 3, delay_sec: int = 4):
    session = make_session()
    last_exc = None
    for attempt in range(1, max_retry + 1):
        try:
            return scrape_once(session, attempt)
        except Exception as e:
            logging.warning("실패 (시도 %d): %s", attempt, e)
            last_exc = e
            time.sleep(delay_sec)
    logging.error("실패: 모든 재시도 실패")
    raise RuntimeError("모든 재시도 실패") from last_exc

def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    logging.info("스크랩 시작")
    try:
        ts_str, avail = scrape()
        # Save CSV log
        with open("parking_log.csv", "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow([ts_str, avail])
        # Save success snapshot
        (ART_DIR / "last_success.txt").write_text(f"{ts_str}\t{avail}\n", encoding="utf-8")
    except Exception as e:
        # Save error snapshot
        (ART_DIR / "last_error.txt").write_text(str(e), encoding="utf-8")
        sys.exit(1)

if __name__ == "__main__":
    main()
