#!/usr/bin/env python3
"""Reject vulnerable installed decoders before running network collectors."""

import argparse
import importlib.metadata
import re


def release(version):
    # Reject prereleases and unknown versions rather than assuming a fix.
    if not re.fullmatch(r"\d+(?:\.\d+){2,3}", version):
        return ()
    return tuple(map(int, version.split(".")))


def patched_brotli(version):
    value = release(version)
    if not value:
        return False
    major, minor, patch = value[:3]
    # Upstream also patched the older maintained branches.
    return (major, minor, patch) >= (1, 2, 1) or (
        major == 1 and ((minor == 0 and patch >= 10) or (minor == 1 and patch >= 1))
    )


def inspect_runtime(require_curl=False):
    errors = []
    for name, minimum in (("brotli", (1, 2, 1)), ("brotlicffi", (1, 2, 1, 0)), ("curl_cffi", (0, 17, 0))):
        try:
            version = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            if name == "curl_cffi" and require_curl:
                errors.append("curl_cffi is required but not installed")
            continue
        print(f"{name}: {version}")
        if not release(version) or release(version) < minimum:
            errors.append(f"{name} {version} lacks the required CVE-2026-111497 fix")
        if name == "curl_cffi":
            try:
                from curl_cffi import Curl

                curl = Curl()
                try:
                    native = curl.version().decode("ascii")
                finally:
                    curl.close()
                print(f"curl_cffi native: {native}")
                match = re.search(r"\bbrotli/([^\s]+)", native, re.IGNORECASE)
                if match and not patched_brotli(match[1]):
                    errors.append(f"curl_cffi bundles vulnerable/unknown Brotli {match[1]}")
            except Exception as exc:
                errors.append(f"Cannot verify curl_cffi native decoder: {type(exc).__name__}")
    return errors


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-curl", action="store_true")
    errors = inspect_runtime(parser.parse_args().require_curl)
    for error in errors:
        print(f"ERROR: {error}")
    if not errors:
        print("Installed Brotli decoders passed CVE-2026-111497 checks.")
    raise SystemExit(bool(errors))
