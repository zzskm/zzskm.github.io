import contextlib
import importlib.metadata
import importlib.util
import io
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'check-brotli-runtime.py'
SPEC = importlib.util.spec_from_file_location('brotli_runtime', SCRIPT)
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class BrotliRuntimeTests(unittest.TestCase):
    def inspect(self, versions, native='brotli/1.2.1', require_curl=False, broken=False):
        def version(name):
            if name not in versions:
                raise importlib.metadata.PackageNotFoundError(name)
            return versions[name]

        class Curl:
            def version(self):
                if broken:
                    raise OSError('unloadable native decoder')
                return native.encode('ascii')

            def close(self):
                pass

        with patch.object(runtime.importlib.metadata, 'version', side_effect=version), \
                patch.dict(sys.modules, {'curl_cffi': SimpleNamespace(Curl=Curl)}), \
                contextlib.redirect_stdout(io.StringIO()):
            return runtime.inspect_runtime(require_curl)

    def test_optional_decoders_need_not_be_installed(self):
        self.assertEqual([], self.inspect({}))
        self.assertTrue(self.inspect({}, require_curl=True))

    def test_rejects_vulnerable_python_packages_and_prereleases(self):
        for name, version in [('brotli', '1.2.0'), ('brotlicffi', '1.2.0.0'), ('curl_cffi', '0.13.0'), ('curl_cffi', '0.17.0b2')]:
            with self.subTest(name=name, version=version):
                self.assertTrue(self.inspect({name: version}))

    def test_rejects_old_native_decoder_even_in_new_curl_package(self):
        self.assertTrue(self.inspect({'curl_cffi': '0.17.0'}, 'libcurl/8.23.0 brotli/1.2.0'))

    def test_rejects_unverifiable_native_library(self):
        self.assertTrue(self.inspect({'curl_cffi': '0.17.0'}, broken=True))

    def test_accepts_fixed_packages_and_upstream_backports(self):
        versions = {'brotli': '1.2.1', 'brotlicffi': '1.2.1.0', 'curl_cffi': '0.17.0'}
        for native in ['1.0.10', '1.1.1', '1.2.1', '1.2.2']:
            with self.subTest(native=native):
                self.assertEqual([], self.inspect(versions, f'libcurl/8.23.0 brotli/{native}', True))


if __name__ == '__main__':
    unittest.main()
