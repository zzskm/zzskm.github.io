import { pathToFileURL } from 'node:url';

// Node backports the decoder fix without necessarily changing versions.brotli.
// https://nodejs.org/en/blog/vulnerability/october-2026-security-releases
const minimums = new Map([[22, [23, 4]], [24, [22, 1]], [26, [12, 1]]]);

export function isPatchedNode(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  const minimum = minimums.get(major);
  return Boolean(minimum && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1])));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!isPatchedNode(process.versions.node)) {
    console.error(`Node ${process.version} is unsupported: CVE-2026-111497 requires 22.23.4+, 24.22.1+, or 26.12.1+ on those release lines.`);
    process.exitCode = 1;
  } else {
    console.log(`Node ${process.version}: Brotli security fix verified by Node release (reported Brotli ${process.versions.brotli}).`);
  }
}
