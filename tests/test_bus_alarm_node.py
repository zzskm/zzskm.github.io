import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "node 가 없으면 알람 엔진 테스트를 건너뛴다")
class BusAlarmEngineTests(unittest.TestCase):
    def test_alarm_engine_unit_tests_pass(self):
        result = subprocess.run(
            ["node", "--test", str(ROOT / "tests" / "bus_alarm.test.mjs")],
            capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
