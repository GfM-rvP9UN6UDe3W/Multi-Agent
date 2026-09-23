# Publishing

This file is the only source for how Orchvia is released ([SPEC-0021](../specs/0021-open-source-readiness.md) P02 to P06). Each manual step says how long it takes, what success looks like and what to do if it fails.

## How a release works

1. The changelog gets a section `## [X.Y.Z] - date`, and that change is merged into `main`.
2. A maintainer pushes the tag `vX.Y.Z` on that commit. A version with a suffix, such as `v0.2.0-rc.1`, is a pre-release: npm tag `next`, PyPI pre-release, GitHub pre-release.
3. The [release workflow](../../.github/workflows/release.yml) then runs, in this order:
   1. the full offline test matrix;
   2. one build of every package from the tag, with recorded hashes, an offline installation of the archives, `npm publish --dry-run` and `twine check`;
   3. npm publishing through trusted publishing, in dependency order: engine, the adapters, sdk, cli. A version already on the registry is skipped, so a rerun continues where a failed run stopped;
   4. PyPI publishing through trusted publishing;
   5. the GitHub Release, with every archive and `SHA256SUMS`, created only after both registries have the version;
   6. on fresh Linux and macOS runners, an installation from npm and PyPI into empty directories that runs a quickstart and a Python host. It also checks that each npm archive has the bytes the workflow built.
4. A release is announced only after step 6 has passed.

Pull requests that touch packaging run step 2 without publishing. No token is stored in the repository or its settings.

## One-time setup

### 1. The npm organization `orchvia`

Done on 2026-09-23 by the owner.

### 2. The first npm publish (owner, about 3 minutes)

npm allows trusted publishing and staged publishing only for packages that already exist, so the first version of each package is published once with the owner's npm login. npm requires two-factor authentication on the account to publish, and it asks for it in an interactive terminal, so the owner runs the publishing command.

1. The owner turns on two-factor authentication on npmjs.com (Account, Two-Factor Authentication), then runs `npm login --auth-type=web` in a terminal on the release machine and confirms in the browser.
   - Success: `npm whoami` prints the owner's npm user name.
   - Failure: `E403 ... Two-factor authentication ... is required to publish packages` means two-factor authentication is still off.
2. The maintainer builds the commit that will be tagged into an empty directory with `node scripts/build-packages.mjs <dir> --version 0.1.0`. The build is byte-identical on macOS and Linux, so the release workflow's registry check accepts these archives.
3. The owner publishes the five archives in dependency order, stopping at the first failure; a path that does not start with `./` or `/` is read as a GitHub repository:

   ```sh
   cd <dir> && for p in engine adapter-claude adapter-codex sdk cli; do npm publish "./orchvia-$p-0.1.0.tgz" --access public || break; done
   ```

   - Success: five lines `+ @orchvia/<name>@0.1.0`, and `npm view @orchvia/cli version` prints `0.1.0`.
   - Failure: npm asks for two-factor confirmation for a publish; the owner confirms in the browser or enters the code. A command that is not interactive fails with `EOTP`. If one package fails, fix the cause and continue from it; never republish a version that exists.
4. The maintainer compares each package's `dist.integrity` on npm with the local archive, then runs `npm logout`.

### 3. npm trusted publishers (maintainer, in the owner's signed-in browser)

For each of the five packages, on npmjs.com under the package's Settings, Trusted publishing: GitHub Actions, organization or user `masonlee39`, repository `orchvia`, workflow `release.yml`, environment `npm`.

- Success: each package lists the trusted publisher.
- Failure: if npm asks for two-factor confirmation, the owner approves it.

### 4. PyPI (owner, about 5 minutes)

1. The owner creates an account at https://pypi.org/account/register/, confirms the email and turns on two-factor authentication.
   - Success: the owner is signed in, and the account page shows two-factor authentication as enabled.
2. The maintainer adds a pending publisher in the owner's signed-in browser, at https://pypi.org/manage/account/publishing/: project `orchvia`, owner `masonlee39`, repository `orchvia`, workflow `release.yml`, environment `pypi`.
   - Success: the page lists the pending publisher. It does not reserve the name, so the first release follows soon after.

### 5. GitHub environments

The environments `npm` and `pypi` exist under the repository's Settings, Environments; GitHub creates them on the first run if they are missing. The tag push is the approval, so they need no reviewers.
