import csv, re, os, time
from datetime import datetime, timezone, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

TARGET_URL = "https://park.yuc.co.kr/views/parkinglot/info/info.html"
LOT_NAME = "수지노외 공영주차장"
OUT = Path("data/parking_log.csv")

# 한국시간(Asia/Seoul) 타임스탬프 찍기
KST = timezone(timedelta(hours=9))

def ensure_header():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if not OUT.exists():
        with OUT.open("w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(["timestamp_kst","lot_name","available"])

def extract_available_from_text(text: str) -> int | None:
    # '잔여/가능/주차가능' 근처 숫자 우선
    m = re.search(r"(잔여|가능|주차가능|빈|가용)[^\d]{0,12}(\d+)", text)
    if m:
        return int(m.group(2))
    # 백업: 해당 블록 안의 가장 그럴듯한 숫자(용량 숫자 대비 작은 값일 가능성 고려 X)
    nums = [int(x) for x in re.findall(r"\d+", text)]
    if nums:
        # 큰 숫자가 전체 면수일 수 있으니, '잔여' 표시를 못 찾은 경우 평균 이하 값 선호
        return min(nums) if len(nums) > 1 else nums[0]
    return None

def scrape_once():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = browser.new_page()
        page.goto(TARGET_URL, wait_until="networkidle", timeout=60_000)

        # LOT_NAME 포함 노드 찾기 (테이블/카드 아무거나)
        locator = page.locator(f"text={LOT_NAME}")
        locator.first.wait_for(timeout=30_000)

        # 가장 가까운 컨테이너(행/카드) 텍스트 통째로
        # tr > td 구조면 tr, 카드형이면 div/li
        handle = locator.first.element_handle()
        container = handle.evaluate_handle("""
          (el) => (el.closest('tr') || el.closest('li') || el.closest('div') || el)
        """)
        text = container.evaluate("(el) => el.innerText || ''")

        val = extract_available_from_text(text)
        if val is None:
            # 혹시 표 헤더/다른 열 분리되어 있으면 주변 텍스트 더 긁기
            more = page.locator("body").inner_text()
            val = extract_available_from_text(more)

        browser.close()
        if val is None:
            raise RuntimeError("주차가능대수 추출 실패")

        ts = datetime.now(KST).isoformat(timespec="seconds")
        return ts, val

def main():
    ensure_header()
    ts, val = scrape_once()
    with OUT.open("a", newline="", encoding="utf-8") as f:
        csv.writer(f).writerow([ts, LOT_NAME, val])
    print(f"{ts} {LOT_NAME} available={val}")

if __name__ == "__main__":
    main()
