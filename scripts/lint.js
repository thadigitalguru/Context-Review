// Minimal syntax lint: runs `node --check` over all first-party JS.
// No dependencies; fails non-zero on the first syntax error.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ROOTS = ['index.js', 'src', 'test', 'scripts', 'public/js'];

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collect(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const root of ROOTS) {
  const full = path.join(ROOT, root);
  if (!fs.existsSync(full)) continue;
  if (fs.statSync(full).isFile()) files.push(full);
  else collect(full, files);
}

let failures = 0;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  if (result.status !== 0) {
    failures += 1;
    console.error(`SYNTAX FAIL: ${path.relative(ROOT, file)}`);
    console.error(String(result.stderr || '').trim());
  }
}

console.log(`lint: ${files.length} files checked, ${failures} failure(s)`);
process.exit(failures > 0 ? 1 : 0);
