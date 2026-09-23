// Prints the version that a release workflow run builds (SPEC-0021 P09), from GITHUB_REF,
// GITHUB_SHA and GITHUB_RUN_NUMBER. A tag vX.Y.Z builds X.Y.Z, which must be the version in
// package.json (P08), have a changelog section and be on main (RELEASE_MAIN_REF, by default
// origin/main). Any other ref builds a throwaway version that is never published.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const ref = process.env.GITHUB_REF ?? '';
if (!ref.startsWith('refs/tags/v')) {
  const run = process.env.GITHUB_RUN_NUMBER ?? '';
  if (!/^\d+$/.test(run)) fail('GITHUB_RUN_NUMBER must be a number');
  console.log(`0.0.0-rc.${run}`);
} else {
  const version = ref.slice('refs/tags/v'.length);
  if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version))
    fail(`The tag v${version} does not name a release version`);
  const source = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (version !== source)
    fail(
      `The tag is v${version}, but package.json says ${source}. ` +
        `Set the version in a release pull request first: node scripts/set-version.mjs ${version}`,
    );
  if (!readFileSync('CHANGELOG.md', 'utf8').includes(`\n## [${version}] - `))
    fail(`CHANGELOG.md has no section "## [${version}] - date"`);
  const main = process.env.RELEASE_MAIN_REF ?? 'origin/main';
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', process.env.GITHUB_SHA ?? 'HEAD', main], {
      stdio: 'ignore',
    });
  } catch {
    fail(`The tagged commit is not on ${main}`);
  }
  console.log(version);
}
