# -*- coding: utf-8 -*-
"""
수지노외 공영주차장 크롤러 (Playwright + GitHub Actions 최적화)
- 헤더 인덱싱 기반 파싱
- GNB 경유 실패 시 직접 접근
- CSV 기록 (시간대 중복 방지)
- 실패 시 trace/screenshot/html 저장
- 개선: GNB 재진입 로깅, LOT_NAME_REGEX, 폴백, 동적 로딩 대기
"""

import os, csv, sys, time, json, random, logging, re
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Tuple
from filelock import FileLock, Timeout as LockTimeout
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError, Error as PlaywrightError

# === 설정 ===
KST = timezone(timedelta(hours=9))
TARGET_URL = os.getenv("TARGET_URL", "https://park.yuc.co.kr/views/parkinglot/info/info.html")
ROOT_URL = os.getenv("ROOT_URL", "https://park.yuc.co.kr/")
LOT_NAME = os.getenv("LOT_NAME", "수지노외 공영주차장")
LOT_NAME_REGEX = os.getenv("LOT_NAME_REGEX", r"수지\s*노외\s*공영\s*주차장")
BASE_DIR = Path(__file__).resolve().parent.parent
CSV_PATH = BASE_DIR / "parking_log.csv"
LOCK_PATH = CSV_PATH.with_suffix(".lock")
ARTIFACT_DIR = BASE_DIR / "artifacts"
RETRIES = int(os.getenv("RETRIES", "3"))
BACKOFF_BASE_SEC = float(os.getenv("BACKOFF_BASE_SEC", "2"))
RETRY_JITTER_FACTOR = float(os.getenv("RETRY_JITTER_FACTOR", "0.3"))
HEADLESS = os.getenv("HEADFUL", "0") != "1"
WAIT_MS = int(os.getenv("WAIT_MS", "30000"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
TREAT_DASH_AS_ZERO = os.getenv("TREAT_DASH_AS_ZERO", "0") == "1"
FALLBACK_FORCE = os.getenv("FALLBACK_FORCE", "0") == "1"

# === 로깅 ===
logger = logging.getLogger("scrape")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
if os.getenv("LOG_JSON", "0") == "1":
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
    h = JsonHandler(sys.stderr)
else:
    h = logging.StreamHandler(sys.stderr)
    h.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.handlers = [h]

def setup_csv():
    if not CSV_PATH.exists():
        CSV_PATH.parent.mkdir(exist_ok=True, parents=True)
        try:
            with FileLock(str(LOCK_PATH), timeout=10):
                with CSV_PATH.open("w", newline="", encoding="utf-8") as f:
                    csv.writer(f).writerow(["timestamp_kst", "lot_name", "available"])
                    f.flush()
                    os.fsync(f.fileno())
            logger.info("CSV 파일 초기화 완료: %s", CSV_PATH)
        except LockTimeout:
            logger.error("CSV 초기화 잠금 타임아웃")
            raise

def get_last_row() -> Optional[Tuple[datetime, int]]:
    if not CSV_PATH.exists():
        return None
    try:
        with FileLock(str(LOCK_PATH), timeout=10):
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
                last = lines[-2] if lines[-1] == "" else lines[-1]
                row = last.split(",")
                return datetime.fromisoformat(row[0]), int(row[2])
    except Exception as e:
        logger.error("마지막 행 읽기 실패: %s", e)
        return None

def append_csv(ts_str: str, lot_name: str, avail: int):
    try:
        with FileLock(str(LOCK_PATH), timeout=10):
            with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow([ts_str, lot_name, avail])
                f.flush()
                os.fsync(f.fileno())
        logger.debug("CSV 추가 완료: %s, %s, %d", ts_str, lot_name, avail)
    except LockTimeout:
        logger.error("CSV 쓰기 잠금 타임아웃")
        raise

def dump_artifacts(page, tag: str):
    try:
        ARTIFACT_DIR.mkdir(exist_ok=True, parents=True)
        page.screenshot(path=str(ARTIFACT_DIR / f"snap_{tag}.png"), full_page=True)
        (ARTIFACT_DIR / f"dom_{tag}.html").write_text(page.content(), encoding="utf-8")
        logger.info("아티팩트 저장: snap_%s.png, dom_%s.html", tag, tag)
    except Exception as e:
        logger.warning("아티팩트 저장 실패: %s", e)

def http_ok(resp) -> bool:
    if not resp:
        return False
    status = resp.status
    if status in (429, 503):
        logger.warning("HTTP 과부하/율제한: %d", status)
        return False
    return 200 <= status < 400

def navigate(page, attempt: int = 0):
    logger.debug("페이지 네비게이션 시작 (시도 %d)", attempt)
    try:
        logger.debug("GNB 경유 시도 (시도 %d)", attempt)
        r = page.goto(ROOT_URL, timeout=WAIT_MS)
        if http_ok(r):
            logger.debug("루트 URL 로드 성공 (시도 %d)", attempt)
            link = page.locator('a:has-text("주차장 안내")')
            link_count = link.count()
            logger.debug("GNB 링크 수: %d (시도 %d)", link_count, attempt)
            if link_count:
                link.first.click(timeout=10_000)
                page.wait_for_load_state("domcontentloaded", timeout=WAIT_MS)
                logger.debug("GNB 클릭 성공 (시도 %d)", attempt)
                return
            else:
                logger.warning("GNB 링크 없음 (시도 %d) → 직접 URL 시도", attempt)
        else:
            logger.warning("루트 URL 로드 실패 (시도 %d): status=%s → 직접 URL 시도", attempt, r.status if r else "null")
    except Exception as e:
        logger.warning("GNB 경유 실패 (시도 %d): %s → 직접 URL 시도", attempt, e)
    r = page.goto(TARGET_URL, timeout=WAIT_MS)
    if not http_ok(r):
        raise RuntimeError(f"페이지 접근 실패: status={r.status if r else 'null'} (시도 %d)", attempt)
    logger.debug("타겟 URL 로드 성공 (시도 %d)", attempt)
    page.wait_for_selector("#parkingLotTable tbody#parkingLotList tr", timeout=WAIT_MS)
    logger.debug("테이블 tbody 확인 (시도 %d)", attempt)
    page.wait_for_function(
        """() => {
            const tbody = document.querySelector("#parkingLotTable tbody#parkingLotList");
            return tbody && tbody.querySelectorAll("tr").length > 0 && tbody.innerText.trim() !== "";
        }""",
        timeout=WAIT_MS
    )
    logger.debug("테이블 데이터 로딩 확인 (시도 %d)", attempt)

def find_index(page, label: str) -> int:
    headers = page.locator("#parkingLotTable thead tr th")
    cnt = headers.count()
    headers_text = [headers.nth(i).inner_text().strip() for i in range(cnt)]
    logger.debug("헤더 텍스트: %s", headers_text)
    for i, txt in enumerate(headers_text):
        if txt.replace(" ", "") == label.replace(" ", ""):
            logger.debug("헤더 매치: '%s' → 인덱스 %d (txt='%s')", label, i, txt)
            return i
    logger.warning("헤더 '%s' 찾기 실패", label)
    return -1

def scrape_once(page, attempt: int = 0) -> Tuple[str, int]:
    navigate(page, attempt)
    idx_name = find_index(page, "주차장")
    idx_avail = find_index(page, "주차가능대수")
    available = None
    cell_text = None

    if idx_name != -1 and idx_avail != -1 and not FALLBACK_FORCE:
        rows = page.locator("#parkingLotTable tbody#parkingLotList tr")
        rcnt = rows.count()
        logger.debug("행 개수: %d", rcnt)
        pattern = re.compile(LOT_NAME_REGEX, re.IGNORECASE)
        for i in range(min(rcnt, 10)):
            row_text = rows.nth(i).inner_text().strip()
            logger.debug("행 %d 텍스트: %s", i, row_text[:100])
        for i in range(rcnt):
            cells = rows.nth(i).locator("td")
            if cells.count() <= max(idx_name, idx_avail):
                continue
            name_cell = cells.nth(idx_name).inner_text().strip()
            if pattern.search(name_cell):
                logger.debug("행 매치: row=%d, name='%s' (regex='%s')", i, name_cell, LOT_NAME_REGEX)
                cell_text = cells.nth(idx_avail).inner_text().strip()
                logger.debug("대상 셀: 인덱스=%d, 텍스트='%s'", idx_avail, cell_text)
                if cell_text == "-":
                    if TREAT_DASH_AS_ZERO:
                        available = 0
                        logger.debug("'-' → 0 처리")
                    else:
                        raise RuntimeError("데이터 없음('-')")
                else:
                    nums = re.findall(r"\d+", cell_text.replace(",", ""))
                    if not nums:
                        raise RuntimeError(f"숫자 파싱 실패: '{cell_text}'")
                    available = int(nums[0])
                break
    if available is None:
        logger.warning("테이블 파싱 실패 또는 강제 폴백 → 폴백 시도")
        row = page.locator(f"#parkingLotTable tbody#parkingLotList tr:has-text('{LOT_NAME}')").first
        try:
            row.wait_for(timeout=WAIT_MS)
            text = row.inner_text()
            logger.debug("폴백 행 텍스트: %s", text)
            nums = re.findall(r"\d+", text.replace(",", ""))
            if not nums:
                full_text = page.inner_text("body")
                logger.debug("전체 페이지 텍스트 검색 (길이: %d)", len(full_text))
                m = re.search(rf"{LOT_NAME_REGEX}\s*[^\d]*(\d+)", full_text, re.IGNORECASE)
                if m:
                    available = int(m.group(1))
                    logger.debug("전체 페이지 추출: %d", available)
                else:
                    raise RuntimeError("폴백 숫자 추출 실패")
            else:
                available = int(nums[-1])
                logger.debug("폴백 추출: %d (nums=%s)", available, nums)
        except Exception as e:
            logger.warning("폴백 행 탐색 실패: %s", e)
            raise RuntimeError(f"폴백 실패: {str(e)}")

    if available < 0:
        logger.warning("음수 값 감지: %d → 0으로 보정", available)
        available = 0
    if available > 1000:
        logger.warning("이상치 감지: %d (정상 범위 초과?)", available)

    ts = datetime.now(KST).isoformat(timespec="seconds")
    logger.info("[확정] %s available=%d at %s (cell='%s')", LOT_NAME, available, ts, cell_text or "N/A")
    return ts, available

def scrape_with_retries() -> Tuple[str, int]:
    ARTIFACT_DIR.mkdir(exist_ok=True, parents=True)
    with sync_playwright() as p:
        browser = None
        context = None
        page = None
        try:
            browser = p.chromium.launch(headless=HEADLESS, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"])
            context = browser.new_context(user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            page = context.new_page()
            last_err = None
            for attempt in range(1, RETRIES + 1):
                try:
                    ts, avail = scrape_once(page, attempt)
                    logger.info("스크랩 성공 (시도 %d)", attempt)
                    return ts, avail
                except (PlaywrightTimeoutError, PlaywrightError) as e:
                    last_err = e
                    logger.warning("네트워크/타임아웃 실패 (시도 %d): %s", attempt, e)
                    backoff = BACKOFF_BASE_SEC * (2 ** attempt if "429" in str(e) or "503" in str(e) else 2 ** (attempt - 1))
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
                    wait_time = max(0, backoff + jitter)
                    logger.info("재시도 대기: %.1fs (backoff=%.1f, jitter=%.1f)", wait_time, backoff, jitter)
                    time.sleep(wait_time)
                    try:
                        logger.debug("재시도 네비게이션 시작 (시도 %d)", attempt + 1)
                        navigate(page, attempt + 1)
                    except Exception as ne:
                        logger.warning("재네비게이션 실패 (시도 %d): %s → 새 페이지 생성", attempt + 1, ne)
                        page.close()
                        page = context.new_page()
            raise last_err or RuntimeError("모든 시도 실패")
        finally:
            if page:
                page.close()
            if context:
                context.close()
            if browser:
                browser.close()

def main():
    logger.info("스크랩 시작")
    setup_csv()
    try:
        ts_str, avail = scrape_with_retries()
        now = datetime.fromisoformat(ts_str)
        last = get_last_row()
        if last and last[1] == avail and now.hour == last[0].hour:
            logger.info("[%s] %s available=%d (동일 & 같은 시간대 → 생략)", ts_str, LOT_NAME, avail)
            return
        append_csv(ts_str, LOT_NAME, avail)
        logger.info("[%s] %s available=%d 기록", ts_str, LOT_NAME, avail)
    except Exception as e:
        logger.error("메인 실패: %s", e)
        sys.exit(1)
    logger.info("스크랩 완료")

if __name__ == "__main__":
    main()
