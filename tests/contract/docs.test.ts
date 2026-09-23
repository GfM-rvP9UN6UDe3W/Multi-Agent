import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// SPEC-0021: what a first-time reader of the repository sees.
const root = fileURLToPath(new URL('../../', import.meta.url));

/** Tracked files plus new files that are not ignored, so a check covers work before its commit. */
const repositoryFiles = (...patterns: string[]) =>
  execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter((file) => file && existsSync(join(root, file)));

const readme = () => readFileSync(join(root, 'README.md'), 'utf8');

/** Markdown without fenced or inline code, where bracketed text is not a link. */
const prose = (text: string) =>
  text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');

/** Inline links, images and reference definitions; footnote definitions are not links. */
const linkTargets = (text: string) => [
  ...[...text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
    (match) => match[1]!,
  ),
  ...[...text.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:\s*<?(\S+?)>?(?:\s.*)?$/gm)].map(
    (match) => match[1]!,
  ),
];

const isLocal = (target: string) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#');

const localImages = (text: string) =>
  [...prose(text).matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)]
    .map((match) => match[1]!)
    .filter(isLocal);

test('0021-R01 the README opens with what it is, three reasons, a diagram, a quickstart, a comparison and the status', () => {
  const text = readme();
  const opening = /^# Orchvia\n\n([^\n#-][^\n]*)\n\n((?:- [^\n]+\n)+)\n!\[/.exec(text);
  assert.ok(opening, 'title, one sentence, a list of reasons, then the diagram');
  assert.equal(opening[2]!.trimEnd().split('\n').length, 3, 'three reasons');
  const headings = ['## Quickstart', '## How it compares', '## Status'].map((heading) =>
    text.indexOf(`\n${heading}\n`),
  );
  assert.ok(
    headings.every((at) => at > 0),
    `missing: ${headings.flatMap((at, index) => (at > 0 ? [] : [index]))}`,
  );
  assert.deepEqual(
    [...headings].sort((a, b) => a - b),
    headings,
    'quickstart, comparison, status',
  );
});

test('0021-R01 the offline quickstart runs two tasks on one warm session', () => {
  const run = spawnSync(process.execPath, ['examples/typescript/quickstart.ts'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1\. .*: completed, session /);
  assert.match(run.stdout, /2\. .*: completed, session /);
  assert.match(run.stdout, /reused the first agent's session: true/);
});

test('0021-R02 0021-R06 0021-R08 the README carries no release evidence, price or paid judge, and stays within 15 KB', () => {
  const text = readme();
  assert.ok(Buffer.byteLength(text) <= 15 * 1024, `${Buffer.byteLength(text)} bytes`);
  const forbidden: [string, RegExp][] = [
    ['a test count', /\b\d+\s+(?:[A-Za-z.]+\s+)?tests?\b|\b(\d{2,})\/\1\b/i],
    ['a CI run id', /actions\/runs\/\d+|\brun\s+\d{8,}\b/i],
    ['a candidate version', /\brc\.?\d+\b/i],
    ['a commit hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
    ['a price', /\$\s?\d/],
    ['a paid judge', /\bJev\b|TypeSafe/],
  ];
  for (const [what, pattern] of forbidden)
    assert.doesNotMatch(text, pattern, `the README states ${what}`);
});

test('0021-R03 the README uses no internal term; docs/concepts.md explains them', () => {
  assert.doesNotMatch(
    readme(),
    /A\/Q\/R|quarantin|outcome_unknown|attestation|stopProof|stop proof|dispatch occupancy/i,
  );
  const concepts = readFileSync(join(root, 'docs/concepts.md'), 'utf8');
  for (const term of ['A/Q/R', 'quarantine', 'outcome_unknown', 'attestation'])
    assert.ok(concepts.includes(term), `docs/concepts.md explains ${term}`);
});

test('0021-R04 every relative link in the repository Markdown resolves', () => {
  const broken: string[] = [];
  for (const file of repositoryFiles('*.md')) {
    const text = prose(readFileSync(join(root, file), 'utf8'));
    for (const target of linkTargets(text).filter(isLocal)) {
      const path = decodeURIComponent(target.replace(/[?#].*$/, ''));
      if (!path) continue;
      const absolute = path.startsWith('/') ? join(root, path) : resolve(root, dirname(file), path);
      if (!existsSync(absolute)) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('0021-R05 the README embeds a diagram of at most 400 KB', () => {
  const images = localImages(readme());
  assert.ok(images.length > 0, 'one local diagram');
  for (const image of images) {
    const size = statSync(join(root, decodeURIComponent(image))).size;
    assert.ok(size <= 400 * 1024, `${image} is ${size} bytes`);
  }
});

// The names are stored as SHA-256 digests of lower-case words and word pairs, so this file does not
// contain them.
const INTERNAL_NAMES = new Set([
  '6e347238eb5efcb1c226e033c8aca5f333c5faeedf353766d9f265738b7f7c7b',
  'aa0ff7e35464568865fc95ab9a63f44af05776cc2ebd67806900a027f483e2e1',
  'b933a4046b43fb33a5a12274c3ca63a7bc2e7819c2aa2f967f0cafcd4e48acaa',
]);
const BINARY = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.wasm',
  '.sqlite',
]);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('0021-R09 no repository file names a downstream product', () => {
  const found: string[] = [];
  for (const file of repositoryFiles()) {
    if (BINARY.has(extname(file).toLowerCase())) continue;
    const data = readFileSync(join(root, file));
    if (data.subarray(0, 8000).includes(0)) continue;
    const words =
      data
        .toString('utf8')
        .toLowerCase()
        .match(/[a-z0-9]+/g) ?? [];
    if (
      words.some(
        (word, index) =>
          INTERNAL_NAMES.has(digest(word)) ||
          (index > 0 && INTERNAL_NAMES.has(digest(`${words[index - 1]} ${word}`))),
      )
    )
      found.push(file);
  }
  assert.deepEqual(found, []);
});
