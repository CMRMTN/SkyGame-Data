// Builds the data.sky-planner.com site: /<major>.<minor>/ holds the newest release of each minor.
// The minor in package.json comes from the local ./assets build, so a deploy right after
// publishing doesn't wait for the registry. Older minors are fetched from npm.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'cdn';
const TMP = '.cdn-tmp';
// Oldest minor any deployed Planner still loads from the CDN.
const OLDEST = [1, 3];

const parse = v => v.split('.').map(Number);
const minorOf = v => v.split('.').slice(0, 2).join('.');
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

const versions = JSON.parse(execSync('npm view skygame-data versions --json', { encoding: 'utf8' }));
const latest = new Map();
for (const v of versions) {
  if (v.includes('-')) continue;
  const [maj, min, patch] = parse(v);
  if (maj < OLDEST[0] || (maj === OLDEST[0] && min < OLDEST[1])) continue;
  const prev = latest.get(minorOf(v));
  if (!prev || parse(prev)[2] < patch) latest.set(minorOf(v), v);
}

// Older minors are locked to their npm release, and a minor never goes back to an older patch.
const localVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const newest = [...latest.values()].sort(compare).at(-1);
if (newest && minorOf(localVersion) !== minorOf(newest) && compare(localVersion, newest) < 0) {
  throw new Error(`Local ${localVersion} is older than the newest minor (${newest}); ${minorOf(localVersion)} is locked.`);
}
const published = latest.get(minorOf(localVersion));
if (published && compare(localVersion, published) < 0) {
  throw new Error(`Local ${localVersion} is older than the published ${published}.`);
}
latest.set(minorOf(localVersion), localVersion);

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const copy = (from, to) => {
  fs.mkdirSync(to, { recursive: true });
  for (const file of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
  }
};

for (const [minor, version] of latest) {
  const dest = path.join(OUT, minor);
  const fromLocal = version === localVersion;
  if (fromLocal) {
    copy('assets', dest);
  } else {
    execSync(`npm pack skygame-data@${version} --pack-destination ${TMP}`, { stdio: 'ignore' });
    execSync(`tar -xzf ${TMP}/skygame-data-${version}.tgz -C ${TMP}`);
    copy(path.join(TMP, 'package', 'assets'), dest);
    fs.rmSync(path.join(TMP, 'package'), { recursive: true });
  }
  console.log(`${minor} -> ${version}${fromLocal ? ' (local)' : ''}`);
}

fs.writeFileSync(path.join(OUT, 'versions.json'), JSON.stringify(Object.fromEntries(latest), null, 2));
fs.rmSync(TMP, { recursive: true, force: true });
