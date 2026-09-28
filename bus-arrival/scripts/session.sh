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
  python "$BASE/scripts/trim_logs.py" >/dev/null
  python "$BASE/scripts/build_summary.py"
  git add "$BASE/"
  if ! git diff --cached --quiet; then
    git commit -q -m "bus: $(date -u +%Y-%m-%dT%H:%M)Z"
  fi
  # 다른 워크플로우(yuc 등)가 수시로 push 하므로 rebase 후 재시도한다.
  # 충돌 시 -X theirs: 재적용 중인 이 세션의 데이터 커밋을 우선한다.
  local attempt
  for attempt in 1 2 3 4 5; do
    [[ $(git rev-list --count '@{u}..HEAD') -eq 0 ]] && return 0
    if git pull -q --rebase -X theirs && git push -q; then
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

    python "$BASE/scripts/scrape.py" \
      --run-seconds $(( remaining < publish_seconds ? remaining : publish_seconds )) \
      || echo "::warning::scraper 비정상 종료 (exit $?)"
    collected=1
    publish
  done

  if (( collected == 0 )); then
    echo "수집 없음 (reason=${reason:-none})"
  fi
}

main "$@"
