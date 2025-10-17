#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YUC scraper — legacy-only (lean)
Output format (append, no header):
  {ts_kst_iso},{target_name},{available}
Schema parsed:
  <resultData>
    <park_name>...</park_name>
    <parkd_current_num>...</parkd_current_num>
    <parkd_total_num>...</parkd_total_num>   # ignored for legacy
"""

import argparse, os, sys, logging
import datetime as dt
import unicodedata, re
import xml.etree.ElementTree as ET

try:
    import requests
except Exception:
    print("ERROR: 'requests'가 필요합니다. pip install requests", file=sys.stderr)
    sys.exit(69)

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.getenv("YUC_SOURCE_URL", ""), help="XML endpoint URL")
    p.add_argument("--target-name", default=os.getenv("YUC_TARGET_NAME", ""), help="주차장 이름")
    p.add_argument("--output-csv", default=os.getenv("YUC_OUTPUT_CSV", ""), help="CSV 경로(없으면 stdout)")
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO").upper())
    return p.parse_args()

def kst_iso_now():
    kst = dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).astimezone(dt.timezone(dt.timedelta(hours=9)))
    return kst.replace(microsecond=0).isoformat()

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    return re.sub(r"\s+", "", s)

def fetch_xml(url: str) -> str:
    s = requests.Session()
    s.headers.update({
        "User-Agent": "yuc-scraper/legacy (+script)",
        "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
    })
    r = s.get(url, timeout=(5, 15))
    r.raise_for_status()
    return r.text

def parse_available(xml_text: str, target_name: str) -> tuple[int, str]:
    root = ET.fromstring(xml_text)
    items = root.findall(".//resultData") or list(root)

    def name_of(it):
        el = it.find("park_name")
        return el.text.strip() if (el is not None and el.text) else ""

    def avail_of(it):
        v = it.findtext("parkd_current_num") or ""
        v = v.strip()
        return int(v) if v.isdigit() else -1

    # 정확 일치
    for it in items:
        nm = name_of(it)
        if nm == target_name:
            return avail_of(it), nm

    # 정규화 일치
    nt = _norm(target_name)
    if nt:
        for it in items:
            nm = name_of(it)
            if nm and _norm(nm) == nt:
                logging.warning("정확 일치 실패 → 정규화 일치 사용: %r", nm)
                return avail_of(it), nm

    # 부분 포함
    for it in items:
        nm = name_of(it)
        if nm and target_name and target_name in nm:
            logging.warning("정확 일치 실패 → 부분일치 사용: %r", nm)
            return avail_of(it), nm

    cands = [name_of(it) for it in items if name_of(it)]
    raise KeyError(f"타깃 미발견: {target_name!r} — 후보: {', '.join(cands[:30])}{' …' if len(cands)>30 else ''}")

def append_legacy_line(path: str, ts_kst_iso: str, target_name: str, available: int) -> None:
    line = f"{ts_kst_iso},{target_name},{available}"
    if not path:
        print(line)
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def main() -> int:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(message)s")
    logging.info("OUTPUT_CSV=%s", args.output_csv or "(stdout-only)")
    logging.info("TARGET_NAME=%s", args.target_name)
    logging.info("URL=%s", args.url or "(missing)")

    if not args.url or not args.target_name:
        logging.error("URL/타깃 이름 필요.")
        return 64

    try:
        xml_text = fetch_xml(args.url)
        avail, matched = parse_available(xml_text, args.target_name)
    except Exception as e:
        logging.error("%s", e)
        return 64

    ts = kst_iso_now()
    try:
        append_legacy_line(args.output_csv, ts, matched, avail)
    except Exception as e:
        logging.error("CSV 쓰기 실패: %s", e)
        return 73

    logging.info("완료: %s", {"ts_kst": ts, "target_name": matched, "available": avail})
    return 0

if __name__ == "__main__":
    sys.exit(main())
