#!/usr/bin/env python3
"""도착 정보 출처 교대 조회 (섞은 주머니 방식) + 출처별 상태.

- 매 조회는 출처 하나만 쓴다. 출처 목록을 무작위로 섞어 한 바퀴에 한 번씩 꺼내고, 다 꺼내면 다시 섞는다.
  그래서 한 출처가 연달아 몰리지 않고 출처마다 호출 수가 1/N 로 줄어든다.
- 꺼낸 출처가 실패하면 같은 조회 안에서 나머지 출처를 무작위 순서로 이어서 시도한다 (대체 경로).
- 공식 API 외 출처는 3회 연속 실패하면 10분 쉰다. 공식 API는 쉬지 않는다
  (runner 교체 판단과 data.go.kr 오류 기록이 공식 API 결과를 기준으로 하기 때문이다).
- 상태는 tracker_state.json 의 "rotation"(주머니), "sources"(출처별 당일 호출·실패·쉬는 시각)에 둔다.
"""
import datetime as dt
import random

OFFICIAL = "official"
KNOWN_SOURCES = (OFFICIAL, "gbis_web", "kakao", "naver")
BACKOFF_FAILS = 3
BACKOFF_SEC = 600


def parse_sources(text):
    """'official,kakao' → ['official', 'kakao']. 모르는 이름이나 빈 목록은 ValueError."""
    names = []
    for part in (text or "").split(","):
        name = part.strip()
        if not name:
            continue
        if name not in KNOWN_SOURCES:
            raise ValueError(f"unknown source: {name}")
        if name not in names:
            names.append(name)
    if not names:
        raise ValueError("no sources")
    return names


def _parse_ts(value):
    try:
        return dt.datetime.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def health(state, name, today):
    """출처 하나의 당일 상태. 날짜가 바뀌면 호출 수만 초기화하고 연속 실패·쉬는 시각은 이어간다."""
    entry = state.setdefault("sources", {}).setdefault(name, {})
    if entry.get("date") != today:
        entry.update(date=today, calls=0, ok=0, fail=0)
    entry.setdefault("consec_fail", 0)
    return entry


def in_backoff(state, name, ts):
    if name == OFFICIAL:
        return False
    until = _parse_ts(state.get("sources", {}).get(name, {}).get("skip_until"))
    return until is not None and ts < until


def plan(state, enabled, ts, rng=random):
    """이번 조회에서 시도할 출처 순서. 첫 항목은 주머니에서 꺼내고, 나머지는 실패 시 대체 순서다."""
    if len(enabled) == 1:
        return list(enabled)
    available = [name for name in enabled if not in_backoff(state, name, ts)] or list(enabled)
    rotation = state.setdefault("rotation", {})
    bag = [name for name in rotation.get("bag", []) if name in enabled]
    first = next((name for name in bag if name in available), None)
    if first is None:
        # 남은 주머니에 쓸 수 있는 출처가 없으면 새로 섞는다 (쉬는 출처는 이번 바퀴에서 빠진다)
        bag = list(enabled)
        rng.shuffle(bag)
        first = next(name for name in bag if name in available)
    bag.remove(first)
    rotation["bag"] = bag
    rest = [name for name in available if name != first]
    rng.shuffle(rest)
    return [first] + rest


def record(state, name, ts, ok, detail=None):
    """출처 1회 시도 결과를 반영한다. detail 은 오류 종류·코드만 담은 dict (URL·원문 없음)."""
    entry = health(state, name, ts.strftime("%Y-%m-%d"))
    entry["calls"] += 1
    if ok:
        entry["ok"] += 1
        entry.update(consec_fail=0, skip_until=None, last_success=ts.isoformat(), last_error=None)
        return entry
    entry["fail"] += 1
    entry["consec_fail"] += 1
    entry["last_error"] = dict(detail or {}) or {"kind": "unknown"}
    if name != OFFICIAL and entry["consec_fail"] >= BACKOFF_FAILS:
        entry["skip_until"] = (ts + dt.timedelta(seconds=BACKOFF_SEC)).isoformat()
    return entry


def summary(state, enabled, ts):
    """status.json 용 출처별 요약."""
    today = ts.strftime("%Y-%m-%d")
    out = {}
    for name in enabled:
        entry = health(state, name, today)
        item = {key: entry.get(key) for key in ("calls", "ok", "fail", "consec_fail", "last_success")}
        if in_backoff(state, name, ts):
            item["skip_until"] = entry.get("skip_until")
        if entry.get("consec_fail") and entry.get("last_error"):
            item["last_error"] = entry["last_error"]
        out[name] = item
    return out
