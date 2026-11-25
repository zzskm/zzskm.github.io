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


def run_bash(script: str, env: dict[str, str] | None = None, *extra_args: str,
             cwd: Path | None = None) -> subprocess.CompletedProcess:
    assert BASH is not None
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "step.sh"
        path.write_text(script, encoding="utf-8", newline="\n")
        return subprocess.run([BASH, *extra_args, str(path)], env={**os.environ, **(env or {})}, cwd=cwd,
                              capture_output=True, text=True, encoding="utf-8", timeout=120)


def posix(path: Path) -> str:
    """bash와 Windows용 openssl·git이 모두 읽는 경로(C:/…)."""
    return str(path).replace("\\", "/")


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


@unittest.skipUnless(BASH or os.environ.get("CI"), "bash not found")
class TokenStepTests(unittest.TestCase):
    """토큰 캐시 스텝(재검토 TD1). 암호화와 복호화가 서로 맞는지, 키가 없거나 틀릴 때, 토큰이 그대로일 때를 본다.

    스텝 본문을 그대로 돌린다. 로컬(Git Bash)에 jq가 없으면 같은 검사를 하는 셸 함수로 대신한다. CI는 실제 jq를 쓴다.
    """

    JQ_STUB = (
        "command -v jq >/dev/null 2>&1 || "
        "jq() { grep -q '\"di_token\"' \"$3\" && grep -q '\"di_refresh_token\"' \"$3\"; }\n"
    )
    TOKENS = '{"di_token": "access-1", "di_refresh_token": "refresh-1", "di_client_id": "client"}\n'
    STEPS = ((SYNC_WORKFLOW, "Encrypt tokens for the cache"), (PROBE_WORKFLOW, "Encrypt tokens for the probe cache"))

    def run_step(self, workflow: str, name: str, runner_temp: Path, **env: str) -> subprocess.CompletedProcess:
        script = self.JQ_STUB + step_scripts(workflow)[name]
        return run_bash(script, {"RUNNER_TEMP": posix(runner_temp), "GITHUB_ENV": posix(runner_temp / "github_env"),
                                 "GITHUB_OUTPUT": posix(runner_temp / "github_output"), "BAD_KEY": "false", **env})

    @staticmethod
    def read(path: Path) -> str:
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def encrypt(self, workflow: str, step: str, runner_temp: Path, key: str = "key-1") -> subprocess.CompletedProcess:
        return self.run_step(workflow, step, runner_temp, GARMIN_TOKEN_KEY=key,
                             GARMIN_TOKEN_DIR=posix(runner_temp / "garmin-tokens"))

    def test_saved_tokens_come_back_on_the_next_run(self) -> None:
        for workflow, encrypt_step in self.STEPS:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as tmp:
                first, second = Path(tmp) / "run1", Path(tmp) / "run2"
                (first / "garmin-tokens").mkdir(parents=True)
                second.mkdir()
                (first / "garmin-tokens" / "garmin_tokens.json").write_text(self.TOKENS, encoding="utf-8", newline="\n")

                done = self.encrypt(workflow, encrypt_step, first)
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                encrypted = first / "garmin-token-cache" / "garmin_tokens.json.enc"
                self.assertTrue(encrypted.is_file())
                self.assertNotIn(b"refresh-1", encrypted.read_bytes())
                self.assertIn("save=true", self.read(first / "github_output"))

                # 다음 실행의 러너에는 캐시만 있다.
                shutil.copytree(first / "garmin-token-cache", second / "garmin-token-cache")
                done = self.run_step(workflow, "Decrypt token cache", second, GARMIN_TOKEN_KEY="key-1")
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                restored = second / "garmin-tokens" / "garmin_tokens.json"
                self.assertEqual(self.TOKENS, self.read(restored))
                self.assertEqual(f"GARMIN_TOKEN_DIR={posix(second)}/garmin-tokens\n", self.read(second / "github_env"))

                # 토큰이 그대로면 다시 저장하지 않는다. 바뀌었으면 저장한다.
                done = self.encrypt(workflow, encrypt_step, second)
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                self.assertNotIn("save=true", self.read(second / "github_output"))
                restored.write_text(self.TOKENS.replace("access-1", "access-2"), encoding="utf-8", newline="\n")
                done = self.encrypt(workflow, encrypt_step, second)
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                self.assertIn("save=true", self.read(second / "github_output"))

    def test_a_wrong_key_falls_back_without_a_token_file(self) -> None:
        for workflow, encrypt_step in self.STEPS:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as tmp:
                first, second = Path(tmp) / "run1", Path(tmp) / "run2"
                (first / "garmin-tokens").mkdir(parents=True)
                second.mkdir()
                (first / "garmin-tokens" / "garmin_tokens.json").write_text(self.TOKENS, encoding="utf-8", newline="\n")
                self.assertEqual(0, self.encrypt(workflow, encrypt_step, first).returncode)
                shutil.copytree(first / "garmin-token-cache", second / "garmin-token-cache")

                done = self.run_step(workflow, "Decrypt token cache", second, GARMIN_TOKEN_KEY="another-key")
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                restored = second / "garmin-tokens" / "garmin_tokens.json"
                # 틀린 키는 거의 항상 복호화 오류다. 256번에 한 번쯤은 채움 검사를 지나 쓰레기 값이 나온다.
                # 어느 쪽이든 평문 토큰이 복원되면 안 된다.
                self.assertNotEqual(self.TOKENS, self.read(restored))
                if not restored.exists():
                    self.assertIn("::warning::garmin token cache could not be decrypted; using password", done.stdout)
                # 로그인은 비밀번호로 하고, 새 토큰은 이 디렉터리에 쓴다.
                self.assertIn("GARMIN_TOKEN_DIR=", self.read(second / "github_env"))

    def test_probe_can_decrypt_with_a_wrong_key_on_purpose(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            first, second = Path(tmp) / "run1", Path(tmp) / "run2"
            (first / "garmin-tokens").mkdir(parents=True)
            second.mkdir()
            (first / "garmin-tokens" / "garmin_tokens.json").write_text(self.TOKENS, encoding="utf-8", newline="\n")
            self.assertEqual(0, self.encrypt(PROBE_WORKFLOW, "Encrypt tokens for the probe cache", first).returncode)
            shutil.copytree(first / "garmin-token-cache", second / "garmin-token-cache")
            done = self.run_step(PROBE_WORKFLOW, "Decrypt token cache", second, GARMIN_TOKEN_KEY="key-1", BAD_KEY="true")
            self.assertEqual(0, done.returncode, done.stdout + done.stderr)
            self.assertIn("::notice::probe decrypting with a wrong key on purpose", done.stdout)
            self.assertNotEqual(self.TOKENS, self.read(second / "garmin-tokens" / "garmin_tokens.json"))

    def test_without_a_key_or_a_cache_the_step_does_nothing(self) -> None:
        for workflow, _ in self.STEPS:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as tmp:
                runner_temp = Path(tmp)
                done = self.run_step(workflow, "Decrypt token cache", runner_temp, GARMIN_TOKEN_KEY="")
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                self.assertEqual("", self.read(runner_temp / "github_env"))
                self.assertFalse((runner_temp / "garmin-tokens").exists())
                # 키는 있지만 캐시가 아직 없다(첫 실행): 토큰 디렉터리만 정해 둔다.
                done = self.run_step(workflow, "Decrypt token cache", runner_temp, GARMIN_TOKEN_KEY="key-1")
                self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                self.assertIn("GARMIN_TOKEN_DIR=", self.read(runner_temp / "github_env"))
                self.assertFalse((runner_temp / "garmin-tokens" / "garmin_tokens.json").exists())

    def test_incomplete_tokens_are_not_saved(self) -> None:
        for workflow, encrypt_step in self.STEPS:
            with self.subTest(workflow=workflow), tempfile.TemporaryDirectory() as tmp:
                runner_temp = Path(tmp)
                (runner_temp / "garmin-tokens").mkdir()
                # 로그인 도중에 끊겨 리프레시 토큰이 없는 파일, 그리고 파일이 아예 없는 경우.
                for content in ('{"di_token": "access-1"}\n', None):
                    target = runner_temp / "garmin-tokens" / "garmin_tokens.json"
                    if content is None:
                        target.unlink()
                    else:
                        target.write_text(content, encoding="utf-8", newline="\n")
                    done = self.encrypt(workflow, encrypt_step, runner_temp)
                    self.assertEqual(0, done.returncode, done.stdout + done.stderr)
                    self.assertFalse((runner_temp / "garmin-token-cache").exists())
                    self.assertNotIn("save=true", self.read(runner_temp / "github_output"))


@unittest.skipUnless((BASH and shutil.which("git")) or os.environ.get("CI"), "bash and git are required")
class CommitStepTests(unittest.TestCase):
    """데이터 커밋 스텝(재검토 TD1). 임시 저장소 둘(원격과 작업 폴더)을 만들어 스텝 본문을 그대로 돌린다."""

    FILES = ("garmin-weight/data/daily_metrics.csv", "garmin-weight/data/summary.json")
    # 사용자의 git 설정(서명, 훅 등)이 섞이지 않게 한다.
    GIT_ENV = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}
    # 테스트가 저장소를 준비할 때만 쓰는 이름. 스텝에는 넘기지 않는다(스텝은 git config로 봇의 이름을 정한다).
    IDENTITY = {"GIT_AUTHOR_NAME": "tester", "GIT_AUTHOR_EMAIL": "tester@example.invalid",
                "GIT_COMMITTER_NAME": "tester", "GIT_COMMITTER_EMAIL": "tester@example.invalid"}

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.origin = self.tmp / "origin.git"
        self.git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.origin))
        seed = self.clone("seed", fresh=True)
        self.write_data(seed, "v1")
        self.git(seed, "add", "-A")
        self.git(seed, "commit", "-q", "-m", "seed")
        self.git(seed, "push", "-q", "origin", "HEAD:main")
        self.work = self.clone("work")
        self.script = "sleep() { :; }\n" + step_scripts(SYNC_WORKFLOW)["Commit and push data"]

    def git(self, cwd: Path, *args: str) -> str:
        done = subprocess.run(["git", *args], cwd=cwd, env={**os.environ, **self.GIT_ENV, **self.IDENTITY}, capture_output=True, text=True,
                              encoding="utf-8", timeout=60)
        self.assertEqual(0, done.returncode, f"git {' '.join(args)}: {done.stderr}")
        return done.stdout.strip()

    def clone(self, name: str, fresh: bool = False) -> Path:
        target = self.tmp / name
        if fresh:
            self.git(self.tmp, "init", "-q", "-b", "main", str(target))
            self.git(target, "remote", "add", "origin", posix(self.origin))
        else:
            self.git(self.tmp, "clone", "-q", posix(self.origin), str(target))
        return target

    def write_data(self, repo: Path, marker: str) -> None:
        for name in self.FILES:
            target = repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"{marker} {Path(name).name}\n", encoding="utf-8", newline="\n")

    def run_step(self, attempts: str = "5") -> subprocess.CompletedProcess:
        runner_temp = self.tmp / "runner"
        runner_temp.mkdir(exist_ok=True)
        return run_bash(self.script, {**self.GIT_ENV, "RUNNER_TEMP": posix(runner_temp), "DATA_FILES": " ".join(self.FILES),
                                      "MAX_ATTEMPTS": attempts}, cwd=self.work)

    def origin_file(self, name: str) -> str:
        return self.git(self.origin, "show", f"main:{name}")

    def test_nothing_to_commit(self) -> None:
        before = self.git(self.origin, "rev-parse", "main")
        done = self.run_step()
        self.assertEqual(0, done.returncode, done.stdout + done.stderr)
        self.assertIn("No data changes to commit.", done.stdout)
        self.assertEqual(before, self.git(self.origin, "rev-parse", "main"))

    def test_changed_data_is_committed_by_the_bot(self) -> None:
        self.write_data(self.work, "v2")
        done = self.run_step()
        self.assertEqual(0, done.returncode, done.stdout + done.stderr)
        self.assertIn("Push succeeded on attempt 1.", done.stdout)
        self.assertEqual("v2 summary.json", self.origin_file(self.FILES[1]))
        self.assertEqual("chore: update garmin weight data|github-actions[bot]",
                         self.git(self.origin, "log", "-1", "--format=%s|%an", "main"))
        self.assertEqual(sorted(self.FILES), sorted(self.git(self.origin, "show", "--name-only", "--format=", "main").splitlines()))

    def test_push_is_retried_on_top_of_a_main_that_moved(self) -> None:
        # 수집하는 사이에 다른 커밋(버스 봇 등)이 main에 올라갔다. 같은 데이터 파일을 건드린 커밋도 있다.
        other = self.clone("other")
        (other / "bus.txt").write_text("bus\n", encoding="utf-8")
        self.write_data(other, "stale")
        self.git(other, "add", "-A")
        self.git(other, "commit", "-q", "-m", "someone else")
        self.git(other, "push", "-q", "origin", "HEAD:main")

        self.write_data(self.work, "v2")
        done = self.run_step()
        self.assertEqual(0, done.returncode, done.stdout + done.stderr)
        self.assertIn("Push failed on attempt 1; re-applying data files on the latest main.", done.stdout)
        self.assertIn("Push succeeded on attempt 2.", done.stdout)
        # 남의 커밋은 그대로 있고, 데이터 파일은 방금 받은 것이다.
        self.assertEqual("bus", self.origin_file("bus.txt"))
        self.assertEqual(["v2 daily_metrics.csv", "v2 summary.json"], [self.origin_file(name) for name in self.FILES])
        self.assertEqual(["chore: update garmin weight data", "someone else", "seed"],
                         self.git(self.origin, "log", "--format=%s", "main").splitlines())

    def test_gives_up_after_the_last_attempt(self) -> None:
        hook = self.origin / "hooks" / "pre-receive"
        hook.parent.mkdir(exist_ok=True)
        hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8", newline="\n")
        hook.chmod(0o755)
        before = self.git(self.origin, "rev-parse", "main")
        self.write_data(self.work, "v2")
        done = self.run_step(attempts="2")
        self.assertEqual(1, done.returncode, done.stdout + done.stderr)
        self.assertIn("Push failed on attempt 2", done.stdout)
        self.assertIn("::error::Push still failing after 2 attempts", done.stdout)
        self.assertEqual(before, self.git(self.origin, "rev-parse", "main"))


if __name__ == "__main__":
    unittest.main()
