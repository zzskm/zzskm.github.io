#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YUC scraper — legacy-only (lean, 세션 기반, XML 응답, AJAX 모방)
Output format (append, no header): {ts_kst_iso},{target_name},{available}
Schema (XML): <resultData><park_name>...</park_name><parkd_current_num>...</parkd_current_num></resultData>
"""

import argparse, os, sys, logging
import datetime as dt
import unicodedata, re
import xml.etree.ElementTree as ET
import time
import httpx
import csv

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.getenv("YUC_SOURCE_URL", "https://park.yuc.co.kr/usersite/userSiteParkingLotInfo"), help="Backend XML endpoint")
    p.add_argument("--frontend-url", default=os.getenv("YUC_FRONTEND_URL", ""), help="Frontend URL for session (optional)")
    p.add_argument("--target-name", default=os.getenv("YUC_TARGET_NAME", ""), help="주차장 이름")
    p.add_argument("--output-csv", default=os.getenv("YUC_OUTPUT_CSV", ""), help="CSV 경로 (없으면 stdout)")
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO").upper(), help="로그 레벨")
    p.add_argument("--compress", action="store_true", help="CSV 압축만 수행 (크롤링 없이)")
    return p.parse_args()

def kst_iso_now():
    kst = dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).astimezone(dt.timezone(dt.timedelta(hours=9)))
    return kst.replace(microsecond=0).isoformat()

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", "", s)

import random

# 차단 의심 시 재시도하면 안 되는 상태 코드
_NO_RETRY_STATUS = {401, 403, 404, 429}

def _backoff_sleep(attempt: int) -> None:
    """지수 백오프 + jitter (3s, 6s, 12s, ...)"""
    base = 3 * (2 ** attempt)
    jitter = random.uniform(0, base * 0.5)
    delay = base + jitter
    logging.info(f"대기 {delay:.1f}초 후 재시도")
    time.sleep(delay)

def handle_retry(client, url, params=None, max_retries=3, is_frontend=False):
    """재시도 로직: 타임아웃/HTTP 에러 처리, 지수 백오프 + jitter"""
    label = "Frontend" if is_frontend else "Backend"
    for attempt in range(max_retries):
        try:
            logging.info(f"{label} 시도 {attempt + 1}/{max_retries}: {url}")
            headers = {"Accept": "text/html,application/xhtml+xml"} if is_frontend else {}
            r = client.get(url, params=params, headers=headers)
            r.raise_for_status()
            if is_frontend:
                logging.info(f"세션 쿠키: {client.cookies.jar}")
            return r.text
        except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout) as e:
            logging.warning(f"{label} 타임아웃 (시도 {attempt + 1}): {e}")
            if attempt < max_retries - 1:
                _backoff_sleep(attempt)
            else:
                raise
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            logging.error(f"{label} HTTP {code} (시도 {attempt + 1}): {e}")
            if code in _NO_RETRY_STATUS:
                logging.error(f"{label} {code} — 재시도 불가, 즉시 중단")
                raise
            if attempt < max_retries - 1:
                _backoff_sleep(attempt)
            else:
                raise
        except httpx.HTTPError as e:
            logging.error(f"{label} HTTP 에러 (시도 {attempt + 1}): {e}")
            if attempt < max_retries - 1:
                _backoff_sleep(attempt)
            else:
                raise
    raise Exception("최종 재시도 실패")

def fetch_with_session(backend_url: str, frontend_url: str = "", max_retries: int = 3) -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
        "Referer": frontend_url or "https://park.yuc.co.kr/views/parkinglot/info/info.html",
        "Origin": "https://park.yuc.co.kr",
        "X-Requested-With": "XMLHttpRequest",
    }
    limits = httpx.Limits(max_keepalive_connections=5, max_connections=10)
    timeout = httpx.Timeout(10.0, connect=10.0, read=30.0, write=10.0, pool=5.0)
    params = {"regionCd": "", "parkinglotDivisionCd": "", "_": str(int(time.time() * 1000))}

    with httpx.Client(headers=headers, limits=limits, timeout=timeout, follow_redirects=True) as client:
        if frontend_url:
            try:
                handle_retry(client, frontend_url, is_frontend=True, max_retries=1)
            except Exception as e:
                logging.warning(f"Frontend 세션 획득 실패: {e}, backend 직접 시도")
        return handle_retry(client, backend_url, params=params, max_retries=max_retries)

def parse_available(xml_text: str, target_name: str) -> tuple[int, str]:
    try:
        root = ET.fromstring(xml_text)
        items = root.findall(".//resultData") or list(root)
    except ET.ParseError as e:
        logging.error(f"XML 파싱 실패: {e}")
        raise ValueError("Invalid XML response")

    def name_of(it): return (it.find("park_name").text or "").strip() if it.find("park_name") is not None else ""
    def avail_of(it):
        v = (it.findtext("parkd_current_num") or "").strip()
        return -1 if v == "-" else int(v) if v.isdigit() else -1

    candidates = [name_of(it) for it in items if name_of(it)]
    logging.debug(f"주차장 목록: {', '.join(candidates[:30])}{' …' if len(candidates) > 30 else ''}")

    for it in items:
        nm = name_of(it)
        if nm == target_name:
            return avail_of(it), nm
    nt = _norm(target_name)
    if nt:
        for it in items:
            nm = name_of(it)
            if nm and _norm(nm) == nt:
                logging.warning(f"정규화 일치: {nm!r}")
                return avail_of(it), nm
    for it in items:
        nm = name_of(it)
        if nm and target_name and target_name in nm:
            logging.warning(f"부분 일치: {nm!r}")
            return avail_of(it), nm
    raise ValueError(f"타깃 미발견: {target_name!r}")

def compress_csv(path: str) -> None:
    """CSV 파일을 읽어서 3개 이상 연속되는 available 값은 첫 번째와 마지막만 남기고 압축"""
    if not path or not os.path.exists(path):
        return
    
    try:
        with open(path, 'r', encoding='utf-8') as f:
            reader = csv.reader(f)
            data = list(reader)
        
        if len(data) < 2:  # 헤더만 있거나 헤더도 없는 경우
            return
        
        header = data[0]
        rows = data[1:]
        
        # 연속된 같은 available 값 찾아서 압축
        result = [header]
        i = 0
        while i < len(rows):
            start = i
            val = rows[i][2]  # available 값
            while i < len(rows) and rows[i][2] == val:
                i += 1
            end = i - 1
            
            # 3개 이상 연속이면 첫 번째와 마지막만 유지
            if end - start >= 2:
                result.extend([rows[start], rows[end]])
            else:
                result.extend(rows[start:end + 1])
        
        # 압축된 데이터로 파일 재쓰기
        with open(path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.writer(f)
            writer.writerows(result)
        
        logging.info(f"CSV 압축 완료: {len(data)} -> {len(result)} 행")
    except Exception as e:
        logging.warning(f"CSV 압축 실패: {e}")

def append_legacy_line(path: str, ts_kst_iso: str, target_name: str, available: int) -> None:
    line = f"{ts_kst_iso},{target_name},{available}\n"
    if not path:
        print(line, end="")
        return

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception as e:
        logging.error(f"CSV 쓰기 실패: {e}")
        raise

def main() -> int:
    args = parse_args()
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")
    # httpx 내부 로깅 비활성화
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.info(f"CSV={args.output_csv or '(stdout)'} TARGET={args.target_name} URL={args.url} FRONTEND={args.frontend_url or '(none)'}")

    if args.compress:
        if not args.output_csv:
            logging.error("--output-csv 필요")
            return 64
        compress_csv(args.output_csv)
        return 0

    if not args.url or not args.target_name:
        logging.error("URL/타깃 이름 필요")
        return 64

    try:
        xml_text = fetch_with_session(args.url, args.frontend_url)
        avail, matched = parse_available(xml_text, args.target_name)
        ts = kst_iso_now()
        append_legacy_line(args.output_csv, ts, matched, avail)
        logging.info(f"완료: ts={ts}, name={matched}, available={avail}")
        if args.output_csv:
            compress_csv(args.output_csv)
        return 0
    except Exception as e:
        logging.error(f"실패: {e}")
        return 64

if __name__ == "__main__":
    sys.exit(main())
