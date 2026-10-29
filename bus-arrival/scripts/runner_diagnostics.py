#!/usr/bin/env python3
"""Best-effort runner network metadata; kept in Actions artifacts, not Pages."""
import argparse
import datetime as dt
import ipaddress
import json
import os
import re
import socket
from pathlib import Path

import httpx


def collect():
    data = {
        "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "runner_name": os.getenv("RUNNER_NAME"),
        "runner_os": os.getenv("RUNNER_OS"),
        "runner_arch": os.getenv("RUNNER_ARCH"),
        "run_id": os.getenv("GITHUB_RUN_ID"),
        "run_attempt": os.getenv("GITHUB_RUN_ATTEMPT"),
    }
    # Query only location from Azure metadata. No credentials or full metadata.
    try:
        response = httpx.get(
            "http://169.254.169.254/metadata/instance/compute/location",
            params={"api-version": "2021-02-01", "format": "text"},
            headers={"Metadata": "true"}, timeout=2, trust_env=False,
        )
        response.raise_for_status()
        region = response.text.strip()
        data["region"] = region if re.fullmatch(r"[a-z0-9-]{1,40}", region) else None
    except (httpx.HTTPError, ValueError):
        data["region"] = None
    try:
        response = httpx.get("https://api.ipify.org", timeout=3)
        response.raise_for_status()
        data["public_ip"] = str(ipaddress.ip_address(response.text.strip()))
    except (httpx.HTTPError, ValueError):
        data["public_ip"] = None
    try:
        data["api_addresses"] = sorted({
            str(ipaddress.ip_address(item[4][0]))
            for item in socket.getaddrinfo("apis.data.go.kr", 443, type=socket.SOCK_STREAM)
        })
    except (OSError, ValueError):
        data["api_addresses"] = []
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(collect(), indent=2) + "\n", encoding="utf-8")
    print("Runner network diagnostics recorded (no service key or API URL parameters).")


if __name__ == "__main__":
    main()
