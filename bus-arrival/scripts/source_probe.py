#!/usr/bin/env python3
"""도착 정보 출처를 이 컴퓨터(GitHub Actions runner)에서 실제로 1회씩 조회해 쓸 수 있는지 기록한다.

로컬 PC(국내망)에서 되는 출처가 runner(해외 IP)에서는 막히거나 다른 응답을 줄 수 있다. runner_diagnostics.py 는
DNS 주소만 남기므로, 여기서는 scrape.py 가 쓰는 조회 함수 그대로 요청·해석까지 해 본다.

판정
- ok: 응답을 받아 해석까지 됐다 (3100 차량 유무와 무관).
- reachable: 접속은 됐지만 지금 쓸 수 있는 값이 아니다 (차량번호 모름, 정류장 전 노선 차량 없음 등).
  운영 중이면 그 조회만 실패로 처리되고 다른 출처로 넘어간다. runner 가 막혔다는 뜻은 아니다.
- failed: 시간 초과·연결 오류·HTTP 오류·응답 형식 오류. runner 에서 막혔거나 응답이 바뀐 것으로 본다.

기록에는 오류 종류·HTTP 상태·시간 초과 단계·소요 시간만 남긴다 (URL·인증키·응답 원문 없음).
공식 API 는 BUS_SERVICE_KEY/SERVICE_KEY 가 있을 때만 1회 부른다 (일일 호출 한도 900회에 비해 무시할 수준).

  python bus-arrival/scripts/source_probe.py --output probe.json [--rounds 3 --gap 20] [--strict]
"""
import argparse
import datetime as dt
import json
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gbis_web  # noqa: E402
import kakao_stop  # noqa: E402
import naver_stop  # noqa: E402
import station_signals  # noqa: E402

STATION_ID = 206000565  # 07511 유라코퍼레이션.SK케미칼 (scrape.STATION_ID)
ROUTE_ID = 204000170  # 3100 (scrape.TARGET_ROUTE_ID)
STA_ORDER = 6

# 접속은 됐고 응답 내용 때문에 이번 값을 못 쓰는 경우 (runner 차단과 구분한다)
CONTENT_KINDS = frozenset({
    "unknown_vehicle", "all_lines_empty", "all_routes_empty", "no_realtime", "not_realtime",
    "collect_status", "invalid_vehicle", "direction_mismatch", "duplicate_direction",
    "line_missing", "route_missing",
})
SOURCES = ("official", "gbis_web", "gbis_web_route", "kakao", "naver")
SAFE_DETAIL_KEYS = ("kind", "phase", "http_status", "result_code", "gateway_code")


def _probe_official(key, plates):
    detail = {}
    result = station_signals.fetch_station_list(key, STATION_ID, ROUTE_ID, STA_ORDER, diagnostics=detail)
    if result is None:
        return None, detail, {}
    return result["info"], detail, {"routes": len(result["routes"])}


def _probe_gbis_web(key, plates):
    detail = {}
    info = gbis_web.fetch_station_info(STATION_ID, ROUTE_ID, STA_ORDER, diagnostics=detail)
    return info, detail, {}


def _probe_gbis_web_route(key, plates):
    detail = {}
    result = gbis_web.fetch_route_positions(ROUTE_ID, diagnostics=detail)
    if result is None:
        return None, detail, {}
    return {"veh_id": None}, detail, {"vehicles": len(result["vehicles"])}


def _probe_kakao(key, plates):
    detail = {}
    result = kakao_stop.fetch_info(plates, diagnostics=detail)
    return (result["info"] if result else None), detail, {}


def _probe_naver(key, plates):
    detail = {}
    result = naver_stop.fetch_info(plates, diagnostics=detail)
    return (result["info"] if result else None), detail, {}


PROBES = {
    "official": _probe_official,
    "gbis_web": _probe_gbis_web,
    "gbis_web_route": _probe_gbis_web_route,
    "kakao": _probe_kakao,
    "naver": _probe_naver,
}


def probe_once(name, key, plates, clock=time.monotonic):
    """출처 하나를 1회 조회한 결과 (민감값 없음)."""
    started = clock()
    try:
        info, detail, extra = PROBES[name](key, plates)
    except Exception:  # 확인 스크립트가 예상 밖 오류로 멈추지 않게 한다
        info, detail, extra = None, {"kind": "unexpected_error"}, {}
    item = {"source": name, "duration_sec": round(clock() - started, 3)}
    if info is not None:
        item["verdict"] = "ok"
        if name != "gbis_web_route":
            item["has_vehicle"] = info.get("veh_id") is not None
            if info.get("predict_sec") is not None:
                item["predict_sec"] = info["predict_sec"]
    else:
        kind = detail.get("kind") or "unknown"
        item["verdict"] = "reachable" if kind in CONTENT_KINDS else "failed"
        item["error"] = {k: detail[k] for k in SAFE_DETAIL_KEYS if k in detail}
        item["error"].setdefault("kind", kind)
    item.update(extra)
    return item


