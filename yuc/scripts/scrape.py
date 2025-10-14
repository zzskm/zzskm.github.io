# -*- coding: utf-8 -*-
"""
yuc/scripts/scrape.py
수지노외 공영주차장 잔여 주차대수 크롤링 (GitHub Actions 친화)
- networkidle → domcontentloaded 로 전환 (느린 JS 페이지 대응)
- 재시도 3회, 지수 백오프 (2s → 4s → 8s)
- 직전 값 동일 시 CSV 생략
"""

import csv
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Tuple

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

# === 설정 ===
TARGET_URL = "https://park.yuc.co.kr/views/parkinglot/info/info.html"
LOT_NAME = "수지노외 공영주차장"
CSV_PATH = Path(__file__).resolve().parent.parent / "parking_log.csv"

NAV_TIMEOUT_MS = 60_000          # 페이지 로드 대기 (60초)
WAIT_TIMEOUT_MS = 60_000         # LOT_NAME 요소 대기
RETRIES = 3                      # 재시도 횟수
BACKOFF_BASE_SEC = 2             # 백오프 시작 시간 (2s)

KST = timezone(timedelta(hours=9))


def ensure_csv() -> None:
    """CSV 파일 없으면 헤더 생성"""
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(["timestamp_kst", "lot_name", "available"])


def get_last_value() -> Optional[int]:
    """CSV의 마지막 available 값 반환"""
    if not CSV_PATH.exists():
        return None
    try:
        with CSV_PATH.open("r", encoding="utf-8") as f:
            lines = f.read().strip().splitlines()
            if len(lines) < 2:
                return None
            last_row = lines[-1].split(",")
            return int(last_row[-1])
    except Exception:
        return None


def extract_available(text: str) -> Optional[int]:
    """텍스트에서 '잔여/가능/주차가능' 인근 숫자 추출"""
    m = re.search(r"(잔여|가능|주차가능|빈|가용)[^\d]{0,12}(\d+)", text)
    if m:
        return int(m.group(2))
    nums = [int(x) for x in re.findall(r"\d+", text)]
    return min(nums) if nums else None


def _once(page) -> Tuple[str, int]:
    """단일 시도: 페이지 열고 LOT_NAME 블록에서 숫자 추출"""
    page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    locator = page.locator(f"text={LOT_NAME}")
    locator.first.wait_for(timeout=WAIT_TIMEOUT_MS)

    handle = locator.first.element_handle()
    container = handle.evaluate_handle(
        "(el)=>el.closest('tr')||el.closest('li')||el.closest('div')||el"
    )
    # ✅ 문법 오류 수정됨 (괄호 짝 맞춤)
    text = container.evaluate("(el)=>el.innerText||''")

    available = extract_available(text)
    if available is None:
        full_text = page.inner_text("body")
        available = extract_available(full_text)

    if available is None:
        raise RuntimeError("주차가능대수 추출 실패")

    ts = datetime.now(KST).isoformat(timespec="seconds")
    return ts, available


def scrape_once() -> Tuple[str, int]:
    """재시도 포함 스크랩"""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        page = browser.new_page(user_agent=(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ))

        last_err: Optional[Exception] = None
        for attempt in range(1, RETRIES + 1):
            try:
                return _once(page)
            except (PlaywrightTimeoutError, RuntimeError, Exception) as e:
                last_err = e
                if attempt >= RETRIES:
                    break
                backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                print(f"[retry {attempt}/{RETRIES-1}] 실패: {e} → {backoff}s 후 재시도", file=sys.stderr)
                try:
                    page.reload(wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
                except Exception:
                    page.close()
                    page = browser.new_page()
                time.sleep(backoff)

        browser.close()
        assert last_err is not None
        raise last_err


def main() -> None:
    """메인 루틴"""
    ensure_csv()
    try:
        ts, avail = scrape_once()
        last = get_last_value()

        if last == avail:
            print(f"[{ts}] {LOT_NAME} available={avail} (변화 없음, 기록 생략)")
            return

        with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow([ts, LOT_NAME, avail])

        print(f"[{ts}] {LOT_NAME} available={avail} (이전 {last}) → 기록 완료")

    except Exception as e:
        print("스크랩 실패:", e)
        sys.exit(1)


if __name__ == "__main__":
    main()
