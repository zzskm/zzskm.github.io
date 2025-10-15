# -*- coding: utf-8 -*-
"""
수지노외 공영주차장 크롤러 (Playwright + GitHub Actions 최적화)

개선 요약
- 네비게이션: load 대기 대신 domcontentloaded → networkidle → best-effort 순차 시도(goto_safely)
- 리소스 차단: font/image/stylesheet/media 차단으로 타임아웃 완화
- 아티팩트: 스크린샷 timeout 단축, full_page 비활성화 (폰트대기 방지)
- 파싱: 헤더 인덱스 기반으로 해당 셀만 파싱(요금/주소 숫자 오탐 제거)
- 폴백: 헤더 탐색 실패해도 행의 5번째 셀(td[4])에서만 숫자 추출
- CSV: 마지막 줄이 개행으로 끝나는 경우도 안전하게 tail 읽기
- 기록 규칙: 이전 available과 같고 같은 hour면 건너뜀. hour 달라지면 값 같아도 기록
"""

import os, csv, sys, time, json, random, logging, re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Tuple
from filelock import FileLock, Timeout as LockTimeout
from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PlaywrightTimeoutError,
    Error as PlaywrightError,
)

# ============ 설정 ============
KST = timezone(timedelta(hours=9))

TARGET_URL = os.getenv("TARGET_URL", "https://park.yuc.co.kr/views/parkinglot/info/info.html")
ROOT_URL   = os.getenv("ROOT_URL",   "https://park.yuc.co.kr/")
LOT_NAME   = os.getenv("LOT_NAME",   "수지노외 공영주차장")
LOT_NAME_REGEX = os.getenv("LOT_NAME_REGEX", r"수지\s*노외\s*공영\s*주차장")

BASE_DIR  = Path(__file__).resolve().parent.parent
CSV_PATH  = BASE_DIR / "parking_log.csv"
LOCK_PATH = CSV_PATH.with_suffix(".lock")
ARTIFACT_DIR = BASE_DIR / "artifacts"

RETRIES            = int(os.getenv("RETRIES", "3"))
BACKOFF_BASE_SEC   = float(os.getenv("BACKOFF_BASE_SEC", "2"))
RETRY_JITTER_FACTOR= float(os.getenv("RETRY_JITTER_FACTOR", "0.3"))

HEADLESS = os.getenv("HEADFUL", "0") != "1"
WAIT_MS  = int(os.getenv("WAIT_MS", "45000"))      # selector/일반 대기
NAV_TIMEOUT_MS = int(os.getenv("NAV_TIMEOUT_MS", str(WAIT_MS)))  # nav 전용

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_JSON  = os.getenv("LOG_JSON", "1") == "1"

TREAT_DASH_AS_ZERO = os.getenv("TREAT_DASH_AS_ZERO", "0") == "1"
FALLBACK_FORCE     = os.getenv("FALLBACK_FORCE", "0") == "1"

# ============ 로깅 ============
logger = logging.getLogger("scrape")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))

if LOG_JSON:
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
    handler = JsonHandler(sys.stderr)
else:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

logger.handlers = [handler]

# ============ CSV 유틸 ============
def setup_csv() -> None:
    """CSV 초기화(헤더)"""
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(LOCK_PATH), timeout=10):
            with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
                csv.writer(f).writerow(["timestamp_kst", "lot_name", "available"])
                f.flush()
                os.fsync(f.fileno())
        logger.info("CSV 파일 초기화 완료: %s", CSV_PATH)

