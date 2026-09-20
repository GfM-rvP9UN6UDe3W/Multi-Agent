import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

type Schema = {
  $ref?: string;
  $defs?: Record<string, Schema>;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  allOf?: Schema[];
  oneOf?: Schema[];
  if?: Schema;
  then?: Schema;
  else?: Schema;
  not?: Schema;
};

// Test-only subset, not a general JSON Schema implementation. Audit every schema
// node up front so adding an unsupported assertion cannot silently weaken tests.
// format is an annotation under the default draft 2020-12 vocabulary.
const keywords = new Set([
  '$schema',
  '$id',
  '$defs',
  '$ref',
  'title',
  'description',
  'default',
  'format',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'allOf',
  'oneOf',
  'if',
  'then',
  'else',
  'not',
]);
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function schemaValidator(document: unknown) {
  assert.ok(object(document), 'Schema document must be an object');
  const root = document as Schema;
  function reference(ref: string): Schema {
    assert.match(ref, /^#\/\$defs\/[^/]+$/, `Unsupported schema reference: ${ref}`);
    const name = ref.slice('#/$defs/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
    assert.ok(root.$defs && Object.hasOwn(root.$defs, name), `Unresolved schema reference: ${ref}`);
    return root.$defs[name];
  }
  function audit(schema: Schema): void {
    assert.ok(object(schema), 'Only object schemas are supported by this test helper');
    for (const key of Object.keys(schema))
      assert.ok(keywords.has(key), `Unsupported schema keyword: ${key}`);
    if (schema.$ref) reference(schema.$ref);
    if (schema.type)
      for (const type of [schema.type].flat())
        assert.ok(types.includes(type), `Unsupported schema type: ${type}`);
    for (const group of [schema.$defs, schema.properties])
      for (const child of Object.values(group ?? {})) audit(child);
    for (const group of [schema.allOf, schema.oneOf]) for (const child of group ?? []) audit(child);
    for (const child of [schema.items, schema.if, schema.then, schema.else, schema.not])
      if (child) audit(child);
    if (Object.hasOwn(schema, 'additionalProperties'))
      assert.ok(
        typeof schema.additionalProperties === 'boolean' || object(schema.additionalProperties),
        'Unsupported additionalProperties value',
      );
    if (object(schema.additionalProperties)) audit(schema.additionalProperties);
    if (schema.pattern) new RegExp(schema.pattern, 'u');
  }
  audit(root);

  function check(schema: Schema, value: unknown, path: string): string[] {
    const errors: string[] = [];
    const require = (ok: boolean, rule: string) => {
      if (!ok) errors.push(`${path}: ${rule}`);
    };
    if (schema.$ref) errors.push(...check(reference(schema.$ref), value, path));
    if (schema.type) {
      const allowed = [schema.type].flat();
      require(allowed.some((type) => {
        if (type === 'null') return value === null;
        if (type === 'object') return object(value);
        if (type === 'array') return Array.isArray(value);
        if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
        if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
        return typeof value === type;
      }), `type ${allowed.join('|')}`);
    }
    if (Object.hasOwn(schema, 'const')) require(isDeepStrictEqual(value, schema.const), 'const');
    if (schema.enum) require(schema.enum.some((item) => isDeepStrictEqual(value, item)), 'enum');
    if (typeof value === 'number') {
      if (schema.minimum !== undefined) require(value >= schema.minimum, 'minimum');
      if (schema.maximum !== undefined) require(value <= schema.maximum, 'maximum');
    }
    if (typeof value === 'string') {
      const length = [...value].length;
      if (schema.minLength !== undefined) require(length >= schema.minLength, 'minLength');
      if (schema.maxLength !== undefined) require(length <= schema.maxLength, 'maxLength');
      if (schema.pattern) require(new RegExp(schema.pattern, 'u').test(value), 'pattern');
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined) require(value.length >= schema.minItems, 'minItems');
      if (schema.maxItems !== undefined) require(value.length <= schema.maxItems, 'maxItems');
      if (schema.items)
        value.forEach((item, i) => errors.push(...check(schema.items!, item, `${path}[${i}]`)));
    }
    if (object(value)) {
      for (const key of schema.required ?? [])
        require(Object.hasOwn(value, key), `required ${key}`);
      for (const [key, item] of Object.entries(value)) {
        const child = schema.properties?.[key];
        if (child) errors.push(...check(child, item, `${path}.${key}`));
        else if (schema.additionalProperties === false)
          require(false, `additional property ${key}`);
        else if (object(schema.additionalProperties))
          errors.push(...check(schema.additionalProperties, item, `${path}.${key}`));
      }
    }
    for (const child of schema.allOf ?? []) errors.push(...check(child, value, path));
    if (schema.oneOf)
      require(schema.oneOf.filter((child) => check(child, value, path).length === 0).length ===
        1, 'oneOf');
    if (schema.not) require(check(schema.not, value, path).length > 0, 'not');
    if (schema.if) {
      const branch = check(schema.if, value, path).length === 0 ? schema.then : schema.else;
      if (branch) errors.push(...check(branch, value, path));
    }
    return errors;
  }
  return (name: string, value: unknown) => {
    const errors = check(reference(`#/$defs/${name}`), value, name);
    assert.deepEqual(errors, [], errors.join('\n'));
  };
}
