#!/usr/bin/env bash
# 퇴근 시간대 장기 수집 세션 (bus_arrival.yml 에서 실행).
#
# GitHub cron 은 수십 분~수 시간씩 밀리거나 누락되므로, 한 번 뜬 실행이 오래 머물며
# "수집 구간(BUS_PUBLISH_SECONDS) → 요약 → 커밋/푸시" 를 세션 종료까지 반복한다.
# 추적 상태는 tracker_state.json 으로 구간 사이에 이어진다.
#
# 환경변수
#   BUS_SESSION_MINUTES  세션 최대 길이(분, 기본 330 · 잡 타임아웃 안쪽으로 제한)
#   BUS_PUBLISH_SECONDS  커밋 주기(초, 기본 300)
#   BUS_WINDOW           수집 시간대 (scrape.py 가 읽음, 기본 16:00-22:00)
set -uo pipefail

BASE=bus-arrival

publish() {
  # Preserve original observations; retention is a separate reviewed operation.
  # Calibration reads completed dates only; no destructive log trimming here.
  python "$BASE/scripts/build_summary.py" || return 1
  python "$BASE/scripts/prepare_publish.py" || return 1
  # 오래된 체크아웃이 최신 로그를 덮어쓴 경우(행 수 감소)에는 커밋하지 않고 세션을 실패시킨다
  if ! python "$BASE/scripts/guard_rows.py" "$BASE"; then
    exit 1
  fi
  git add "$BASE/" || return 1
  if ! git diff --cached --quiet; then
    git commit -q -m "bus: $(date -u +%Y-%m-%dT%H:%M)Z" || return 1
  fi
  # 다른 워크플로우(yuc 등)가 수시로 push 하지만 bus-arrival/ 는 이 세션만 쓴다.
  # 충돌이 나면 조용히 한쪽을 고르지 않고 중단 후 재시도한다(-X theirs 는 오래된 로그로 덮어쓴 전례가 있다).
  local attempt ahead
  for attempt in 1 2 3; do
    ahead=$(git rev-list --count '@{u}..HEAD') || return 1
    [[ $ahead -eq 0 ]] && return 0
    if git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 pull -q --rebase && git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 push -q; then
      return 0
    fi
    git rebase --abort 2>/dev/null || true
    sleep $(( attempt * 3 ))
  done
  echo "::warning::push 실패 — 다음 주기에 다시 시도합니다"
  return 1
}

main() {
  local session_minutes=${BUS_SESSION_MINUTES:-330}
  local publish_seconds=${BUS_PUBLISH_SECONDS:-300}
  (( session_minutes > 340 )) && session_minutes=340
  local deadline=$(( $(date +%s) + session_minutes * 60 ))
  local collected=0

  # 대기열에서 오래 기다린 run 은 오래된 커밋을 체크아웃했을 수 있으므로 시작 시 최신으로 맞춘다
  if ! git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 pull -q --rebase --autostash; then
    echo "::error::최신 브랜치 동기화 실패 — 오래된 상태로 수집하지 않습니다"
    return 1
  fi

  while :; do
    local remaining gate reason wait_s
    remaining=$(( deadline - $(date +%s) ))
    (( remaining > 0 )) || break

    if ! gate=$(python "$BASE/scripts/scrape.py" --gate-only); then
      echo "::error::게이트 판정 실패"
      break
    fi
    reason=$(sed -n 's/^reason=//p' <<<"$gate")
    wait_s=$(sed -n 's/^wait_seconds=//p' <<<"$gate")
    echo "gate: reason=$reason wait_seconds=$wait_s remaining=${remaining}s"

    if [[ $reason == before_window ]]; then
      # 시간대 시작 전에 뜬 실행은 세션 안에서 시작 시각까지 기다린다
      (( wait_s + 1 < remaining )) || break
      sleep $(( wait_s + 1 ))
      continue
    fi
    [[ $reason == ok ]] || break

    # --exit-on-change: 버스를 처음 발견하거나 추적이 끝나면 구간을 끝내 바로 게시한다 (알람 지연 최소화)
    python "$BASE/scripts/scrape.py" --exit-on-change \
      --run-seconds $(( remaining < publish_seconds ? remaining : publish_seconds )) \
      || echo "::warning::scraper 비정상 종료 (exit $?)"
    collected=1
    # Keep unpushed commits and rows on this runner; retry before collecting more.
    # Never continue for hours with an unpublishable dataset and lose it at timeout.
    local failures=0
    until publish; do
      failures=$(( failures + 1 ))
      if (( failures >= 3 )); then
        echo "::error::게시 반복 실패 — 보존용 artifact 확인 필요"
        return 1
      fi
      sleep 15
    done
  done

  if (( collected == 0 )); then
    echo "수집 없음 (reason=${reason:-none})"
  fi
}

main "$@"

