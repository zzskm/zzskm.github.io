# -*- coding: utf-8 -*-
"""
yuc/scripts/scrape.py
수지노외 공영주차장 잔여 주차대수 크롤링
- GitHub Actions (scrape.yml)과 연동
- 결과 CSV: yuc/parking_log.csv
"""

import csv
import re
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

# === 설정 ===
TARGET_URL = "https://park.yuc.co.kr/views/parkinglot/info/info.html"
LOT_NAME = "수지노외 공영주차장"
CSV_PATH = Path(__file__).resolve().parent.parent / "parking_log.csv"
INTERVAL_S = 60  # GitHub Actions에서는 한 번만 실행하므로 무시됨

KST = timezone(timedelta(hours=9))


def ensure_csv():
    """CSV 파일 없으면 헤더 생성"""
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(["timestamp_kst", "lot_name", "available"])


def extract_available(text: str) -> int | None:
    """텍스트에서 '잔여/가능/주차가능' 인근 숫자 추출"""
    m = re.search(r"(잔여|가능|주차가능|빈|가용)[^\d]{0,12}(\d+)", text)
    if m:
        return int(m.group(2))
    nums = [int(x) for x in re.findall(r"\d+", text)]
    return min(nums) if nums else None


def scrape_once() -> tuple[str, int]:
    """Playwright로 페이지 로드 후 주차 가능 대수 추출"""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.goto(TARGET_URL, wait_until="networkidle", timeout=60_000)

        # LOT_NAME 포함 요소 등장 대기
        locator = page.locator(f"text={LOT_NAME}")
        locator.first.wait_for(timeout=30_000)

        # 가장 가까운 행/카드 컨테이너 텍스트 추출
        handle = locator.first.element_handle()
        container = handle.evaluate_handle(
            "(el)=>el.closest('tr')||el.closest('li')||el.closest('div')||el"
        )
        text = container.evaluate("(el)=>el.innerText||''")

        available = extract_available(text)
        if available is None:
            full_text = page.inner_text("body")
            available = extract_available(full_text)

        browser.close()
        if available is None:
            raise RuntimeError("주차가능대수 추출 실패")

        ts = datetime.now(KST).isoformat(timespec="seconds")
        return ts, available


def main():
    """메인 루틴"""
    ensure_csv()
    try:
        ts, avail = scrape_once()
        with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([ts, LOT_NAME, avail])
        print(f"[{ts}] {LOT_NAME} available={avail}")
    except Exception as e:
        print("스크랩 실패:", e)


if __name__ == "__main__":
    main()
