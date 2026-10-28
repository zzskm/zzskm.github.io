# Runtime security

CVE-2026-111497 affects Brotli decompression of attacker-controlled input,
including automatic decoding of HTTP responses in collection jobs. GitHub
Pages serves this project's static files; collection and build runtimes are
checked separately before network collection or publishing.

Use Node 22.23.4+, 24.22.1+, or 26.12.1+ on those release lines. `.node-version`
selects 22.23.4 for CI and version managers. Node may report Brotli 1.2.0 even
after a backported fix, so `node scripts/check-node-runtime.mjs` checks the
Node release. The simulator also enforces this through npm engines and hooks.
Restart existing Node development processes after updating the installation.

Install Garmin dependencies with `python -m pip install -r requirements.txt`,
bus dependencies with `-r bus-arrival/requirements.txt`, and parking
dependencies with `-r yuc/requirements.txt`. Shared constraints prevent
optional Python Brotli decoders from resolving to affected releases without
adding those optional packages. Parking does not install Garmin's native HTTP
client. `curl_cffi==0.17.0` includes updated native Brotli; its required certifi
update is included in the Garmin requirements.

Run `python scripts/check-brotli-runtime.py --require-curl` in the Garmin
environment; omit `--require-curl` in bus/parking environments. The check
inspects installed optional packages and curl's actual linked Brotli version.
Updating the standalone `brotli` package does not update curl's bundled copy.
CI fails before collection if an affected decoder is detected. The Runtime
security workflow also resolves each dependency set in a fresh Linux job.

References:

- [Node.js security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
- [Upstream Brotli release](https://github.com/google/brotli/releases/tag/v1.2.1)
- [curl_cffi maintainer's fixed-release announcement](https://github.com/lexiforest/curl_cffi/issues/895)
- [Python package advisory](https://github.com/advisories/GHSA-9v8h-qqgm-4m35)