def get_last_row() -> Optional[Tuple[datetime, int]]:
    """
    CSV 마지막 유효 라인을 안전하게 읽어서 (timestamp, available) 반환.
    - 파일 끝이 개행으로 끝나도 OK
    - 빈 줄/깨진 줄 스킵
    """
    if not CSV_PATH.exists():
        return None
    try:
        with FileLock(str(LOCK_PATH), timeout=10):
            with CSV_PATH.open("rb") as f:
                f.seek(0, os.SEEK_END)
                end = f.tell()
                if end == 0:
                    return None
                pos = end
                buffer = b""
                lines_found = 0
                last_valid = None
                # 뒤에서 앞으로 훑으며 최대 5개 후보 스캔
                while pos > 0 and lines_found < 5:
                    pos -= 1
                    f.seek(pos)
                    ch = f.read(1)
                    if ch == b"\n":
                        line = buffer[::-1].decode("utf-8", errors="ignore").strip()
                        buffer = b""
                        if line:
                            parts = line.split(",")
                            if len(parts) >= 3:
                                ts_str = parts[0].strip()
                                avail_str = parts[-1].strip()
                                try:
                                    ts = datetime.fromisoformat(ts_str)
                                    avail = int(avail_str)
                                    last_valid = (ts, avail)
                                    break
                                except Exception:
                                    pass
                        lines_found += 1
                    else:
                        buffer += ch
                # 파일의 첫 줄 포함 처리
                if last_valid is None and buffer:
                    line = buffer[::-1].decode("utf-8", errors="ignore").strip()
                    if line:
                        parts = line.split(",")
                        if len(parts) >= 3:
                            try:
                                ts = datetime.fromisoformat(parts[0].strip())
                                avail = int(parts[-1].strip())
                                last_valid = (ts, avail)
                            except Exception:
                                pass
        return last_valid
    except LockTimeout:
        logger.warning("CSV 읽기 잠금 타임아웃")
        return None
    except Exception as e:
        logger.warning("CSV 마지막 행 읽기 실패: %s", e)
        return None

def append_csv(ts_str: str, lot_name: str, avail: int) -> None:
    with FileLock(str(LOCK_PATH), timeout=10):
        with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow([ts_str, lot_name, avail])
            f.flush()
            os.fsync(f.fileno())
    logger.debug("CSV 추가: %s, %s, %d", ts_str, lot_name, avail)

# ============ 아티팩트 ============
def dump_artifacts(page, tag: str) -> None:
    try:
        ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
        page.screenshot(
            path=str(ARTIFACT_DIR / f"snap_{tag}.png"),
            full_page=False,
            timeout=5000  # 폰트 대기 타임아웃 회피
        )
        (ARTIFACT_DIR / f"dom_{tag}.html").write_text(page.content(), encoding="utf-8")
        logger.info("아티팩트 저장: snap_%s.png, dom_%s.html", tag, tag)
    except Exception as e:
        logger.warning("아티팩트 저장 실패: %s", e)

# ============ 네비게이션 유틸 ============
def http_ok(resp) -> bool:
    if not resp:
        return False
    st = getattr(resp, "status", 0)
    if st in (429, 503):
        logger.warning("HTTP 과부하/율제한: %d", st)
        return False
    return 200 <= st < 400

def goto_safely(page, url: str, timeout_ms: int) -> None:
    """DOMContentLoaded → networkidle → best-effort 순으로 네비게이션."""
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        return
    except PlaywrightTimeoutError:
        pass
    try:
        page.goto(url, wait_until="networkidle", timeout=timeout_ms)
        return
    except PlaywrightTimeoutError:
        pass
    page.goto(url, timeout=timeout_ms)
    page.wait_for_timeout(800)

def navigate(page, attempt: int = 0):
    logger.debug("페이지 네비게이션 시작 (시도 %d)", attempt)
    # 1) 루트 → GNB
    try:
        logger.debug("GNB 경유 시도 (시도 %d)", attempt)
        goto_safely(page, ROOT_URL, NAV_TIMEOUT_MS)
        link = page.locator('a:has-text("주차장 안내")')
        if link.count():
            link.first.click(timeout=10_000)
            page.wait_for_load_state("domcontentloaded", timeout=WAIT_MS)
            logger.debug("GNB 클릭 성공 (시도 %d)", attempt)
            page.wait_for_selector("#parkingLotTable tbody#parkingLotList tr", timeout=WAIT_MS)
            return
        logger.warning("GNB 링크 없음 (시도 %d) → 직접 URL 시도", attempt)
    except Exception as e:
        logger.warning("GNB 경유 실패 (시도 %d): %s → 직접 URL 시도", attempt, e)

    # 2) 직접 URL
    goto_safely(page, TARGET_URL, NAV_TIMEOUT_MS)
    page.wait_for_selector("#parkingLotTable tbody#parkingLotList tr", timeout=WAIT_MS)