def run(rounds=1, gap=0.0, key=None, plates=None, sources=SOURCES, sleep=time.sleep, clock=time.monotonic):
    rounds_out = []
    for index in range(rounds):
        if index:
            sleep(gap)
        at = dt.datetime.now(dt.timezone.utc).isoformat()
        results = []
        for name in sources:
            if name == "official" and not key:
                results.append({"source": name, "verdict": "skipped", "reason": "no_service_key"})
                continue
            results.append(probe_once(name, key, plates or {}, clock))
        rounds_out.append({"at": at, "results": results})
    return {
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "runner_name": os.getenv("RUNNER_NAME"),
        "run_id": os.getenv("GITHUB_RUN_ID"),
        "rounds": rounds_out,
        "summary": summarize(rounds_out),
    }


def summarize(rounds_out):
    """출처별 판정 횟수와 마지막 오류. 한 번이라도 failed 면 그 출처는 runner 에서 불안정한 것으로 본다."""
    out = {}
    for round_ in rounds_out:
        for item in round_["results"]:
            entry = out.setdefault(item["source"], {"ok": 0, "reachable": 0, "failed": 0, "skipped": 0,
                                                    "max_duration_sec": 0.0})
            entry[item["verdict"]] += 1
            entry["max_duration_sec"] = max(entry["max_duration_sec"], item.get("duration_sec", 0.0))
            if item.get("error"):
                entry["last_error"] = item["error"]
    return out


def describe(name, entry):
    total = entry["ok"] + entry["reachable"] + entry["failed"]
    if entry["skipped"] and not total:
        return f"{name} 건너뜀(인증키 없음)"
    text = f"{name} 성공 {entry['ok']}/{total}"
    if entry["reachable"]:
        text += f", 접속됨·값 없음 {entry['reachable']}"
    if entry["failed"]:
        error = entry.get("last_error") or {}
        codes = ",".join(str(error[k]) for k in ("kind", "phase", "http_status") if k in error)
        text += f", 실패 {entry['failed']} ({codes})"
    return text + f", 최대 {entry['max_duration_sec']:.1f}초"


def failed_sources(report):
    return [name for name, entry in report["summary"].items() if entry["failed"]]


def annotate(report, stream=sys.stdout):
    """GitHub Actions 주석: 실행 화면과 check-run annotations API 에서 바로 보인다."""
    summary = report["summary"]
    stream.write("::notice title=Bus source probe::" + " | ".join(
        describe(name, entry) for name, entry in summary.items()) + "\n")
    for name in failed_sources(report):
        stream.write(f"::warning title=Bus source probe {name}::{describe(name, summary[name])}\n")


def step_summary(report, path):
    lines = ["### 도착 정보 출처 확인 (이 runner)", "", "| 출처 | 성공 | 접속됨·값 없음 | 실패 | 마지막 오류 | 최대 소요 |",
             "| --- | --- | --- | --- | --- | --- |"]
    for name, entry in report["summary"].items():
        error = entry.get("last_error") or {}
        codes = " ".join(f"{k}={error[k]}" for k in ("kind", "phase", "http_status") if k in error) or "-"
        if entry["skipped"] and not (entry["ok"] + entry["reachable"] + entry["failed"]):
            codes = "인증키 없음 (건너뜀)"
        lines.append(f"| {name} | {entry['ok']} | {entry['reachable']} | {entry['failed']} | {codes} | "
                     f"{entry['max_duration_sec']:.1f}초 |")
    with open(path, "a", encoding="utf-8") as stream:
        stream.write("\n".join(lines) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="도착 정보 출처를 1회씩 조회해 runner 에서 쓸 수 있는지 기록")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--rounds", type=int, default=1, help="반복 횟수 (간헐적 실패 확인용)")
    parser.add_argument("--gap", type=float, default=20.0, help="반복 사이 대기(초)")
    parser.add_argument("--predict-log", default="bus-arrival/predict_log.csv",
                        help="카카오·네이버 차량번호 → GBIS vehId 표를 만들 기록")
    parser.add_argument("--strict", action="store_true", help="실패한 출처가 있으면 종료 코드 1")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    # httpx 는 INFO 로 요청 URL 전체(공식 API 는 serviceKey 포함)를 남기므로 경고 이상만 남긴다
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    key = os.getenv("BUS_SERVICE_KEY") or os.getenv("SERVICE_KEY") or None
    plates = kakao_stop.load_plate_map(args.predict_log)
    report = run(max(1, args.rounds), max(0.0, args.gap), key, plates)
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    for name, entry in report["summary"].items():
        print(describe(name, entry))
    if os.getenv("GITHUB_ACTIONS") == "true":
        annotate(report)
        if os.getenv("GITHUB_STEP_SUMMARY"):
            step_summary(report, os.environ["GITHUB_STEP_SUMMARY"])
    failed = failed_sources(report)
    return 1 if args.strict and failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
