#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os, sys, csv, logging, time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
import requests

TARGET_NAME = "수지노외 공영주차장"
OUT_PATH = "yuc/data.csv"
MAX_RETRY = 3
TIMEOUT = 20
KST = timezone(timedelta(hours=9))

def fetch_xml(session: requests.Session, url: str) -> str:
    headers = {"User-Agent": "Mozilla/5.0"}
    r = session.get(url, headers=headers, timeout=TIMEOUT)
    r.raise_for_status()
    return r.text

def parse_xml(xml_text: str) -> tuple[int, int] | None:
    """원본 XML에서 대상 주차장의 (current, total)을 반환."""
    xml_text = xml_text.lstrip()
    root = ET.fromstring(xml_text)
    for rd in root.iter("resultData"):
        name_el = rd.find("park_name")
        if name_el is None:
            continue
        name = (name_el.text or "").strip()
        if name != TARGET_NAME:
            continue
        cur_el = rd.find("parkd_current_num")
        tot_el = rd.find("parkd_total_num")
        if cur_el is None or tot_el is None:
            return None
        try:
            cur = int((cur_el.text or "0").strip())
            tot = int((tot_el.text or "0").strip())
        except ValueError:
            return None
        return (cur, tot)
    return None

def scrape_once(session: requests.Session, url: str) -> tuple[str, int]:
    xml_text = fetch_xml(session, url)
    got = parse_xml(xml_text)
    if not got:
        raise ValueError("대상 주차장을 찾지 못함")
    cur, tot = got
    # 이상치 방어: current가 total을 초과하거나 음수면 무시
    if not (0 <= cur <= tot):
        raise ValueError(f"이상치 감지: current={cur}, total={tot}")
    # ISO8601 포맷(예: 2025-10-15T14:15:50+09:00)
    ts = datetime.now(KST).isoformat(timespec="seconds")
    return ts, cur

def scrape(url: str) -> tuple[str, int]:
    attempt = 0
    last_error = None
    while attempt < MAX_RETRY:
        attempt += 1
        try:
            with requests.Session() as session:
                try:
                    session.get("https://park.yuc.co.kr/", timeout=10)
                except Exception:
                    pass
                return scrape_once(session, url)
        except Exception as e:
            last_error = e
            logging.warning(f"실패 (시도 {attempt}): {e}")
            time.sleep(4 + attempt)
    logging.error("실패: 모든 재시도 실패")
    if last_error:
        raise last_error
    raise RuntimeError("알 수 없는 실패")

def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    logging.info("스크랩 시작")

    url = "https://park.yuc.co.kr/usersite/userSiteParkingLotInfo?regionCd=&parkinglotDivisionCd=&_="
    url = f"{url}{int(time.time()*1000)}"
    try:
        ts, avail = scrape(url)
        # 형식: ISO8601타임스탬프,이름,수치
        line = f"{ts},{TARGET_NAME},{avail}"
        # CSV에 누적
        with open(OUT_PATH, "a", newline="", encoding="utf-8") as f:
            f.write(line + "\n")
        logging.info(f"저장: {line}")
    except Exception as e:
        logging.error(e)
        # 이상치/네트워크 오류 등일 때는 파일을 쓰지 않음
        sys.exit(0)

if __name__ == "__main__":
    main()
