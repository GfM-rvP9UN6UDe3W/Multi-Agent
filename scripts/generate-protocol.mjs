import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const raw = await readFile(resolve(root, 'schemas/protocol.schema.json'), 'utf8');
const document = JSON.parse(raw);
const hash = createHash('sha256').update(raw).digest('hex');
const check = process.argv.includes('--check');
const annotation = `Generated from schemas/protocol.schema.json; SHA-256 ${hash}. Do not edit.`;
function ts(schema) {
  if (schema.$ref) return schema.$ref.split('/').at(-1);
  if ('const' in schema) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (schema.oneOf) return schema.oneOf.map((value) => `(${ts(value)})`).join(' | ');
  const parts = [];
  if (schema.allOf) parts.push(...schema.allOf.map((value) => `(${ts(value)})`));
  const type = schema.type;
  if (Array.isArray(type)) return type.map((value) => ts({ ...schema, type: value })).join(' | ');
  if (type === 'object' || schema.properties) {
    parts.push(
      `{ ${Object.entries(schema.properties ?? {})
        .map(
          ([name, value]) =>
            `${JSON.stringify(name)}${schema.required?.includes(name) ? '' : '?'}: ${ts(value)};`,
        )
        .join('\n')}${schema.additionalProperties === false ? '' : '\n[key: string]: unknown;'} }`,
    );
  } else if (type === 'array') parts.push(`Array<${ts(schema.items ?? {})}>`);
  else if (type) parts.push(type === 'integer' ? 'number' : type);
  return parts.length ? parts.join(' & ') : 'unknown';
}
let pythonClasses = [],
  pythonAliases = [];
const used = new Set(Object.keys(document.$defs));
function py(schema, hint) {
  if (schema.$ref) return schema.$ref.split('/').at(-1);
  if ('const' in schema || schema.enum) {
    const values = schema.enum ?? [schema.const];
    return `Literal[${values.map((value) => (value === null ? 'None' : value === true ? 'True' : value === false ? 'False' : JSON.stringify(value))).join(', ')}]`;
  }
  if (schema.oneOf)
    return `Union[${schema.oneOf.map((value, index) => JSON.stringify(py(value, `${hint}Choice${index + 1}`))).join(', ')}]`;
  if (Array.isArray(schema.type))
    return schema.type.map((type) => py({ ...schema, type }, hint)).join(' | ');
  if (schema.type === 'object' || schema.properties) {
    let name = hint;
    for (let index = 2; used.has(name); index++) name = `${hint}${index}`;
    used.add(name);
    const props = Object.entries(schema.properties ?? {}).map(([key, value]) => {
      const type = py(value, `${name}${key[0].toUpperCase()}${key.slice(1)}`);
      return `    ${key}: ${schema.required?.includes(key) ? type : `NotRequired[${type}]`}`;
    });
    pythonClasses.push(
      `class ${name}(TypedDict):\n${props.length ? props.join('\n') : '    pass'}\n`,
    );
    return name;
  }
  if (schema.type === 'array') return `list[${py(schema.items ?? {}, `${hint}Item`)}]`;
  return (
    { string: 'str', integer: 'int', number: 'float', boolean: 'bool', null: 'None' }[
      schema.type
    ] ?? 'Any'
  );
}
for (const [name, schema] of Object.entries(document.$defs)) {
  if (schema.type === 'object' || schema.properties) {
    used.delete(name);
    py(schema, name);
  } else {
    // Runtime validation retains conditional constraints that structural types cannot express.
    const type = py(schema, name);
    pythonAliases.push(`${name}: TypeAlias = ${type}`);
  }
}
const tsTypes = await prettier.format(
  `// ${annotation}\n// Structural types; validateWire enforces numeric and conditional constraints.\n${Object.entries(
    document.$defs,
  )
    .map(([name, schema]) => `export type ${name} = ${ts(schema)};`)
    .join('\n')}`,
  { parser: 'typescript', singleQuote: true, printWidth: 100, trailingComma: 'all' },
);
const pyTypes = `"""${annotation}\nWire dictionaries use camelCase. Use the SDK dataclasses for snake_case requests.\n"""\nfrom __future__ import annotations\nfrom typing import Any, Literal, NotRequired, TypedDict, TypeAlias, Union\n\n${pythonClasses.join('\n')}\n${pythonAliases.join('\n')}\n`;
const outputs = {
  'packages/engine/src/generated/wire.ts': tsTypes,
  'packages/engine/src/generated/protocol-schema.ts': await prettier.format(
    `// ${annotation}\nexport const protocolSchema = ${raw};\n`,
    { parser: 'typescript', singleQuote: true, printWidth: 100, trailingComma: 'all' },
  ),
  'packages/engine/src/generated/protocol.schema.json': raw,
  'python/src/agent_orch/wire_types.py': pyTypes,
  'python/src/agent_orch/protocol.schema.json': raw,
};
let stale = false;
for (const [name, content] of Object.entries(outputs)) {
  const path = resolve(root, name);
  if (check) {
    if ((await readFile(path, 'utf8').catch(() => null)) !== content) {
      console.error(`Stale generated file: ${name}`);
      stale = true;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
if (stale) process.exitCode = 1;
else
  console.log(
    JSON.stringify({
      generated: Object.keys(outputs).length,
      definitions: Object.keys(document.$defs).length,
      schemaSha256: hash,
      mode: check ? 'check' : 'write',
    }),
  );
