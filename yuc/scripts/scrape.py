#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
yuc scrape - improved version
- CLI args + ENV + optional YAML config
- Robust requests with retry/timeout
- Defensive XML parsing with clear errors
- CSV with fixed schema + header
- Auto-create parent directories
- Artifacts snapshotting for failures
- Clear logging; reasoned exit codes
"""

from __future__ import annotations
import argparse
import csv
import datetime as dt
import logging
import os
import socket
import sys
import tempfile
from typing import Optional, Dict, Any

# Optional deps
try:
    import yaml  # type: ignore
except Exception:  # pragma: no cover
    yaml = None  # noqa: F401

try:
    import requests
    from requests.adapters import HTTPAdapter
except Exception as e:
    print("ERROR: 'requests' 패키지가 필요합니다. pip install requests 후 다시 실행하세요.", file=sys.stderr)
    sys.exit(69)  # unavailable dependency

try:
    from urllib3.util import Retry  # type: ignore
except Exception:
    # Fallback: minimal no-Retry shim
    class Retry:  # type: ignore
        def __init__(self, *a, **kw):
            pass

import xml.etree.ElementTree as ET

CSV_FIELDS = ["ts_iso", "ts_kst", "target_name", "available"]

DEFAULT_TARGET_NAME = os.getenv("YUC_TARGET_NAME", "수지노외 공영주차장")
DEFAULT_OUTPUT_CSV = os.getenv("YUC_OUTPUT_CSV", "yuc/parking_log.csv")
DEFAULT_SOURCE_URL = os.getenv("YUC_SOURCE_URL", "https://park.yuc.co.kr/usersite/userSiteParkingLotInfo")
DEFAULT_ARTIFACTS_DIR = os.getenv("YUC_ARTIFACTS_DIR", "yuc/artifacts")
DEFAULT_YAML = os.getenv("YUC_CONFIG_YAML", "yuc_scrape.yml")

COMMON_HEADERS = {
    "User-Agent": "yuc-scraper/1.1 (+script)",
    "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="YUC parking availability scraper (improved)")
    p.add_argument("--url", default=DEFAULT_SOURCE_URL, help="원본 XML/endpoint URL (env: YUC_SOURCE_URL)")
    p.add_argument("--target-name", default=DEFAULT_TARGET_NAME, help="찾을 주차장 이름 (env: YUC_TARGET_NAME)")
    p.add_argument("--output-csv", default=DEFAULT_OUTPUT_CSV, help="CSV 출력 경로 (env: YUC_OUTPUT_CSV)")
    p.add_argument("--artifacts-dir", default=DEFAULT_ARTIFACTS_DIR, help="아티팩트 저장 디렉토리")
    p.add_argument("--yaml", default=DEFAULT_YAML, help="기본 설정 YAML 경로 (선택, 미존재시 무시)")
    p.add_argument("--timeout-connect", type=float, default=5.0, help="요청 connect 타임아웃(초)")
    p.add_argument("--timeout-read", type=float, default=15.0, help="요청 read 타임아웃(초)")
    p.add_argument("--retries", type=int, default=5, help="재시도 횟수 (5xx/429)")
    p.add_argument("--backoff", type=float, default=0.5, help="지수 백오프 기본 계수")
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO").upper(), help="로그 레벨 (DEBUG/INFO/WARN/ERROR)")
    return p.parse_args()


def load_yaml_config(path: str) -> Dict[str, Any]:
    if not path or not os.path.exists(path):
        return {}
    if yaml is None:
        logging.warning("PyYAML 미설치로 YAML(%s) 로딩을 건너뜁니다.", path)
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
            if not isinstance(data, dict):
                logging.warning("YAML 루트가 dict가 아닙니다. 무시합니다: %s", type(data))
                return {}
            return data
    except Exception as e:  # pragma: no cover
        logging.warning("YAML 로딩 실패(%s): %s", path, e)
        return {}


def apply_config_priority(args: argparse.Namespace, y: Dict[str, Any]) -> Dict[str, Any]:
    """
    Priority: CLI > ENV (already applied as defaults) > YAML
    We only fill missing/empty values from YAML.
    """
    merged = {
        "url": args.url or "",
        "target_name": args.target_name or "",
        "output_csv": args.output_csv or "",
        "artifacts_dir": args.artifacts_dir or DEFAULT_ARTIFACTS_DIR,
        "timeout_connect": args.timeout_connect,
        "timeout_read": args.timeout_read,
        "retries": args.retries,
        "backoff": args.backoff,
        "log_level": args.log_level,
    }
    # YAML keys optional: url, target_name, output_csv, artifacts_dir
    if y:
        merged["url"] = merged["url"] or y.get("url", "")
        merged["target_name"] = merged["target_name"] or y.get("target_name", "")
        merged["output_csv"] = merged["output_csv"] or y.get("output_csv", "")
        merged["artifacts_dir"] = merged.get("artifacts_dir") or y.get("artifacts_dir", DEFAULT_ARTIFACTS_DIR)
    return merged


def kst_from_utc_iso(ts_iso: str) -> str:
    # Expect ts like "2025-01-01T00:00:00Z"
    try:
        if ts_iso.endswith("Z"):
            base = ts_iso[:-1]
            dt_utc = dt.datetime.fromisoformat(base).replace(tzinfo=dt.timezone.utc)
        else:
            dt_utc = dt.datetime.fromisoformat(ts_iso)
            if dt_utc.tzinfo is None:
                dt_utc = dt_utc.replace(tzinfo=dt.timezone.utc)
        kst = dt_utc.astimezone(dt.timezone(dt.timedelta(hours=9)))
        return kst.strftime("%Y-%m-%d %H:%M:%S%z")
    except Exception:
        # Fallback to now KST
        now_kst = dt.datetime.now(dt.timezone(dt.timedelta(hours=9)))
        return now_kst.strftime("%Y-%m-%d %H:%M:%S%z")


def build_session(retries: int, backoff: float) -> requests.Session:
    s = requests.Session()
    s.trust_env = True
    s.headers.update(COMMON_HEADERS)
    try:
        retry = Retry(
            total=retries,
            read=retries,
            connect=min(3, retries),
            backoff_factor=backoff,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET", "HEAD"],
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry)
        s.mount("http://", adapter)
        s.mount("https://", adapter)
    except Exception:
        pass
    return s


def fetch_text(url: str, timeout: tuple[float, float], session: Optional[requests.Session] = None) -> str:
    sess = session or build_session(retries=3, backoff=0.5)
    resp = sess.get(url, timeout=timeout)
    if not resp.ok:
        raise RuntimeError(f"HTTP 실패 status={resp.status_code}")
    # Some endpoints return bytes in unknown encodings; requests guesses,
    # but we prefer text to pass to XML parser
    return resp.text


def ensure_dir(path: str) -> None:
    if not path:
        return
    try:
        os.makedirs(path, exist_ok=True)
    except Exception as e:
        logging.warning("디렉토리 생성 실패(%s): %s", path, e)


def snapshot(artifacts_dir: str, filename: str, content: str) -> str:
    ensure_dir(artifacts_dir)
    p = os.path.join(artifacts_dir, filename)
    try:
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
        return p
    except Exception as e:
        logging.warning("스냅샷 저장 실패(%s): %s", p, e)
        return ""


def safe_find_text(elem: ET.Element, path: str, default: Optional[str] = None) -> Optional[str]:
    found = elem.find(path)
    return (found.text.strip() if (found is not None and found.text) else default)


def parse_available(xml_text: str, target_name: str) -> int:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise ValueError(f"XML 파싱 실패: {e}")

    # heuristic paths: adjust to your schema
    lots = root.findall(".//parkingLot") or root.findall(".//lot") or root.findall(".//item")
    for lot in lots:
        name = safe_find_text(lot, "./name") or safe_find_text(lot, "./park_name") or safe_find_text(lot, "./title")
        if name == target_name:
            avail = safe_find_text(lot, "./available") or safe_find_text(lot, "./remain") or safe_find_text(lot, "./count")
            if avail is None or not str(avail).strip().isdigit():
                raise ValueError(f"가용대수 값 비정상: {avail!r}")
            return int(avail)
    # exact not found: try loose match
    for lot in lots:
        name = safe_find_text(lot, "./name") or safe_find_text(lot, "./park_name") or safe_find_text(lot, "./title")
        if name and target_name and target_name in name:
            avail = safe_find_text(lot, "./available") or safe_find_text(lot, "./remain") or safe_find_text(lot, "./count")
            if avail is None or not str(avail).strip().isdigit():
                raise ValueError(f"가용대수 값 비정상(부분일치): {avail!r}")
            logging.warning("정확 일치 실패 -> 부분일치로 대체: %r vs %r", name, target_name)
            return int(avail)
    raise KeyError(f"타깃 미발견: {target_name!r}")


def write_csv_row(path: str, row: Dict[str, Any]) -> None:
    if not path:
        # stdout CSV (no header in stdout mode to preserve previous behavior)
        print(",".join(str(row[k]) for k in CSV_FIELDS))
        return
    abs_path = os.path.abspath(path)
    ensure_dir(os.path.dirname(abs_path))
    exists = os.path.exists(abs_path) and os.path.getsize(abs_path) > 0
    with open(abs_path, "a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if not exists:
            w.writeheader()
        w.writerow(row)


def main() -> int:
    args = parse_args()

    # Logging first
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(message)s")
    # Load YAML (optional) and merge
    yconf = load_yaml_config(args.yaml)
    cfg = apply_config_priority(args, yconf)

    logging.info("HOST=%s", socket.gethostname())
    logging.info("OUTPUT_CSV=%s", cfg["output_csv"] or "(stdout-only)")
    logging.info("TARGET_NAME=%s", cfg["target_name"])
    logging.info("URL=%s", cfg["url"] or "(MISSING)")
    logging.info("ARTIFACTS_DIR=%s", cfg["artifacts_dir"])

    url = cfg["url"]
    if not url:
        logging.error("URL이 지정되지 않았습니다. --url 또는 env YUC_SOURCE_URL, 또는 YAML에 url을 설정하세요.")
        return 64  # usage error

    session = build_session(retries=int(cfg["retries"]), backoff=float(cfg["backoff"]))
    timeout = (float(cfg["timeout_connect"]), float(cfg["timeout_read"]))

    # 1) fetch
    text = ""
    try:
        text = fetch_text(url, timeout=timeout, session=session)
    except Exception as e:
        logging.error("요청 실패: %s", e)
        # Save artifact to inspect (if any response text was captured at higher layer, not here)
        # Nothing to snapshot here reliably, so just exit
        return 75  # temp failure

    # Snapshot the raw for debugging with timestamp
    ts_tag = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    snapshot(cfg["artifacts_dir"], f"raw_{ts_tag}.xml", text)

    # 2) parse
    try:
        available = parse_available(text, cfg["target_name"])
    except ET.ParseError as e:
        snapshot(cfg["artifacts_dir"], "not_xml_response.txt", text)
        logging.error("XML 파싱 실패: %s", e)
        return 65
    except ValueError as e:
        snapshot(cfg["artifacts_dir"], "parse_error.txt", text)
        logging.error("%s", e)
        return 65  # data format / parsing issue
    except KeyError as e:
        snapshot(cfg["artifacts_dir"], "target_not_found.txt", text)
        logging.error("%s", e)
        return 64  # input mismatch (bad target)

    # 3) write csv/stdout
    ts_iso = dt.datetime.utcnow().replace(microsecond=0, tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")
    row = {
        "ts_iso": ts_iso,
        "ts_kst": kst_from_utc_iso(ts_iso),
        "target_name": cfg["target_name"],
        "available": int(available),
    }
    try:
        write_csv_row(cfg["output_csv"], row)
    except Exception as e:
        logging.error("CSV 저장 실패(%s): %s", cfg["output_csv"], e)
        return 73  # can't create output

    logging.info("완료: %s", row)
    return 0


if __name__ == "__main__":
    rc = main()
    sys.exit(rc)
