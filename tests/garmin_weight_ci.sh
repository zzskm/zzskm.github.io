#!/usr/bin/env bash
# CI에서 unittest를 돌리고, 실패하면 실패한 테스트의 이름을 실행 주석(::error::)으로 남긴다.
# 실행 로그는 GitHub에 로그인해야 볼 수 있지만 주석은 공개 API로 읽을 수 있다.
# 남기는 것은 "FAIL: 테스트 이름 (모듈.클래스.테스트)" 줄뿐이다. 실패 내용(값, 예외 메시지)은 남기지 않는다.
#
# 사용: bash tests/garmin_weight_ci.sh <unittest 인자...>
#   예: bash tests/garmin_weight_ci.sh tests.test_garmin_weight_browser
#       bash tests/garmin_weight_ci.sh discover -s tests -p 'test_garmin*.py'
set -uo pipefail

log="$(mktemp)"
python -m unittest "$@" -v 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  grep -E '^(FAIL|ERROR): ' "$log" | sort -u | head -n 20 | sed 's/^/::error::/' || true
fi
rm -f "$log"
exit "$status"
