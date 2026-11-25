"""garmin-weight 워크플로의 셸 스텝 테스트 (재검토 SY3, TD1).

워크플로 YAML에서 스텝 본문을 떼어 bash로 실제로 돌린다. 스텝 안의 `python`은 인자만 적는 셸 함수로 바꾼다.
테스트는 표준 라이브러리만 쓰므로 YAML은 파서 없이 들여쓰기로 읽는다.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
SYNC_WORKFLOW = "garmin_weight_sync.yml"
PROBE_WORKFLOW = "garmin_weight_probe.yml"


def find_bash() -> str | None:
    candidates: list[str | None] = [shutil.which("bash")]
    if sys.platform == "win32":
        # PATH의 bash가 WSL 실행기(System32)일 수 있다. Git Bash를 먼저 찾는다.
        candidates = [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe", *candidates]
    for candidate in candidates:
        if candidate and Path(candidate).exists() and "system32" not in candidate.lower():
            return candidate
    return None


BASH = find_bash()


def step_scripts(workflow: str) -> dict[str, str]:
    """{스텝 이름: `run: |` 본문}. 이름 없는 스텝과 `run: >-`처럼 접는 본문은 넣지 않는다."""
    lines = (WORKFLOWS / workflow).read_text(encoding="utf-8").splitlines()
    scripts: dict[str, str] = {}
    name: str | None = None
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if stripped.startswith("- "):
            name = stripped[len("- name:"):].strip() if stripped.startswith("- name:") else None
        if stripped == "run: |" and name:
            key_indent = len(lines[index]) - len(lines[index].lstrip())
            body: list[str] = []
            index += 1
            while index < len(lines) and (not lines[index].strip() or len(lines[index]) - len(lines[index].lstrip()) > key_indent):
                body.append(lines[index])
                index += 1
            indent = min(len(line) - len(line.lstrip()) for line in body if line.strip())
            scripts[name] = "\n".join(line[indent:] for line in body).rstrip() + "\n"
            continue
        index += 1
    return scripts


def step_block(workflow: str, step_name: str) -> str:
    """이름으로 찾은 스텝의 YAML 원문(다음 스텝 전까지)."""
    lines = (WORKFLOWS / workflow).read_text(encoding="utf-8").splitlines()
    start = next(index for index, line in enumerate(lines) if line.strip() == f"- name: {step_name}")
    indent = len(lines[start]) - len(lines[start].lstrip())
    block = [lines[start]]
    for line in lines[start + 1:]:
        if line.strip().startswith("- ") and len(line) - len(line.lstrip()) == indent:
            break
        block.append(line)
    return "\n".join(block)


def step_condition(workflow: str, step_name: str) -> str | None:
    for line in step_block(workflow, step_name).splitlines():
        if line.strip().startswith("if:"):
            return line.strip()[len("if:"):].strip()
    return None


def run_bash(script: str, env: dict[str, str] | None = None, *extra_args: str) -> subprocess.CompletedProcess:
    assert BASH is not None
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "step.sh"
        path.write_text(script, encoding="utf-8", newline="\n")
        return subprocess.run([BASH, *extra_args, str(path)], env={**os.environ, **(env or {})},
                              capture_output=True, text=True, encoding="utf-8", timeout=60)


@unittest.skipUnless(BASH or os.environ.get("CI"), "bash not found")
class SyncStepInputTests(unittest.TestCase):
    """수동 실행 입력이 수집 스텝을 어떻게 지나가는지. 날 수 범위와 날짜의 뜻은 sync_garmin.py가 본다."""

    # 스텝의 python 호출을 인자만 한 줄씩 적는 함수로 바꾼다.
    STUB = "python() { printf 'ARG:%s\\n' \"$@\"; }\n"

    @classmethod
    def setUpClass(cls) -> None:
        if BASH is None:
            raise AssertionError("bash is required in CI")
        cls.script = cls.STUB + step_scripts(SYNC_WORKFLOW)["Sync Garmin aggregates"]

    def run_step(self, backfill_days: str, end_date: str = "") -> tuple[int, list[str], str]:
        done = run_bash(self.script, {"BACKFILL_DAYS": backfill_days, "END_DATE": end_date})
        output = done.stdout + done.stderr
        args = [line[len("ARG:"):] for line in done.stdout.splitlines() if line.startswith("ARG:")]
        return done.returncode, args, output

    def test_valid_inputs_reach_the_script_unchanged(self) -> None:
        script = "garmin-weight/scripts/sync_garmin.py"
        cases = {
            ("3", ""): [script, "--backfill-days", "3"],
            ("1", ""): [script, "--backfill-days", "1"],
            ("60", ""): [script, "--backfill-days", "60"],
            ("30", "2026-10-31"): [script, "--backfill-days", "30", "--date", "2026-10-31"],
            # 61~99와 실제로 없는 날짜·미래 날짜는 스크립트가 거절한다(tests/test_garmin_sync.py).
            ("99", "2026-02-31"): [script, "--backfill-days", "99", "--date", "2026-02-31"],
        }
        for (days, end), expected in cases.items():
            with self.subTest(days=days, end=end):
                code, args, output = self.run_step(days, end)
                self.assertEqual((0, expected), (code, args), output)

    def test_malformed_backfill_days_stop_the_step(self) -> None:
        # 08·09·018·099는 예전 스텝에서 8진수 오류로 검사가 통째로 빠져 보호 없이 스크립트에 넘어갔다.
        for days in ("08", "09", "018", "099", "030", "0", "00", "100", "", " ", "3 ", " 3", "-1", "+3", "1e1", "3.0",
                     "three", "3; echo pwned", "$(echo pwned)", "3\n4"):
            with self.subTest(days=days):
                code, args, output = self.run_step(days)
                self.assertEqual((1, []), (code, args), output)
                self.assertIn("::error::backfill_days must be a whole number from 1 to 60", output)
                self.assertNotIn("pwned", output)
                self.assertNotIn("value too great for base", output)

    def test_malformed_end_date_stops_the_step(self) -> None:
        for end in ("2026-1-5", "20261125", "2026/11/25", "tomorrow", "2026-11-25 ", "2026-11-25; echo pwned",
                    "$(echo pwned)", "2026-11-25\n2026-11-26"):
            with self.subTest(end=end):
                code, args, output = self.run_step("3", end)
                self.assertEqual((1, []), (code, args), output)
                self.assertIn("::error::end_date must be YYYY-MM-DD", output)
                self.assertNotIn("pwned", output)

    def test_step_leaves_the_checks_to_the_script(self) -> None:
        body = step_scripts(SYNC_WORKFLOW)["Sync Garmin aggregates"]
        # 셸 산술과 날짜 계산, 보호 여부 판단은 스크립트로 옮겼다. 되돌아오면 8진수 문제가 다시 생긴다.
        self.assertNotIn("((", body)
        self.assertNotIn("--protect-existing", body)
        self.assertNotIn("date +", body)


class SyncStepConditionTests(unittest.TestCase):
    """수집 워크플로의 스텝 조건(재검토 SY9, SY11). 러너에서는 main의 실행으로만 확인되므로 글자로 고정한다."""

    def test_commit_depends_on_the_sync_step_only(self) -> None:
        # success()로 걸면 수집 뒤의 뒷정리(토큰 암호화, 캐시 저장, 아티팩트)가 실패했을 때 받은 데이터가 버려진다.
        self.assertIn("id: sync", step_block(SYNC_WORKFLOW, "Sync Garmin aggregates"))
        condition = step_condition(SYNC_WORKFLOW, "Commit and push data") or ""
        self.assertIn("steps.sync.outcome == 'success'", condition)
        self.assertIn("github.ref == 'refs/heads/main'", condition)
        self.assertIn("!cancelled()", condition)
        self.assertNotIn("success()", condition)

    def test_token_cache_is_restored_and_saved_on_main_only(self) -> None:
        # 다른 브랜치의 수동 실행이 main의 토큰으로 로그인하면 갱신된 토큰이 저장되지 않아 main의 캐시가 무효가 된다.
        self.assertEqual("github.ref == 'refs/heads/main'", step_condition(SYNC_WORKFLOW, "Restore token cache"))
        self.assertIn("github.ref == 'refs/heads/main'", step_condition(SYNC_WORKFLOW, "Encrypt tokens for the cache") or "")
        self.assertIn("steps.token-encrypt.outputs.save == 'true'", step_condition(SYNC_WORKFLOW, "Save token cache") or "")

    def test_cleanup_steps_run_after_a_failed_sync(self) -> None:
        for name in ("Encrypt tokens for the cache", "Save token cache", "Remove plaintext tokens", "Upload artifacts"):
            with self.subTest(step=name):
                self.assertIn("always()", step_condition(SYNC_WORKFLOW, name) or "")

    def test_probe_uses_its_own_token_cache(self) -> None:
        for name in ("Restore probe token cache", "Save probe token cache"):
            with self.subTest(step=name):
                block = step_block(PROBE_WORKFLOW, name)
                self.assertIn("garmin-tokens-probe-v1-", block)
                self.assertNotIn("garmin-tokens-v1-", block)


@unittest.skipUnless(BASH or os.environ.get("CI"), "bash not found")
class StepSyntaxTests(unittest.TestCase):
    def test_every_multiline_step_parses(self) -> None:
        for workflow in (SYNC_WORKFLOW, PROBE_WORKFLOW):
            scripts = step_scripts(workflow)
            self.assertTrue(scripts, workflow)
            for name, script in scripts.items():
                with self.subTest(workflow=workflow, step=name):
                    self.assertNotIn("${{", script, "expressions belong in env:, not in the script")
                    done = run_bash(script, None, "-n")
                    self.assertEqual(0, done.returncode, done.stderr)

    def test_expected_steps_are_found(self) -> None:
        self.assertLessEqual({"Sync Garmin aggregates", "Decrypt token cache", "Encrypt tokens for the cache",
                              "Commit and push data", "Check auth secrets"}, set(step_scripts(SYNC_WORKFLOW)))
        self.assertLessEqual({"Decrypt token cache", "Encrypt tokens for the probe cache",
                              "Commit results to the probe branch"}, set(step_scripts(PROBE_WORKFLOW)))


if __name__ == "__main__":
    unittest.main()
