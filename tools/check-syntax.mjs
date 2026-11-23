import { readdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['lib', 'bin', 'tests', 'tools'];
const files = [];
for (const root of roots) {
  for (const name of readdirSync(root)) {
    if (name.endsWith('.mjs') || name.endsWith('.js')) files.push(path.join(root, name));
  }
}
files.sort();
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log('syntax ok: ' + files.length + ' files');
