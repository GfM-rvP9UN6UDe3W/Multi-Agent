import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm, access, mkdtemp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';

/** Run only in a disposable installation owned by package-smoke. */
export async function smokeClaudeBundles({ root, isolated, run }) {
  const results = [];
  const modules = join(isolated, 'node_modules');
  // Host-owned SDK files are copied from exact locked development dependencies.
  // No dependency discovery, network access, credentials or native binaries at runtime.
  for (const name of ['@anthropic-ai/claude-agent-sdk', 'zod']) {
    await mkdir(dirname(join(modules, name)), { recursive: true });
    await cp(join(root, 'node_modules', name), join(modules, name), { recursive: true });
    if (name === '@anthropic-ai/claude-agent-sdk')
      run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
import assert from 'node:assert/strict';
import {createClaudeMcpServer} from '@orchvia/adapter-claude';
await assert.rejects(createClaudeMcpServer({definitions:[],call:async()=>null}), error => error.code === 'CLAUDE_DEPENDENCY_UNAVAILABLE' && error.message.includes('zod 4.4.3') && error.cause?.message.includes('zod'));
`,
        ],
        { cwd: isolated },
      );
  }
  const native = JSON.parse(
    await readFile(join(modules, '@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'),
  );
  assert.equal(native.version, '0.3.274');
  const peer = await build({
    entryPoints: [join(root, 'tests/fixtures/claude-mcp-child.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  let source = await readFile(join(root, 'tests/fixtures/packaged-claude-host.mjs'), 'utf8');
  source = source.replace("'__OWNED_CLAUDE_PEER__'", JSON.stringify(peer.outputFiles[0].text));
  const entry = join(isolated, 'claude-host.mjs');
  await writeFile(entry, source);
  results.push(
    JSON.parse(run(process.execPath, [entry, 'installed-claude-mcp'], { cwd: isolated })),
  );
  const outputs = [];
  for (const format of ['cjs', 'esm']) {
    const outfile = join(isolated, format === 'cjs' ? 'host.cjs' : 'host.mjs');
    const result = await build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format,
      metafile: true,
      logLevel: 'silent',
      plugins:
        format === 'cjs'
          ? [
              {
                name: 'host-owned-native-sdk-cjs-url',
                setup(context) {
                  // This compatibility shim applies ONLY to the third-party SDK, never orchvia.
                  context.onLoad(
                    { filter: /[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]sdk\.mjs$/ },
                    async ({ path }) => ({
                      contents: (await readFile(path, 'utf8')).replaceAll(
                        'import.meta.url',
                        'require("node:url").pathToFileURL(__filename).href',
                      ),
                      loader: 'js',
                      resolveDir: dirname(path),
                    }),
                  );
                },
              },
            ]
          : [],
    });
    assert.deepEqual(result.warnings, [], `Unexpected ${format} bundling warnings`);
    const inputs = Object.keys(result.metafile.inputs);
    for (const name of ['sdk', 'engine', 'adapter-claude'])
      assert.ok(
        inputs.some((path) => path.includes(`@orchvia/${name}/`)),
        name,
      );
    assert.ok(!inputs.some((path) => /@orchvia\/(adapter-codex|cli)\//.test(path)));
    for (const output of Object.values(result.metafile.outputs))
      for (const dependency of output.imports)
        assert.ok(
          dependency.external &&
            (dependency.path.startsWith('node:') || builtinModules.includes(dependency.path)),
          dependency.path,
        );
    outputs.push({ format, outfile });
  }
  await rm(modules, { recursive: true, force: true });
  await rm(entry);
  await assert.rejects(access(modules));
  const deployed = await mkdtemp(join(tmpdir(), 'orch-deployed-bundle-'));
  try {
    for (const { format, outfile } of outputs) {
      const executable = join(deployed, format === 'cjs' ? 'main.cjs' : 'main.mjs');
      await cp(outfile, executable);
      const result = JSON.parse(
        run(process.execPath, [executable, `bundled-${format}-no-node-modules`], { cwd: deployed }),
      );
      results.push({ ...result, nativeSdkVersion: native.version, nodeModulesRemoved: true });
      await rm(executable);
    }
  } finally {
    await rm(deployed, { recursive: true, force: true });
  }
  return results;
}
