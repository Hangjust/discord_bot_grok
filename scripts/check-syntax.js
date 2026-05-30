const { readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

function collectJavaScriptFiles(path) {
  const stat = statSync(path);

  if (stat.isFile()) {
    return path.endsWith('.js') ? [path] : [];
  }

  return readdirSync(path)
    .flatMap((entry) => collectJavaScriptFiles(join(path, entry)))
    .sort();
}

const files = [
  'index.js',
  ...collectJavaScriptFiles('scripts'),
  ...collectJavaScriptFiles('src'),
  ...collectJavaScriptFiles('test'),
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
