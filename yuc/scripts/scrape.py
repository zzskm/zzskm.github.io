# -*- coding: utf-8 -*-
"""
yuc/scripts/scrape.py  — full hardened version
수지노외 공영주차장 잔여 주차대수 크롤링 (GitHub Actions/cron 친화)

주요 개선점
- GNB 경유 진입 + 직접 URL 폴백 + HTTP 응답코드 검증
- 데이터 “실제 로딩” 확인 (LOT_NAME 셀렉터 & 본문 정규식 2중 검증)
- 리소스 다이어트 (image/media/font 차단)로 속도/안정성 향상
- 재시도: 지수 백오프 + 지터, 각 시도 실패 시 아티팩트(screenshot/HTML) 저장
- 로깅 강화: JSON/텍스트 선택, 레벨/타임아웃/재시도 횟수 ENV로 조절
- 파일잠금(FileLock) + fsync로 CSV 원자성 보강, 동시 접근 방지
- 시간 기록 정책: 직전 값 동일해도 “시(hour)”가 바뀌면 기록
- Playwright tracing (옵션): 마지막 실패 시 trace.zip 생성 (LOG_TRACE=1)
"""

import csv
import os
import re
import sys
import time
import json
import random
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Tuple
from filelock import FileLock, Timeout as LockTimeout
from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PlaywrightTimeoutError,
    Error as PlaywrightError,
)

# ---------- 설정 (ENV로 오버라이드 가능) ----------
TARGET_URL = os.getenv("TARGET_URL", "https://park.yuc.co.kr/views/parkinglot/info/info.html")
ROOT_URL   = os.getenv("ROOT_URL",   "https://park.yuc.co.kr/")
LOT_NAME   = os.getenv("LOT_NAME",   "수지노외 공영주차장")

BASE_DIR = Path(os.getenv("BASE_DIR", str(Path(__file__).resolve().parent.parent)))
CSV_PATH = Path(os.getenv("CSV_PATH", str(BASE_DIR / "parking_log.csv")))
LOCK_PATH = Path(os.getenv("LOCK_PATH", str(CSV_PATH.with_suffix(".lock"))))
ARTIFACT_DIR = Path(os.getenv("ARTIFACT_DIR", str(BASE_DIR / "artifacts")))

RETRIES          = int(os.getenv("RETRIES", "3"))
BACKOFF_BASE_SEC = float(os.getenv("BACKOFF_BASE_SEC", "2"))
NAV_TIMEOUT_MS   = int(os.getenv("NAV_TIMEOUT_MS", "45000"))
WAIT_TIMEOUT_MS  = int(os.getenv("WAIT_TIMEOUT_MS", "30000"))
LOCK_TIMEOUT_SEC = float(os.getenv("LOCK_TIMEOUT_SEC", "20"))

HEADLESS   = os.getenv("HEADFUL", "0") != "1"
BLOCK_RSRC = os.getenv("BLOCK_RESOURCES", "1") == "1"
LOG_JSON   = os.getenv("LOG_JSON", "0") == "1"
LOG_TRACE  = os.getenv("LOG_TRACE", "0") == "1"

KST = timezone(timedelta(hours=9))

# ---------- 로깅 ----------
logger = logging.getLogger("scrape")
logger.setLevel(logging.INFO)

class JsonHandler(logging.StreamHandler):
    def emit(self, record: logging.LogRecord) -> None:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=KST).isoformat(timespec="seconds"),
            "level": record.levelname,
            "msg": record.getMessage(),
            "name": record.name,
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        self.stream.write(json.dumps(payload, ensure_ascii=False) + "\n")

if LOG_JSON:
    handler = JsonHandler(sys.stderr)
else:
    handler = logging.StreamHandler(sys.stderr)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    handler.setFormatter(fmt)
logger.handlers = [handler]

# ---------- CSV 유틸 ----------
def setup_csv() -> None:
    """CSV 파일 초기화 및 헤더 생성"""
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(LOCK_PATH), timeout=LOCK_TIMEOUT_SEC):
            with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(["timestamp_kst", "lot_name", "available"])
                f.flush()
                os.fsync(f.fileno())
        logger.info("CSV 파일 초기화 완료: %s", CSV_PATH)