# ============ 파싱 유틸 ============
def find_index(page, label: str) -> int:
    headers = page.locator("#parkingLotTable thead tr th, #parkingLotTable thead tr td")
    cnt = headers.count()
    texts = [headers.nth(i).inner_text().strip() for i in range(cnt)]
    logger.debug("헤더 텍스트: %s", texts)
    for i, t in enumerate(texts):
        if t.replace(" ", "") == label.replace(" ", ""):
            logger.debug("헤더 매치: '%s' → %d", label, i)
            return i
    logger.warning("헤더 '%s' 찾기 실패", label)
    return -1

# ============ 스크랩 ============
def scrape_once(page, attempt: int = 0) -> Tuple[str, int]:
    navigate(page, attempt)

    idx_name  = find_index(page, "주차장")
    idx_avail = find_index(page, "주차가능대수")

    available = None
    cell_text = None
    name_pat = re.compile(LOT_NAME_REGEX, re.IGNORECASE)

    if idx_name != -1 and idx_avail != -1 and not FALLBACK_FORCE:
        rows = page.locator("#parkingLotTable tbody#parkingLotList tr")
        rcnt = rows.count()
        logger.debug("행 개수: %d", rcnt)
        for r in range(rcnt):
            cells = rows.nth(r).locator("th, td")
            if cells.count() <= max(idx_name, idx_avail):
                continue
            name_cell = cells.nth(idx_name).inner_text().strip()
            if name_pat.search(name_cell):
                cell_text = cells.nth(idx_avail).inner_text().strip()
                logger.debug("대상 셀 텍스트='%s'", cell_text)
                if cell_text == "-":
                    if TREAT_DASH_AS_ZERO:
                        available = 0
                    else:
                        raise RuntimeError("데이터 없음('-')")
                else:
                    m = re.search(r"\d+", cell_text.replace(",", ""))
                    if not m:
                        raise RuntimeError(f"숫자 파싱 실패: '{cell_text}'")
                    available = int(m.group(0))
                break

    # 폴백: 헤더 인덱스 실패 시에도 5번째 셀(td[4])만 본다(요금 숫자 오탐 방지)
    if available is None:
        logger.warning("테이블 파싱 실패 또는 강제 폴백 → 폴백 시도")
        row = page.locator(f"#parkingLotTable tbody#parkingLotList tr:has(a:has-text('{LOT_NAME}')), #parkingLotTable tbody#parkingLotList tr:has-text('{LOT_NAME}')").first
        row.wait_for(timeout=WAIT_MS)
        cells = row.locator("th, td")
        if cells.count() < 5:
            raise RuntimeError("폴백: 셀 개수 부족")
        cell_text = cells.nth(4).inner_text().strip()
        if cell_text == "-":
            if TREAT_DASH_AS_ZERO:
                available = 0
            else:
                raise RuntimeError("폴백: 데이터 없음('-')")
        else:
            m = re.search(r"\d+", cell_text.replace(",", ""))
            if not m:
                raise RuntimeError(f"폴백: 숫자 파싱 실패 '{cell_text}'")
            available = int(m.group(0))
        logger.debug("폴백 추출: %d (cell='%s')", available, cell_text)

    # 데이터 검증
    if available < 0:
        logger.warning("음수 값 감지: %d → 0으로 보정", available)
        available = 0
    if available > 1000:  # 상한 가드
        logger.warning("이상치 감지: %d (비정상 범위)", available)

    ts = datetime.now(KST).isoformat(timespec="seconds")
    logger.info("[확정] %s available=%d at %s (cell='%s')", LOT_NAME, available, ts, cell_text or "N/A")
    return ts, available

