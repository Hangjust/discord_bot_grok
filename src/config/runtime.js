function isSupportedNodeVersion(version = process.versions.node) {
  const [major, minor, patch] = String(version).split('.').map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  if (major === 22) return minor > 23 || (minor === 23 && patch >= 0);
  if (major === 24) return minor > 17 || (minor === 17 && patch >= 0);
  if (major === 26) return minor > 3 || (minor === 3 && patch >= 1);
  return major > 26;
}

function assertSupportedNodeVersion(version = process.versions.node) {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(
      `Unsupported Node.js ${version}. Upgrade to Node.js 22.23+, 24.17+, or 26.3+.`,
    );
  }
}

module.exports = { assertSupportedNodeVersion, isSupportedNodeVersion };