def get_last_row() -> Optional[Tuple[datetime, int]]:
    """CSV의 마지막 (timestamp_kst, available) 반환"""
    if not CSV_PATH.exists():
        return None
    try:
        with FileLock(str(LOCK_PATH), timeout=LOCK_TIMEOUT_SEC):
            with CSV_PATH.open("r", encoding="utf-8") as f:
                lines = [ln for ln in f.read().strip().splitlines() if ln.strip()]
                if len(lines) < 2:
                    return None
                last_row = lines[-1].split(",")
                ts = datetime.fromisoformat(last_row[0].strip())
                avail = int(last_row[-1].strip())
                return ts, avail
    except Exception as e:
        logger.error("마지막 행 읽기 실패: %s", e)
        return None

def append_csv(ts_str: str, lot_name: str, avail: int) -> None:
    """CSV에 한 줄 원자적으로 추가"""
    with FileLock(str(LOCK_PATH), timeout=LOCK_TIMEOUT_SEC):
        with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([ts_str, lot_name, avail])
            f.flush()
            os.fsync(f.fileno())

# ---------- 파싱 유틸 ----------
PATTERNS = [
    re.compile(r"(잔여|가능|주차가능|빈|가용)[^\d]{0,12}(\d+)"),
    re.compile(r"(\d+)[^\d]{0,5}(잔여|가능|주차가능|빈|가용)"),
    re.compile(r"(\d+)\s*대"),
]

def extract_available(text: str) -> Optional[int]:
    """텍스트에서 주차 가능 대수 추출 (우선순위: 의미 패턴 → 숫자 fallback)"""
    for rx in PATTERNS:
        m = rx.search(text)
        if m:
            # 패턴별 그룹 위치 조정
            if rx.groups == 2 and rx.pattern.startswith("("):
                # 첫 패턴: 그룹2가 숫자
                return int(m.group(2))
            else:
                # 두 번째/세 번째 패턴: 그룹1이 숫자
                return int(m.group(1))
    nums = [int(x) for x in re.findall(r"\d+", text)]
    return min(nums) if nums else None

# ---------- 브라우저/페이지 유틸 ----------
def dump_artifacts(page, tag: str) -> None:
    """실패 시 디버깅 아티팩트 저장"""
    try:
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(ARTIFACT_DIR / f"snap_{tag}.png"), full_page=True)
        (ARTIFACT_DIR / f"dom_{tag}.html").write_text(page.content(), encoding="utf-8")
    except Exception:
        pass

def block_resources_route(route):
    rtype = route.request.resource_type
    if rtype in {"image", "media", "font"}:
        return route.abort()
    return route.continue_()

def http_ok(resp) -> bool:
    try:
        return resp is not None and 200 <= (resp.status or 0) < 400
    except Exception:
        return False

