#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YUC scraper — legacy-only (lean, 세션 기반, XML 응답, AJAX 모방)
Output CSV format (append, no header): {ts_kst_iso},{target_name},{available}
Status JSON: latest scrape attempt/success state for UI fallback.
Schema (XML): <resultData><park_name>...</park_name><parkd_current_num>...</parkd_current_num></resultData>
"""

import argparse
import csv
import datetime as dt
import json
import logging
import os
import random
import re
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET

import httpx


# 차단/요청 제한 의심 시 같은 실행 안에서 재시도하면 손해인 상태 코드
_NO_RETRY_STATUS = {401, 403, 404, 429}
_KST = dt.timezone(dt.timedelta(hours=9))


class ScrapeError(Exception):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.error_type = error_type


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.getenv("YUC_SOURCE_URL", "https://park.yuc.co.kr/usersite/userSiteParkingLotInfo"), help="Backend XML endpoint")
    p.add_argument("--frontend-url", default=os.getenv("YUC_FRONTEND_URL", ""), help="Frontend URL for session (optional)")
    p.add_argument("--target-name", default=os.getenv("YUC_TARGET_NAME", ""), help="주차장 이름")
    p.add_argument("--output-csv", default=os.getenv("YUC_OUTPUT_CSV", ""), help="CSV 경로 (없으면 stdout)")
    p.add_argument("--status-json", default=os.getenv("YUC_STATUS_JSON", ""), help="상태 JSON 경로")
    p.add_argument("--max-retries", type=int, default=int(os.getenv("YUC_MAX_RETRIES", "2")), help="Backend 최대 재시도 횟수")
    p.add_argument("--allow-stale-success", action="store_true", default=os.getenv("YUC_ALLOW_STALE_SUCCESS", "").lower() in {"1", "true", "yes"}, help="실패 상태를 status JSON에 기록한 경우 exit 0 처리")
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO").upper(), help="로그 레벨")
    p.add_argument("--compress", action="store_true", help="CSV 압축만 수행 (크롤링 없이)")
    return p.parse_args()


def kst_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).astimezone(_KST).replace(microsecond=0)


def kst_iso_now() -> str:
    return kst_now().isoformat()


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", "", s)


def response_sample(text: str, limit: int = 800) -> str:
    compact = re.sub(r"\s+", " ", text or "").strip()
    return compact[:limit]


def classify_http_status(code: int) -> str:
    if code in (401, 403):
        return "blocked"
    if code == 404:
        return "not_found"
    if code == 429:
        return "rate_limited"
    if 500 <= code:
        return "server_error"
    return "http_error"


def load_status(path: str) -> dict:
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logging.warning("상태 JSON 읽기 실패: %s", e)
        return {}


def save_status(path: str, data: dict) -> None:
    if not path:
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


def update_status(path: str, patch: dict) -> None:
    if not path:
        return
    status = load_status(path)
    status.update(patch)
    save_status(path, status)


def _backoff_sleep(attempt: int) -> None:
    """지수 백오프 + jitter (3s, 6s, 12s, ...)"""
    base = 3 * (2 ** attempt)
    jitter = random.uniform(0, base * 0.5)
    delay = base + jitter
    logging.info("대기 %.1f초 후 재시도", delay)
    time.sleep(delay)


def handle_retry(client, url, params=None, max_retries=3, is_frontend=False):
    """재시도 로직: 타임아웃/HTTP 에러 처리, 지수 백오프 + jitter"""
    label = "Frontend" if is_frontend else "Backend"
    max_retries = max(1, max_retries)

    for attempt in range(max_retries):
        try:
            logging.info("%s 시도 %s/%s: %s", label, attempt + 1, max_retries, url)
            headers = {"Accept": "text/html,application/xhtml+xml"} if is_frontend else {}
            r = client.get(url, params=params, headers=headers)
            r.raise_for_status()
            if is_frontend:
                logging.info("세션 쿠키: %s", client.cookies.jar)
            return r.text
        except (httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout) as e:
            logging.warning("%s 타임아웃 (시도 %s): %s", label, attempt + 1, e)
            if attempt < max_retries - 1:
                _backoff_sleep(attempt)
            else:
                raise ScrapeError("timeout", f"{label} timeout: {type(e).__name__}") from e
        except httpx.HTTPStatusError as e:
            code = e.response.status_code
            error_type = classify_http_status(code)
            logging.error("%s HTTP %s/%s (시도 %s): %s", label, code, error_type, attempt + 1, e)
            if e.response is not None:
                logging.debug("%s 응답 샘플: %s", label, response_sample(e.response.text))
            if code in _NO_RETRY_STATUS:
                logging.error("%s %s — 재시도 불가, 즉시 중단", label, code)
                raise ScrapeError(error_type, f"{label} HTTP {code}") from e
            if attempt < max_retries - 1:
                _backoff_sleep(attempt)
            else:
                raise ScrapeError(error_type, f"{label} HTTP {code}") from e
        except httpx.HTTPError as e:
            logging.error("%s HTTP 에러 (시도 %s): %s", label, attempt + 1, e)
            if attempt < max_retries - 1:
                _backoff_sleep(attempt)
            else:
                raise ScrapeError("network_error", f"{label} network error: {type(e).__name__}") from e

    raise ScrapeError("retry_exhausted", "최종 재시도 실패")


def fetch_with_session(backend_url: str, frontend_url: str = "", max_retries: int = 2) -> str:
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
                logging.warning("Frontend 세션 획득 실패: %s, backend 직접 시도", e)
        return handle_retry(client, backend_url, params=params, max_retries=max_retries)


def parse_available(xml_text: str, target_name: str) -> tuple[int, str]:
    try:
        root = ET.fromstring(xml_text)
        items = root.findall(".//resultData") or list(root)
    except ET.ParseError as e:
        logging.error("XML 파싱 실패: %s", e)
        logging.error("응답 샘플: %s", response_sample(xml_text))
        raise ScrapeError("invalid_xml", "Invalid XML response") from e

    def name_of(it):
        return (it.find("park_name").text or "").strip() if it.find("park_name") is not None else ""

    def avail_of(it):
        v = (it.findtext("parkd_current_num") or "").strip()
        return -1 if v == "-" else int(v) if v.isdigit() else -1

    candidates = [name_of(it) for it in items if name_of(it)]
    logging.debug("주차장 목록: %s%s", ", ".join(candidates[:30]), " …" if len(candidates) > 30 else "")

    for it in items:
        nm = name_of(it)
        if nm == target_name:
            return avail_of(it), nm

    nt = _norm(target_name)
    if nt:
        for it in items:
            nm = name_of(it)
            if nm and _norm(nm) == nt:
                logging.warning("정규화 일치: %r", nm)
                return avail_of(it), nm

    for it in items:
        nm = name_of(it)
        if nm and target_name and target_name in nm:
            logging.warning("부분 일치: %r", nm)
            return avail_of(it), nm

    logging.error("타깃 미발견. 후보 일부: %s", ", ".join(candidates[:50]))
    raise ScrapeError("target_not_found", f"타깃 미발견: {target_name!r}")


def compress_csv(path: str) -> None:
    """CSV 파일을 읽어서 3개 이상 연속되는 available 값은 첫 번째와 마지막만 남기고 압축한다."""
    if not path or not os.path.exists(path):
        return

    try:
        with open(path, "r", encoding="utf-8") as f:
            data = [row for row in csv.reader(f) if row]

        if len(data) < 3:
            return

        # legacy 파일은 헤더가 없지만, 이미 헤더가 들어간 파일도 방어한다.
        has_header = len(data[0]) >= 3 and data[0][0] in {"ts", "ts_kst_iso", "timestamp"}
        header = data[0] if has_header else None
        rows = data[1:] if has_header else data
        rows = [row for row in rows if len(row) >= 3]

        if len(rows) < 3:
            return

        result = [header] if header else []
        i = 0
        while i < len(rows):
            start = i
            val = rows[i][2]
            while i < len(rows) and len(rows[i]) >= 3 and rows[i][2] == val:
                i += 1
            end = i - 1

            if end - start >= 2:
                result.extend([rows[start], rows[end]])
            else:
                result.extend(rows[start:end + 1])

        with open(path, "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerows(result)

        logging.info("CSV 압축 완료: %s -> %s 행", len(data), len(result))
    except Exception as e:
        logging.warning("CSV 압축 실패: %s", e)


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
        logging.error("CSV 쓰기 실패: %s", e)
        raise


def main() -> int:
    args = parse_args()
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.info(
        "CSV=%s STATUS=%s TARGET=%s URL=%s FRONTEND=%s RETRIES=%s",
        args.output_csv or "(stdout)",
        args.status_json or "(none)",
        args.target_name,
        args.url,
        args.frontend_url or "(none)",
        args.max_retries,
    )

    if args.compress:
        if not args.output_csv:
            logging.error("--output-csv 필요")
            return 64
        compress_csv(args.output_csv)
        return 0

    if not args.url or not args.target_name:
        logging.error("URL/타깃 이름 필요")
        return 64

    ts = kst_iso_now()
    update_status(args.status_json, {
        "target": args.target_name,
        "last_attempt_at": ts,
        "status": "running",
        "error_type": "",
        "error_message": "",
    })

    try:
        xml_text = fetch_with_session(args.url, args.frontend_url, max_retries=args.max_retries)
        avail, matched = parse_available(xml_text, args.target_name)
        ts = kst_iso_now()
        append_legacy_line(args.output_csv, ts, matched, avail)
        update_status(args.status_json, {
            "target": args.target_name,
            "matched_name": matched,
            "available": avail,
            "last_success_at": ts,
            "last_attempt_at": ts,
            "status": "ok",
            "error_type": "",
            "error_message": "",
        })
        logging.info("완료: ts=%s, name=%s, available=%s", ts, matched, avail)
        return 0
    except ScrapeError as e:
        ts = kst_iso_now()
        update_status(args.status_json, {
            "target": args.target_name,
            "last_attempt_at": ts,
            "status": "stale",
            "error_type": e.error_type,
            "error_message": str(e),
        })
        logging.error("실패[%s]: %s", e.error_type, e)
        return 0 if args.allow_stale_success and args.status_json else 64
    except Exception as e:
        ts = kst_iso_now()
        update_status(args.status_json, {
            "target": args.target_name,
            "last_attempt_at": ts,
            "status": "stale",
            "error_type": type(e).__name__,
            "error_message": str(e),
        })
        logging.exception("실패: %s", e)
        return 0 if args.allow_stale_success and args.status_json else 64


if __name__ == "__main__":
    sys.exit(main())
