#!/usr/bin/env python3
"""로그 CSV 의 최근 며칠 행 수가 HEAD 보다 줄었으면 실패(종료 코드 1)한다.

오래된 체크아웃에서 시작한 세션이 최신 로그를 덮어쓰는 사고를 커밋 전에 막는다.
trim_logs.py 는 30일 초과분만 지우므로 최근 2일만 비교하면 정상 트림과 겹치지 않는다.
"""
import csv
import datetime as dt
import io
import subprocess
import sys

KST = dt.timezone(dt.timedelta(hours=9))
LOGS = ("predict_log.csv", "arrival_log.csv", "segment_log.csv")
RECENT_DAYS = 2


def recent_rows(text, since):
    count = 0
    for row in csv.DictReader(io.StringIO(text)):
        try:
            if dt.date.fromisoformat((row.get("ts_kst") or "")[:10]) >= since:
                count += 1
        except ValueError:
            continue
    return count


def shrunk_files(base, head_reader, current_reader, today=None):
    """(파일명, HEAD 행 수, 현재 행 수) 중 현재가 더 적은 것들을 돌려준다."""
    today = today or dt.datetime.now(dt.timezone.utc).astimezone(KST).date()
    since = today - dt.timedelta(days=RECENT_DAYS - 1)
    bad = []
    for name in LOGS:
        path = f"{base}/{name}"
        before = recent_rows(head_reader(path) or "", since)
        after = recent_rows(current_reader(path) or "", since)
        if after < before:
            bad.append((name, before, after))
    return bad


def git_head(path):
    result = subprocess.run(["git", "show", f"HEAD:{path}"], capture_output=True, text=True, encoding="utf-8")
    return result.stdout if result.returncode == 0 else ""


def read_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "bus-arrival"
    bad = shrunk_files(base, git_head, read_file)
    for name, before, after in bad:
        print(f"::error::{name} 최근 {RECENT_DAYS}일 행 수 감소 {before} -> {after}; 커밋 중단")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