def navigate_to_target(page) -> None:
    """GNB를 통한 페이지 진입 → 실패 시 직접 접근. 응답코드 검증 + 로딩 검증."""
    # 1) 루트로 진입 후 GNB 클릭
    try:
        resp = page.goto(ROOT_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        if not http_ok(resp):
            raise RuntimeError(f"root status {getattr(resp, 'status', 'N/A')}")
        link = page.locator('a:has-text("주차장 안내")')
        if link.count():
            link.first.click(timeout=15_000)
            page.wait_for_load_state("domcontentloaded", timeout=WAIT_TIMEOUT_MS)
    except Exception as e:
        logger.debug("GNB 경유 실패: %s → 직접 URL 진입", e)
        resp = page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        if not http_ok(resp):
            raise RuntimeError(f"target status {getattr(resp, 'status', 'N/A')}")

    # 2) 실데이터 로딩 검증(2중)
    page.wait_for_selector(f"text={LOT_NAME}", timeout=WAIT_TIMEOUT_MS)
    page.wait_for_function(
        """() => {
            const el = document.body.innerText || '';
            return /수지노외\\s*공영주차장/.test(el);
        }""",
        timeout=WAIT_TIMEOUT_MS
    )

def scrape_once(page) -> Tuple[str, int]:
    """단일 스크랩 시도"""
    navigate_to_target(page)

    # LOT_NAME이 포함된 행/카드 컨테이너
    row = page.locator(
        f"tr:has-text('{LOT_NAME}'), li:has-text('{LOT_NAME}'), div:has-text('{LOT_NAME}')"
    ).first
    row.wait_for(timeout=WAIT_TIMEOUT_MS)

    # 빠른 경로: textContent → 실패 시 innerText fallback
    text = row.evaluate("(el)=>el.textContent || ''")
    available = extract_available(text)
    if available is None:
        text = row.evaluate("(el)=>el.innerText || ''")
        available = extract_available(text)

    if available is None:
        # 만일 구조가 바뀐다면, 바디에서 최후 추출
        full_text = page.inner_text("body")
        available = extract_available(full_text)

    if available is None:
        raise RuntimeError("주차 가능 대수 추출 실패")

    ts = datetime.now(KST).isoformat(timespec="seconds")
    return ts, available

def scrape_with_retries() -> Tuple[str, int]:
    """재시도 포함 스크랩(지수 백오프 + 지터 + 아티팩트 저장 + 트레이싱 옵션)"""
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=HEADLESS,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 720}
        )
        context.set_default_timeout(WAIT_TIMEOUT_MS)
        context.set_default_navigation_timeout(NAV_TIMEOUT_MS)

        if BLOCK_RSRC:
            context.route("**/*", block_resources_route)

        if LOG_TRACE:
            try:
                context.tracing.start(screenshots=True, snapshots=True, sources=True)
            except Exception:
                pass

        page = context.new_page()

        last_err: Optional[Exception] = None
        for attempt in range(1, RETRIES + 1):
            try:
                ts, avail = scrape_once(page)
                logger.info("스크랩 성공: available=%d at %s", avail, ts)
                if LOG_TRACE:
                    try:
                        context.tracing.stop(path=str(ARTIFACT_DIR / "trace.zip"))
                    except Exception:
                        pass
                return ts, avail

            except (PlaywrightTimeoutError, PlaywrightError) as e:
                last_err = e
                logger.warning("시도 %d/%d 실패 (네트워크/타임아웃): %s", attempt, RETRIES, e)
            except RuntimeError as e:
                last_err = e
                logger.warning("시도 %d/%d 실패 (데이터 추출): %s", attempt, RETRIES, e)
            except Exception as e:
                last_err = e
                logger.error("시도 %d/%d 실패 (기타): %s", attempt, RETRIES, e)

            # 아티팩트 저장
            try:
                dump_artifacts(page, f"try{attempt}")
            except Exception:
                pass

            # 재시도 준비
            if attempt < RETRIES:
                backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                jitter = backoff * (0.7 + 0.6 * random.random())
                logger.info("재시도 대기: %.1fs (base=%.1f)", jitter, backoff)
                time.sleep(jitter)
                try:
                    navigate_to_target(page)
                except Exception:
                    try:
                        page.close()
                    except Exception:
                        pass
                    page = context.new_page()

        # 모든 시도 실패
        if LOG_TRACE:
            try:
                context.tracing.stop(path=str(ARTIFACT_DIR / "trace.zip"))
            except Exception:
                pass
        try:
            context.close()
        except Exception:
            pass
        browser.close()
        raise last_err or RuntimeError("스크랩 실패: 모든 재시도 소진")

# ---------- 메인 ----------
def main() -> None:
    setup_csv()
    try:
        ts_str, avail = scrape_with_retries()
        now_ts = datetime.fromisoformat(ts_str)

        last_row = get_last_row()
        if last_row is not None:
            last_ts, last_avail = last_row
            # 동일 값이라도 '시(hour)'가 바뀌면 기록
            if last_avail == avail and now_ts.hour == last_ts.hour:
                logger.info("[%s] %s available=%d (변화 없음 & 동일 시간대 → 생략)", ts_str, LOT_NAME, avail)
                return

        append_csv(ts_str, LOT_NAME, avail)
        if last_row is None:
            logger.info("[%s] %s available=%d (최초 기록)", ts_str, LOT_NAME, avail)
        else:
            logger.info("[%s] %s available=%d 기록 완료 (이전=%d, 시=%02d→%02d)",
                        ts_str, LOT_NAME, avail, last_row[1], last_row[0].hour, now_ts.hour)
    except (LockTimeout, Exception) as e:
        logger.error("스크랩 실패: %s", e)
        sys.exit(1)

if __name__ == "__main__":
    main()
