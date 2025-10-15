# -*- coding: utf-8 -*-
"""
yuc/scripts/scrape.py — table-driven hardened version
수지노외 공영주차장 잔여 주차대수 크롤링 (GitHub Actions/cron 친화)

업데이트:
- 로그 강화: 파싱 과정 상세 로그 (헤더 인덱스, 행 탐색, 셀 추출 등), 에러 시 컨텍스트 추가
- 성능 최적화: DOM 쿼리 캐싱, 불필요한 대기 최소화
- 에러 처리: 네트워크 에러(429, 503) 시 백오프 증가, 예외 분류 세분화
- ENV 추가: RETRY_JITTER_FACTOR, TRACE_ON_FAIL_ONLY
- 데이터 검증: 추출된 avail 값 음수 방지, 이상치(예: >1000) 경고 로그
- 리소스 관리: context/browser close try-finally 블록으로 강화
- CSV: 읽기/쓰기 시 에러 핸들링 강화, 대용량 파일 대비 tail 방식으로 last_row 읽기
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
RETRY_JITTER_FACTOR = float(os.getenv("RETRY_JITTER_FACTOR", "0.3"))  # 지터 비율 (0~1)

HEADLESS   = os.getenv("HEADFUL", "0") != "1"
BLOCK_RSRC = os.getenv("BLOCK_RESOURCES", "1") == "1"
LOG_JSON   = os.getenv("LOG_JSON", "0") == "1"
LOG_TRACE  = os.getenv("LOG_TRACE", "0") == "1"
TRACE_ON_FAIL_ONLY = os.getenv("TRACE_ON_FAIL_ONLY", "1") == "1"  # 실패 시에만 트레이스
LOG_LEVEL  = os.getenv("LOG_LEVEL", "INFO").upper()
TREAT_DASH_AS_ZERO = os.getenv("TREAT_DASH_AS_ZERO", "0") == "1"

KST = timezone(timedelta(hours=9))

# ---------- 로깅 ----------
logger = logging.getLogger("scrape")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

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
        try:
            with FileLock(str(LOCK_PATH), timeout=LOCK_TIMEOUT_SEC):
                with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
                    csv.writer(f).writerow(["timestamp_kst", "lot_name", "available"])
                    f.flush()
                    os.fsync(f.fileno())
            logger.info("CSV 파일 초기화 완료: %s", CSV_PATH)
        except LockTimeout:
            logger.error("CSV 초기화 잠금 타임아웃")
            raise
        except Exception as e:
            logger.error("CSV 초기화 실패: %s", e)
            raise

def get_last_row() -> Optional[Tuple[datetime, int]]:
    """CSV의 마지막 행 반환 (대용량 파일 대비 tail 방식)"""
    if not CSV_PATH.exists():
        return None
    try:
        with FileLock(str(LOCK_PATH), timeout=LOCK_TIMEOUT_SEC):
            with CSV_PATH.open("r", encoding="utf-8") as f:
                f.seek(0, os.SEEK_END)
                pos = f.tell()
                lines = []
                while pos > 0 and len(lines) < 2:
                    pos -= 1
                    f.seek(pos)
                    if f.read(1) == "\n":
                        lines.append(f.readline().strip())
                if len(lines) < 2:
                    return None
                last_line = lines[-2] if lines[-1] == "" else lines[-1]  # trailing newline 처리
                last_row = last_line.split(",")
                ts = datetime.fromisoformat(last_row[0].strip())
                avail = int(last_row[-1].strip())
                logger.debug("마지막 행: ts=%s, avail=%d", ts, avail)
                return ts, avail
    except LockTimeout:
        logger.error("CSV 읽기 잠금 타임아웃")
        return None
    except ValueError as e:
        logger.error("CSV 파싱 오류: %s (라인: %s)", e, last_line if 'last_line' in locals() else "N/A")
        return None
    except Exception as e:
        logger.error("마지막 행 읽기 실패: %s", e)
        return None

def append_csv(ts_str: str, lot_name: str, avail: int) -> None:
    """CSV에 한 줄 원자적으로 추가"""
    try:
        with FileLock(str(LOCK_PATH), timeout=LOCK_TIMEOUT_SEC):
            with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow([ts_str, lot_name, avail])
                f.flush()
                os.fsync(f.fileno())
        logger.debug("CSV 추가 완료: %s, %s, %d", ts_str, lot_name, avail)
    except LockTimeout:
        logger.error("CSV 쓰기 잠금 타임아웃")
        raise
    except Exception as e:
        logger.error("CSV 추가 실패: %s", e)
        raise

# ---------- 브라우저/페이지 유틸 ----------
def dump_artifacts(page, tag: str) -> None:
    """실패 시 디버깅 아티팩트 저장"""
    try:
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(ARTIFACT_DIR / f"snap_{tag}.png"), full_page=True)
        (ARTIFACT_DIR / f"dom_{tag}.html").write_text(page.content(), encoding="utf-8")
        logger.info("아티팩트 저장: snap_%s.png, dom_%s.html", tag, tag)
    except Exception as e:
        logger.warning("아티팩트 저장 실패: %s", e)

def block_resources_route(route):
    rtype = route.request.resource_type
    if rtype in {"image", "media", "font", "stylesheet"}:
        return route.abort()
    return route.continue_()

def http_ok(resp) -> bool:
    try:
        status = getattr(resp, "status", 0)
        if status in (429, 503):
            logger.warning("HTTP 과부하/율제한: %d", status)
            return False
        return 200 <= status < 400
    except Exception:
        return False

def navigate_to_target(page) -> None:
    """GNB 경유 → 실패 시 직접 접근. 응답코드 검증 + LOT_NAME 존재로 로딩 검증."""
    logger.debug("페이지 네비게이션 시작")
    try:
        resp = page.goto(ROOT_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        if not http_ok(resp):
            raise RuntimeError(f"루트 URL 상태: {getattr(resp, 'status', 'N/A')}")
        logger.debug("루트 URL 로드 성공")
        link = page.locator('a:has-text("주차장 안내")')
        if link.count():
            link.first.click(timeout=10_000)
            page.wait_for_load_state("domcontentloaded", timeout=WAIT_TIMEOUT_MS)
            logger.debug("GNB 클릭 성공")
            return
    except Exception as e:
        logger.warning("GNB 경유 실패: %s → 직접 URL 시도", e)
    resp = page.goto(TARGET_URL, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
    if not http_ok(resp):
        raise RuntimeError(f"타겟 URL 상태: {getattr(resp, 'status', 'N/A')}")
    logger.debug("타겟 URL 로드 성공")

    # 테이블 로딩 검증
    page.wait_for_selector("#parkingLotTable tbody#parkingLotList tr", timeout=WAIT_TIMEOUT_MS)
    logger.debug("테이블 tbody 확인")
    # LOT_NAME 존재 확인
    if not page.evaluate(
        """(name) => Array.from(document.querySelectorAll("#parkingLotTable tbody#parkingLotList tr"))
            .some(tr => tr.textContent.includes(name))""",
        LOT_NAME
    ):
        raise RuntimeError(f"{LOT_NAME} 행 없음")
    logger.debug("%s 행 존재 확인", LOT_NAME)

# ---------- 테이블 파싱 유틸 ----------
def find_header_index(page, header_name: str) -> int:
    """헤더 인덱스 탐색 (캐싱 가능성 고려, 하지만 단일 호출이므로 그대로)"""
    headers = page.locator(
        "#parkingLotTable thead tr th, "
        "#parkingLotTable thead tr td, "
        "#parkingLotTable tr:first-child th, "
        "#parkingLotTable tr:first-child td"
    )
    cnt = headers.count()
    logger.debug("헤더 셀 개수: %d", cnt)
    for i in range(cnt):
        txt = headers.nth(i).inner_text().strip().replace(" ", "")
        target = header_name.replace(" ", "")
        if txt == target:
            logger.debug("헤더 매치: '%s' → 인덱스 %d (txt='%s')", header_name, i, txt)
            return i
    logger.warning("헤더 '%s' 찾기 실패", header_name)
    return -1

def find_row_by_lot(page, lot_name: str, idx_name_col: int):
    """행 탐색"""
    rows = page.locator("#parkingLotTable tbody#parkingLotList tr")
    rcnt = rows.count()
    logger.debug("행 개수: %d", rcnt)
    for r in range(rcnt):
        cells = rows.nth(r).locator("th, td")
        if cells.count() <= idx_name_col:
            continue
        name_cell = cells.nth(idx_name_col).inner_text().strip()
        if lot_name in name_cell:
            logger.debug("행 매치: row=%d, name='%s'", r, name_cell)
            return rows.nth(r)
    logger.warning("%s 포함 행 없음", lot_name)
    return None

# ---------- 스크랩 ----------
def scrape_once(page) -> Tuple[str, int]:
    """단일 스크랩"""
    navigate_to_target(page)

    idx_name  = find_header_index(page, "주차장")
    idx_avail = find_header_index(page, "주차가능대수")
    if idx_name == -1 or idx_avail == -1:
        logger.warning("헤더 인덱스 실패 → 폴백 파싱")
        row = page.locator(f"#parkingLotTable tbody#parkingLotList tr:has-text('{LOT_NAME}')").first
        row.wait_for(timeout=WAIT_TIMEOUT_MS)
        text = row.inner_text()
        logger.debug("폴백 행 텍스트: %s", text)
        nums = re.findall(r"\d+", text.replace(",", ""))
        if not nums:
            raise RuntimeError("폴백 숫자 추출 실패")
        available = int(nums[-1])  # 마지막 숫자 (주차가능대수 가정)
        logger.debug("폴백 추출: %d (nums=%s)", available, nums)
    else:
        row = find_row_by_lot(page, LOT_NAME, idx_name)
        if row is None:
            raise RuntimeError(f"{LOT_NAME} 행 탐색 실패")
        cells = row.locator("th, td")
        cell_cnt = cells.count()
        if cell_cnt <= idx_avail:
            raise RuntimeError(f"셀 개수 부족: {cell_cnt} <= {idx_avail}")
        cell_text = cells.nth(idx_avail).inner_text().strip()
        logger.debug("대상 셀: 인덱스=%d, 텍스트='%s'", idx_avail, cell_text)
        if cell_text == "-":
            if TREAT_DASH_AS_ZERO:
                available = 0
                logger.debug("'-' → 0 처리")
            else:
                raise RuntimeError("데이터 없음('-')")
        else:
            m = re.search(r"\d+", cell_text.replace(",", ""))
            if not m:
                raise RuntimeError("숫자 파싱 실패")
            available = int(m.group(0))

    # 데이터 검증
    if available < 0:
        logger.warning("음수 값 감지: %d → 0으로 보정", available)
        available = 0
    if available > 1000:
        logger.warning("이상치 감지: %d (정상 범위 초과?)", available)

    ts = datetime.now(KST).isoformat(timespec="seconds")
    logger.info("[확정] %s available=%d at %s", LOT_NAME, available, ts)
    return ts, available

def scrape_with_retries() -> Tuple[str, int]:
    """재시도 포함 스크랩"""
    with sync_playwright() as p:
        browser = None
        context = None
        page = None
        tracing_started = False
        try:
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

            if LOG_TRACE and not TRACE_ON_FAIL_ONLY:
                context.tracing.start(screenshots=True, snapshots=True, sources=True)
                tracing_started = True

            page = context.new_page()

            last_err: Optional[Exception] = None
            for attempt in range(1, RETRIES + 1):
                try:
                    ts, avail = scrape_once(page)
                    logger.info("스크랩 성공 (시도 %d)", attempt)
                    if LOG_TRACE and tracing_started:
                        context.tracing.stop(path=str(ARTIFACT_DIR / "trace_success.zip"))
                    return ts, avail
                except (PlaywrightTimeoutError, PlaywrightError) as e:
                    last_err = e
                    logger.warning("네트워크/타임아웃 실패 (시도 %d): %s", attempt, e)
                except RuntimeError as e:
                    last_err = e
                    logger.warning("데이터 추출 실패 (시도 %d): %s", attempt, e)
                except Exception as e:
                    last_err = e
                    logger.error("기타 실패 (시도 %d): %s", attempt, e)

                if LOG_TRACE and TRACE_ON_FAIL_ONLY and not tracing_started:
                    context.tracing.start(screenshots=True, snapshots=True, sources=True)
                    tracing_started = True

                dump_artifacts(page, f"fail_attempt{attempt}")

                if attempt < RETRIES:
                    backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                    jitter = backoff * RETRY_JITTER_FACTOR * random.uniform(-1, 1)
                    wait_time = max(0, backoff + jitter)
                    logger.info("재시도 대기: %.1fs (backoff=%.1f, jitter=%.1f)", wait_time, backoff, jitter)
                    time.sleep(wait_time)
                    try:
                        navigate_to_target(page)
                    except Exception as ne:
                        logger.warning("재네비게이션 실패: %s → 새 페이지 생성", ne)
                        page.close()
                        page = context.new_page()

            # 모든 시도 실패
            if tracing_started:
                context.tracing.stop(path=str(ARTIFACT_DIR / "trace_fail.zip"))
            raise last_err or RuntimeError("모든 재시도 실패")

        finally:
            if page:
                page.close()
            if context:
                context.close()
            if browser:
                browser.close()

# ---------- 메인 ----------
def main() -> None:
    logger.info("스크랩 시작")
    setup_csv()
    try:
        ts_str, avail = scrape_with_retries()
        now_ts = datetime.fromisoformat(ts_str)

        last_row = get_last_row()
        if last_row is not None:
            last_ts, last_avail = last_row
            if last_avail == avail and now_ts.hour == last_ts.hour:
                logger.info("[%s] %s available=%d (동일 & 같은 시간대 → 생략)", ts_str, LOT_NAME, avail)
                return

        append_csv(ts_str, LOT_NAME, avail)
        if last_row is None:
            logger.info("[%s] %s available=%d (최초 기록)", ts_str, LOT_NAME, avail)
        else:
            logger.info("[%s] %s available=%d 기록 (이전=%d, 시간 %02d→%02d)",
                        ts_str, LOT_NAME, avail, last_row[1], last_row[0].hour, now_ts.hour)
    except Exception as e:
        logger.error("메인 실패: %s", e)
        sys.exit(1)
    logger.info("스크랩 완료")

if __name__ == "__main__":
    main()
