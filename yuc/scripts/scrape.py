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

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.getenv("YUC_SOURCE_URL", "https://park.yuc.co.kr/userSiteParkingLotInfo"), help="Backend XML endpoint")
    p.add_argument("--frontend-url", default=os.getenv("YUC_FRONTEND_URL", ""), help="Frontend URL for session (optional)")
    p.add_argument("--target-name", default=os.getenv("YUC_TARGET_NAME", ""), help="주차장 이름")
    p.add_argument("--output-csv", default=os.getenv("YUC_OUTPUT_CSV", ""), help="CSV 경로 (없으면 stdout)")
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO").upper(), help="로그 레벨")
    return p.parse_args()

def kst_iso_now():
    kst = dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).astimezone(dt.timezone(dt.timedelta(hours=9)))
    return kst.replace(microsecond=0).isoformat()

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", "", s)

def handle_retry(client, url, params=None, max_retries=5, is_frontend=False):
    """재시도 로직: 타임아웃/HTTP 에러 처리, 지수 백오프"""
    for attempt in range(max_retries):
        try:
            logging.info(f"{'Frontend' if is_frontend else 'Backend'} 시도 {attempt + 1}/{max_retries}: {url}")
            headers = {"Accept": "text/html,application/xhtml+xml"} if is_frontend else {}
            r = client.get(url, params=params, headers=headers)
            r.raise_for_status()
            if is_frontend:
                logging.info(f"세션 쿠키: {client.cookies.jar}")
            return r.text
        except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout) as e:
            logging.warning(f"{'Frontend' if is_frontend else 'Backend'} 타임아웃 (시도 {attempt + 1}): {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise
        except httpx.HTTPError as e:
            logging.error(f"{'Frontend' if is_frontend else 'Backend'} HTTP 에러 (시도 {attempt + 1}): {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
            else:
                raise
    raise Exception("최종 재시도 실패")

def fetch_with_session(backend_url: str, frontend_url: str = "", max_retries: int = 5) -> str:
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
        "Referer": frontend_url or "https://park.yuc.co.kr/views/parkinglot/info/info.html",
        "Origin": "https://park.yuc.co.kr",
        "X-Requested-With": "XMLHttpRequest",
    }
    limits = httpx.Limits(max_keepalive_connections=5, max_connections=20)
    timeout = httpx.Timeout(10.0, connect=10.0, read=30.0, write=30.0, pool=5.0)
    params = {"regionCd": "", "parkinglotDivisionCd": "", "_": str(int(time.time() * 1000))}

    with httpx.Client(headers=headers, limits=limits, timeout=timeout, follow_redirects=True) as client:
        if frontend_url:
            try:
                handle_retry(client, frontend_url, is_frontend=True, max_retries=max_retries)
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
    cands = [name_of(it) for it in items if name_of(it)]
    raise KeyError(f"타깃 미발견: {target_name!r} — 후보: {', '.join(cands[:30])}{' …' if len(cands)>30 else ''}")

def append_legacy_line(path: str, ts_kst_iso: str, target_name: str, available: int) -> None:
    line = f"{ts_kst_iso},{target_name},{available}"
    if not path:
        print(line)
        return

    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    try:
        # 기존 파일 끝의 빈 줄 제거
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            content = content.rstrip("\n")
            with open(path, "w", encoding="utf-8") as f:
                f.write(content + "\n" if content else "")
        # 새로운 줄 추가 (마지막 줄바꿈만 추가)
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        logging.error(f"CSV 쓰기 실패: {e}")
        raise

def main() -> int:
    args = parse_args()
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")
    logging.info(f"CSV={args.output_csv or '(stdout)'} TARGET={args.target_name} URL={args.url} FRONTEND={args.frontend_url or '(none)'}")

    if not args.url or not args.target_name:
        logging.error("URL/타깃 이름 필요")
        return 64

    try:
        xml_text = fetch_with_session(args.url, args.frontend_url)
        avail, matched = parse_available(xml_text, args.target_name)
        append_legacy_line(args.output_csv, kst_iso_now(), matched, avail)
        logging.info(f"완료: ts={kst_iso_now()}, name={matched}, available={avail}")
        return 0
    except Exception as e:
        logging.error(f"실패: {e}")
        return 64

if __name__ == "__main__":
    sys.exit(main())
