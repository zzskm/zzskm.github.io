#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
YUC scraper (resultData schema-aware)
- Parses <resultData> entries with <park_name>, <parkd_current_num>, <parkd_total_num>.
- CLI args + ENV fallback.
- CSV with header (ts_iso, ts_kst, target_name, available, total).
"""

import argparse, os, sys, csv, logging
import datetime as dt
import xml.etree.ElementTree as ET
import unicodedata, re
import requests

CSV_FIELDS = ["ts_iso", "ts_kst", "target_name", "available", "total"]

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--url", default=os.getenv("YUC_SOURCE_URL", ""), help="XML endpoint URL")
    p.add_argument("--target-name", default=os.getenv("YUC_TARGET_NAME", ""), help="주차장 이름(정확 일치 또는 느슨 매칭)")
    p.add_argument("--output-csv", default=os.getenv("YUC_OUTPUT_CSV", ""), help="CSV 경로(없으면 stdout)")
    p.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO").upper())
    return p.parse_args()

def kst_now_iso():
    ts = dt.datetime.utcnow().replace(microsecond=0, tzinfo=dt.timezone.utc).isoformat().replace("+00:00", "Z")
    kst = dt.datetime.utcnow().replace(tzinfo=dt.timezone.utc).astimezone(dt.timezone(dt.timedelta(hours=9)))
    return ts, kst.strftime("%Y-%m-%d %H:%M:%S%z")

def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"\s+", "", s)
    return s

def fetch(url: str) -> str:
    s = requests.Session()
    s.headers.update({
        "User-Agent": "yuc-scraper/1.2 (+script)",
        "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
    })
    r = s.get(url, timeout=(5,15))
    r.raise_for_status()
    return r.text

def parse_from_resultData(xml_text: str, target_name: str) -> tuple[int,int,str]:
    root = ET.fromstring(xml_text)
    items = root.findall(".//resultData")
    if not items:
        # try top-level as fallback
        items = list(root)

    # 1) exact match on park_name
    for it in items:
        name_el = it.find("park_name")
        if name_el is None or not (name_el.text or "").strip():
            continue
        name = name_el.text.strip()
        if name == target_name:
            avail = (it.findtext("parkd_current_num") or "").strip()
            total = (it.findtext("parkd_total_num") or "").strip()
            # some entries may have '-' in current/total
            a = int(avail) if avail.isdigit() else -1
            t = int(total) if total.isdigit() else -1
            return a, t, name

    # 2) normalized equality (remove spaces/normalize unicode)
    nt = _norm(target_name)
    if nt:
        for it in items:
            name = (it.findtext("park_name") or "").strip()
            if name and _norm(name) == nt:
                avail = (it.findtext("parkd_current_num") or "").strip()
                total = (it.findtext("parkd_total_num") or "").strip()
                a = int(avail) if avail.isdigit() else -1
                t = int(total) if total.isdigit() else -1
                logging.warning("정확 일치 실패 -> 정규화 일치로 대체: %r", name)
                return a, t, name

    # 3) substring (last resort)
    for it in items:
        name = (it.findtext("park_name") or "").strip()
        if name and target_name and target_name in name:
            avail = (it.findtext("parkd_current_num") or "").strip()
            total = (it.findtext("parkd_total_num") or "").strip()
            a = int(avail) if avail.isdigit() else -1
            t = int(total) if total.isdigit() else -1
            logging.warning("정확 일치 실패 -> 부분일치로 대체: %r", name)
            return a, t, name

    # Not found
    names = [ (it.findtext("park_name") or "").strip() for it in items ]
    raise KeyError(f"타깃 미발견: {target_name!r} — 후보: {', '.join([n for n in names if n][:30])}{' …' if len(names)>30 else ''}")

def write_csv(path: str, row: dict):
    if not path:
        print(",".join(str(row[k]) for k in CSV_FIELDS))
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    need_header = not os.path.exists(path) or os.path.getsize(path) == 0
    with open(path, "a", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if need_header:
            w.writeheader()
        w.writerow(row)

def main():
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO),
                        format="%(asctime)s %(levelname)s %(message)s")
    logging.info("OUTPUT_CSV=%s", args.output_csv or "(stdout-only)")
    logging.info("TARGET_NAME=%s", args.target_name)
    logging.info("URL=%s", args.url or "(missing)")

    if not args.url:
        logging.error("URL 필요. --url 또는 env YUC_SOURCE_URL 설정.")
        return 64
    if not args.target_name:
        logging.error("타깃 이름 필요. --target-name 또는 env YUC_TARGET_NAME 설정.")
        return 64

    try:
        xml_text = fetch(args.url)
    except Exception as e:
        logging.error("요청 실패: %s", e)
        return 75

    try:
        avail, total, matched = parse_from_resultData(xml_text, args.target_name)
    except Exception as e:
        logging.error("%s", e)
        return 64

    ts_iso, ts_kst = kst_now_iso()
    row = {
        "ts_iso": ts_iso,
        "ts_kst": ts_kst,
        "target_name": matched,
        "available": avail,
        "total": total,
    }
    try:
        write_csv(args.output_csv, row)
    except Exception as e:
        logging.error("CSV 저장 실패: %s", e)
        return 73

    logging.info("완료: %s", row)
    return 0

if __name__ == "__main__":
    sys.exit(main())