def scrape_with_retries() -> Tuple[str, int]:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = None
        context = None
        page = None
        try:
            browser = p.chromium.launch(
                headless=HEADLESS,
                args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
            )
            context = browser.new_context(
                user_agent=("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
                ignore_https_errors=True,
                viewport={"width": 1280, "height": 720},
            )
            # 리소스 차단으로 타임아웃 완화
            def _block(route):
                rt = route.request.resource_type
                if rt in {"font", "image", "stylesheet", "media"}:
                    return route.abort()
                return route.continue_()
            context.route("**/*", _block)

            page = context.new_page()

            last_err: Optional[Exception] = None
            for attempt in range(1, RETRIES + 1):
                try:
                    ts, avail = scrape_once(page, attempt)
                    logger.info("스크랩 성공 (시도 %d)", attempt)
                    return ts, avail

                except (PlaywrightTimeoutError, PlaywrightError) as e:
                    last_err = e
                    logger.warning("네트워크/타임아웃 실패 (시도 %d): %s", attempt, e)
                    backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                except RuntimeError as e:
                    last_err = e
                    logger.warning("데이터 추출 실패 (시도 %d): %s", attempt, e)
                    backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                except Exception as e:
                    last_err = e
                    logger.error("기타 실패 (시도 %d): %s", attempt, e)
                    backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))

                dump_artifacts(page, f"fail{attempt}")

                if attempt < RETRIES:
                    jitter = backoff * RETRY_JITTER_FACTOR * random.uniform(-1, 1)
                    wait_time = max(0.0, backoff + jitter)
                    logger.info("재시도 대기: %.1fs (backoff=%.1f, jitter=%.1f)", wait_time, backoff, jitter)
                    time.sleep(wait_time)
                    try:
                        logger.debug("재시도 네비게이션 시작 (시도 %d)", attempt + 1)
                        navigate(page, attempt + 1)
                    except Exception as ne:
                        logger.warning("재네비게이션 실패 (시도 %d): %s → 새 페이지 생성", attempt + 1, ne)
                        try:
                            page.close()
                        except Exception:
                            pass
                        page = context.new_page()

            raise last_err or RuntimeError("모든 재시도 실패")

        finally:
            try:
                if page:
                    page.close()
            finally:
                try:
                    if context:
                        context.close()
                finally:
                    if browser:
                        browser.close()

# ============ 메인 ============
def main():
    logger.info("스크랩 시작")
    setup_csv()
    try:
        ts_str, avail = scrape_with_retries()
        now = datetime.fromisoformat(ts_str)

        last = get_last_row()
        if last is None:
            logger.info("[%s] %s available=%d (최초 기록)", ts_str, LOT_NAME, avail)
            append_csv(ts_str, LOT_NAME, avail)
            logger.info("스크랩 완료")
            return

        last_ts, last_avail = last
        same_value = (last_avail == avail)
        same_hour  = (now.hour == last_ts.hour)

        if same_value and same_hour:
            logger.info("[%s] %s available=%d (동일 값 & 동일 시간대 → 생략)", ts_str, LOT_NAME, avail)
            return
        elif same_value and not same_hour:
            logger.info("[%s] %s available=%d (값 동일하지만 시간대 변경 → 기록)", ts_str, LOT_NAME, avail)

        append_csv(ts_str, LOT_NAME, avail)
        logger.info("[%s] %s available=%d 기록 완료", ts_str, LOT_NAME, avail)

    except Exception as e:
        logger.error("메인 실패: %s", e)
        sys.exit(1)

    logger.info("스크랩 완료")

if __name__ == "__main__":
    main()
