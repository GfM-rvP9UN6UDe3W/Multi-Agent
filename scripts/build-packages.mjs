import ts from 'typescript';
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rm,
  readdir,
  cp,
  chmod,
  access,
} from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'dist', 'release'));
const versionIndex = process.argv.indexOf('--version');
const releaseVersion = versionIndex < 0 ? undefined : process.argv[versionIndex + 1];
if (versionIndex >= 0 && !/^\d+\.\d+\.\d+-rc\.\d+$/.test(releaseVersion ?? ''))
  throw new Error('--version requires an explicit immutable RC version, e.g. 0.1.0-rc.1');
if (
  releaseVersion &&
  (await access(join(out, 'npm-manifest.json')).then(
    () => true,
    () => false,
  ))
)
  throw new Error(
    'RC output already contains a manifest; choose a new version and output directory',
  );
const temp = await mkdtemp(join(tmpdir(), 'agent-orch-build-'));
const packageNames = {
  engine: '@agent-orch/engine',
  'sdk-typescript': '@agent-orch/sdk',
  'adapter-claude': '@agent-orch/adapter-claude',
  'adapter-codex': '@agent-orch/adapter-codex',
  cli: '@agent-orch/cli',
};
async function files(path) {
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(full)));
    else result.push(full);
  }
  return result;
}
try {
  await mkdir(out, { recursive: true });
  const inputs = (await files(join(root, 'packages'))).filter((path) => path.endsWith('.ts'));
  const options = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    declaration: true,
    rewriteRelativeImportExtensions: true,
    rootDir: join(root, 'packages'),
    outDir: join(temp, 'compiled'),
    types: ['node'],
    verbatimModuleSyntax: true,
  };
  const program = ts.createProgram(inputs, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (x) => x,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  const result = program.emit();
  if (result.emitSkipped) throw new Error('TypeScript package emission failed');
  const manifest = [];
  for (const [directory, name] of Object.entries(packageNames)) {
    const stage = join(temp, 'staged', directory),
      destination = join(stage, 'dist');
    await mkdir(stage, { recursive: true });
    await cp(join(temp, 'compiled', directory, 'src'), destination, { recursive: true });
    for (const path of await files(join(root, 'packages', directory, 'src')))
      if (path.endsWith('.json')) {
        const target = join(destination, relative(join(root, 'packages', directory, 'src'), path));
        await mkdir(dirname(target), { recursive: true });
        await cp(path, target);
      }
    const mapSpecifier = (value) => {
      const match = value.match(/^\.\.\/\.\.\/([^/]+)\/src\/(.+)\.(?:ts|js)$/);
      if (match && packageNames[match[1]]) return `${packageNames[match[1]]}/internal/${match[2]}`;
      return value.replace(/^(\.\.?\/.*)\.ts$/, '$1.js');
    };
    for (const path of await files(destination))
      if (/\.(?:js|ts)$/.test(path)) {
        let code = await readFile(path, 'utf8');
        // Resolve executable/resource URLs through package exports after crossing package boundaries.
        code = code.replace(
          /new URL\((['"])(\.\.\/\.\.\/[^'"\n]+)\1,\s*import\.meta\.url\)/g,
          (_, quote, value) =>
            `new URL(import.meta.resolve(${JSON.stringify(mapSpecifier(value))}))`,
        );
        code = code.replace(
          /(['"])(\.{1,2}\/[^'"\n]+\.(?:ts|js))\1/g,
          (_, quote, value) => `${quote}${mapSpecifier(value)}${quote}`,
        );
        await writeFile(path, code);
      }
    const original = JSON.parse(
      await readFile(join(root, 'packages', directory, 'package.json'), 'utf8'),
    );
    const version = releaseVersion ?? original.version;
    const exported = {};
    for (const [key, value] of Object.entries(original.exports ?? {})) {
      const target = value.replace('./src/', './dist/').replace(/\.ts$/, '.js');
      exported[key] = { types: target.replace(/\.js$/, '.d.ts'), import: target };
    }
    exported['./internal/*'] = { types: './dist/*.d.ts', import: './dist/*.js' };
    exported['./package.json'] = './package.json';
    const dependencies =
      directory === 'engine'
        ? {}
        : {
            '@agent-orch/engine': version,
            ...(directory === 'cli' ? { '@agent-orch/sdk': version } : {}),
          };
    const peers =
      directory === 'cli'
        ? {
            '@agent-orch/adapter-claude': version,
            '@agent-orch/adapter-codex': version,
          }
        : original.peerDependencies;
    const peerMeta =
      directory === 'cli'
        ? {
            '@agent-orch/adapter-claude': { optional: true },
            '@agent-orch/adapter-codex': { optional: true },
          }
        : original.peerDependenciesMeta;
    const pkg = {
      ...original,
      version,
      private: true,
      repository: { type: 'git', url: 'git+https://github.com/masonlee39/Multi-Agent.git' },
      license: 'MIT',
      engines: { node: '>=22.18.0' },
      files: ['dist', 'README.md', 'LICENSE'],
      exports: exported,
      ...(Object.keys(dependencies).length ? { dependencies } : {}),
      ...(peers ? { peerDependencies: peers, peerDependenciesMeta: peerMeta } : {}),
      ...(directory === 'cli' ? { bin: { 'agent-orch': './dist/main.js' } } : {}),
    };
    await writeFile(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
    await writeFile(
      join(stage, 'README.md'),
      `# ${name}\n\n**ESM-only package; direct require() is not exported.** Host-side single-file CJS and ESM bundles of SDK + engine + Claude adapter are tested without node_modules.\n\nLicensed under the MIT License; see LICENSE. Third-party dependencies retain their own licenses.\n\nUnpublished local distribution, version ${version}. Requires the Node APIs available in Node.js 22.18+; embedded Electron is not rejected by runtime brand.\n\nThere are five modular packages: @agent-orch/sdk, @agent-orch/engine, @agent-orch/adapter-claude, @agent-orch/adapter-codex and @agent-orch/cli. A Claude consumer installs the first three; installing the SDK alone does not install a provider.\n\nClaude native SDK and zod 4.4.3 are optional peers: provide them for default loading, or inject the host-owned query, createMcpServer and inspectSession callbacks. createClaudeMcpServer(tools, {sdk, zod}) and inspectClaudeSession(input, sdk) are public helpers. An injected query never falls back to a different default SDK for MCP/inspection. The host owns the native executable.\n\nSee https://github.com/masonlee39/Multi-Agent/blob/main/docs/acceptance/bundled-host.md for integration and verification boundaries. Wire protocol 2.0. Internal exports are unstable. No paid-model, Electron, OS sandbox, or public-release acceptance is implied.\n`,
    );
    if (directory === 'cli') await chmod(join(destination, 'main.js'), 0o755);
    if (
      releaseVersion &&
      (await access(join(out, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)).then(
        () => true,
        () => false,
      ))
    )
      throw new Error('An RC tarball with this version already exists; never overwrite it');
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', out], {
        cwd: stage,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_cache: join(temp, 'npm-cache'),
          npm_config_offline: 'true',
        },
      }),
    )[0];
    const bytes = await readFile(join(out, packed.filename));
    manifest.push({
      name,
      version,
      file: packed.filename,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  await writeFile(
    join(out, 'npm-manifest.json'),
    JSON.stringify({ node: process.version, packages: manifest }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ output: out, packages: manifest }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
