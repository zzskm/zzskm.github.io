#!/usr/bin/env python3
# yuc/scripts/scrape.py

import os
import sys
import csv
import logging
import time
import random
import socket
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

import requests
from urllib3.util import Retry
from requests.adapters import HTTPAdapter

# ======================
# 설정값
# ======================
BASE_URL = "https://park.yuc.co.kr/usersite/userSiteParkingLotInfo"
COMMON_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/xml,application/xml,application/xhtml+xml,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
}
# 타임아웃/재시도 정책
CONNECT_TIMEOUT = 6
READ_TIMEOUT = 10
REQ_TIMEOUT = (CONNECT_TIMEOUT, READ_TIMEOUT)
MAX_RETRY = 5
BACKOFF_SECS = [2, 3, 5, 8, 13]  # 빠른 백오프 + 지터

# 타겟 주차장 이름 (환경변수로 오버라이드 가능)
TARGET_NAME = os.getenv("YUC_TARGET_NAME", "수지노외 공영주차장")

# 아티팩트/로그 저장 경로 (CI에서 디버그용 파일 떨어뜨릴 폴더)
ARTIFACT_DIR = os.getenv("YUC_ARTIFACT_DIR", "yuc/artifacts")
os.makedirs(ARTIFACT_DIR, exist_ok=True)

# 출력 CSV 경로 (옵션) — 기본은 stdout에 한 줄 출력
OUTPUT_CSV = os.getenv("YUC_OUTPUT_CSV", "").strip()  # 비어있으면 stdout-only

# ======================
# 로깅
# ======================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)

# ======================
# 유틸
# ======================
def ms() -> int:
    return int(time.time() * 1000)

def snapshot(text: str, name: str = "last_response.txt") -> None:
    try:
        p = os.path.join(ARTIFACT_DIR, name)
        with open(p, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    except Exception as _:
        pass

def build_session() -> requests.Session:
    s = requests.Session()
    s.trust_env = True  # CI/기업망 프록시/CA 활용
    s.headers.update(COMMON_HEADERS)

    retry = Retry(
        total=3,
        connect=3,
        read=1,
        status=1,
        status_forcelist=(429, 500, 502, 503, 504),
        backoff_factor=0.5,
        raise_on_status=False,
        allowed_methods=frozenset(["GET"]),
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s

def warmup(session: requests.Session) -> None:
    # 서버가 화면경로를 먼저 친 뒤 Ajax를 더 잘 받는 경우를 대비해 예열
    try:
        session.get("https://park.yuc.co.kr/", timeout=REQ_TIMEOUT, allow_redirects=True)
    except Exception:
        pass
    try:
        session.get(
            "https://park.yuc.co.kr/views/parkinglot/info/info",
            timeout=REQ_TIMEOUT,
            allow_redirects=True,
        )
    except Exception:
        pass

def fetch_xml(session: requests.Session) -> str:
    params = {"regionCd": "", "parkinglotDivisionCd": "", "_": str(ms())}
    r = session.get(BASE_URL, params=params, timeout=REQ_TIMEOUT, allow_redirects=True)
    r.raise_for_status()
    text = r.text.lstrip()

    # 혹시 HTML이 앞에 섞여 들어온 경우를 방지
    anchor = text.find("<ResultMaster")
    if anchor > 0:
        text = text[anchor:]

    if "<ResultMaster" not in text or "</ResultMaster>" not in text:
        snapshot(text, "not_xml_response.txt")
        raise ValueError("XML 응답이 아님(차단/HTML 가능성). artifacts/not_xml_response.txt 확인")

    return text

def parse_target_availability(xml_text: str, target_name: str) -> int:
    """
    XML에서 target_name(park_name)의 현재 가능 대수(parkd_current_num)를 정수로 반환.
    없거나 수치가 비어있으면 0으로 간주.
    """
    root = ET.fromstring(xml_text)  # 여기서 파싱 에러 나면 상위에서 재시도
    # resultData 블록들 순회
    for rd in root.findall("./resultData"):
        name_el = rd.find("park_name")
        if name_el is None:
            continue
        name = (name_el.text or "").strip()
        if name != target_name:
            continue

        num_el = rd.find("parkd_current_num")
        raw = (num_el.text or "").strip() if num_el is not None else ""
        # 빈칸/하이픈 등은 0 처리
        if raw == "" or raw == "-":
            return 0
        # 숫자만 남기기
        digits = "".join(ch for ch in raw if ch.isdigit())
        if digits == "":
            return 0
        try:
            return int(digits)
        except ValueError:
            return 0

    raise KeyError(f"타깃 주차장 미발견: {target_name}")

def iso_now_kst() -> str:
    kst = timezone(timedelta(hours=9))
    # seconds 정밀도까지만
    return datetime.now(kst).isoformat(timespec="seconds")

def write_output_line(ts_iso: str, name: str, count: int) -> None:
    line = f"{ts_iso},{name},{count}"
    # stdout
    print(line)
    # 선택적으로 CSV 파일에도 append
    if OUTPUT_CSV:
        try:
            # CSV 파일은 utf-8로 누적
            new_file = not os.path.exists(OUTPUT_CSV)
            with open(OUTPUT_CSV, "a", encoding="utf-8", newline="") as f:
                w = csv.writer(f)
                if new_file:
                    w.writerow(["timestamp", "name", "available"])
                w.writerow([ts_iso, name, count])
        except Exception as e:
            logging.warning(f"CSV 저장 실패: {e}")

# ======================
# 핵심 실행부
# ======================
def scrape_once(session: requests.Session) -> tuple[str, int]:
    xml_text = fetch_xml(session)
    # 원본 XML 스냅샷 남기기(디버그)
    snapshot(xml_text, "raw_1.xml")
    count = parse_target_availability(xml_text, TARGET_NAME)
    ts_iso = iso_now_kst()
    return ts_iso, count

def scrape() -> tuple[str, int]:
    last_error = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            with build_session() as session:
                warmup(session)
                return scrape_once(session)
        except Exception as e:
            last_error = e
            logging.warning(f"실패 (시도 {attempt}): {e}")
            # 빠른 백오프 + 지터
            sleep_s = BACKOFF_SECS[min(attempt - 1, len(BACKOFF_SECS) - 1)] + random.uniform(0, 1.0)
            time.sleep(sleep_s)

    logging.error("실패: 모든 재시도 실패")
    if last_error:
        logging.error(last_error)
        raise last_error
    raise RuntimeError("알 수 없는 실패")

def main() -> None:
    logging.info("스크랩 시작")
    try:
        ts_iso, available = scrape()
        # 한 줄만 출력 (형식: ISO8601,KST,이름,가용대수)
        write_output_line(ts_iso, TARGET_NAME, available)
    except Exception as e:
        # 실패 시 CI에서 실패로 인식하도록 1로 종료
        # 마지막 응답은 artifacts 아래 파일들 확인
        logging.error(e)
        sys.exit(1)

if __name__ == "__main__":
    main()
