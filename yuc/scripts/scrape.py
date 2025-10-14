# -*- coding: utf-8 -*-
"""
yuc/scripts/scrape.py
수지노외 공영주차장 잔여 주차대수 크롤링
- GitHub Actions에서 5분마다 실행
- 직전 레코드와 값이 같으면 CSV에 기록하지 않음
"""

import csv
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from playwright.sync_api import sync_playwright

# === 설정 ===
TARGET_URL = "https://park.yuc.co.kr/views/parkinglot/info/info.html"
LOT_NAME = "수지노외 공영주차장"
CSV_PATH = Path(__file__).resolve().parent.parent / "parking_log.csv"

KST = timezone(timedelta(hours=9))


def ensure_csv():
    """CSV 파일 없으면 헤더 생성"""
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
        with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(["timestamp_kst", "lot_name", "available"])


def get_last_value() -> int | None:
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
        last = get_last_value()

        if last == avail:
            print(f"[{ts}] {LOT_NAME} available={avail} (변화 없음, 기록 생략)")
            return  # 스킵

        with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow([ts, LOT_NAME, avail])

        print(f"[{ts}] {LOT_NAME} available={avail} (이전 {last}) → 기록 완료")

    except Exception as e:
        print("스크랩 실패:", e)


if __name__ == "__main__":
    main()
