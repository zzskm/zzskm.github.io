#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os, sys, csv, logging, time, random
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
import requests

TARGET_NAME = "수지노외 공영주차장"
OUT_PATH = "yuc/data.csv"
SNAPSHOT_PATH = "yuc/last_response.txt"

MAX_RETRY = 3
TIMEOUT = 20
KST = timezone(timedelta(hours=9))

BASE_URL = "https://park.yuc.co.kr/usersite/userSiteParkingLotInfo"

COMMON_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/xml, text/xml;q=0.9, */*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
    "Referer": "https://park.yuc.co.kr/views/parkinglot/info/info",
    "X-Requested-With": "XMLHttpRequest",
}

def ms() -> int:
    return int(time.time() * 1000)

def ensure_dirs():
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(SNAPSHOT_PATH), exist_ok=True)

def snapshot(text: str):
    """최근 실패 응답을 저장해서 디버깅/다운로드 가능하게."""
    try:
        ensure_dirs()
        with open(SNAPSHOT_PATH, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    except Exception:
        pass

def fetch_xml(session: requests.Session) -> str:
    # 매 요청마다 fresh한 _ 파라미터 부여
    params = {
        "regionCd": "",
        "parkinglotDivisionCd": "",
        "_": str(ms()),
    }
    r = session.get(BASE_URL, headers=COMMON_HEADERS, params=params, timeout=TIMEOUT)
    r.raise_for_status()

    # 일부 서버가 content-type을 text/html로 주는 경우가 있어도 본문 검사로 판별
    text = r.text.lstrip()

    # 본문에서 ResultMaster가 시작하는 지점부터 잘라내기 (차단/광고 HTML 방어)
    anchor = text.find("<ResultMaster")
    if anchor > 0:
        text = text[anchor:]

    # 최소한의 형태 검증
    if "<ResultMaster" not in text or "</ResultMaster>" not in text:
        snapshot(text)
        raise ValueError("XML 응답이 아님(차단/HTML 가능성). last_response.txt 확인")

    return text

def parse_xml(xml_text: str) -> tuple[int, int] | None:
    """원본 XML에서 대상 주차장의 (current, total)을 반환."""
    xml_text = xml_text.lstrip()

    # XML 파싱
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        snapshot(xml_text)
        raise

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

        cur_raw = (cur_el.text or "").strip()
        tot_raw = (tot_el.text or "").strip()

        # 빈 값/하이픈 방어
        if cur_raw in ("", "-") or tot_raw in ("", "-"):
            return None

        try:
            cur = int(cur_raw)
            tot = int(tot_raw)
        except ValueError:
            return None

        return (cur, tot)

    return None

def scrape_once(session: requests.Session) -> tuple[str, int]:
    xml_text = fetch_xml(session)
    got = parse_xml(xml_text)
    if not got:
        raise ValueError("대상 주차장을 찾지 못함")

    cur, tot = got

    # 이상치 방어: current가 total을 초과하거나 음수면 무시
    if not (0 <= cur <= tot):
        snapshot(f"[이상치]\ncur={cur}, tot={tot}\n")
        raise ValueError(f"이상치 감지: current={cur}, total={tot}")

    # 극단적 오류(예: 3664 같은 비정상 큰 값) 추가 방어:
    # 총면수 합리적 상한선(예: 1000 이하) — 실제 데이터에 맞춰 필요시 조정
    if tot > 1100 or cur > 1100:
        snapshot(f"[비정상큰값]\ncur={cur}, tot={tot}\n")
        raise ValueError(f"비정상 큰 값: current={cur}, total={tot}")

    # ISO8601 포맷(예: 2025-10-15T14:15:50+09:00)
    ts = datetime.now(KST).isoformat(timespec="seconds")
    return ts, cur

def scrape() -> tuple[str, int]:
    attempt = 0
    last_error = None
    while attempt < MAX_RETRY:
        attempt += 1
        try:
            with requests.Session() as session:
                # 루트 접근으로 쿠키/세션 예열
                try:
                    session.get(
                        "https://park.yuc.co.kr/",
                        headers=COMMON_HEADERS,
                        timeout=10,
                    )
                except Exception:
                    # 예열 실패는 치명적이지 않음
                    pass

                return scrape_once(session)
        except Exception as e:
            last_error = e
            logging.warning(f"실패 (시도 {attempt}): {e}")
            # 서버/네트웍 사정 고려해서 지수적 대기
            time.sleep(5 + attempt * 2 + random.uniform(0, 1.5))

    logging.error("실패: 모든 재시도 실패")
    if last_error:
        logging.error(last_error)
        raise last_error
    raise RuntimeError("알 수 없는 실패")

def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    logging.info("스크랩 시작")

    ensure_dirs()
    try:
        ts, avail = scrape()
        # 형식: ISO8601타임스탬프,이름,수치
        line = f"{ts},{TARGET_NAME},{avail}"
        with open(OUT_PATH, "a", newline="", encoding="utf-8") as f:
            f.write(line + "\n")
        logging.info(f"저장: {line}")
    except Exception as e:
        # 실패 시 파일 미기록. 워크플로우를 실패로 만들고 싶으면 1로 종료.
        sys.exit(0)

if __name__ == "__main__":
    main()
