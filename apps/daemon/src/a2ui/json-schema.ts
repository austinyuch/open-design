/**
 * Minimal, offline JSON Schema (draft 2020-12) validator for the vendored
 * A2UI 1.0 schemas.
 *
 * Implements exactly the keyword subset those schemas use: `$ref` (local
 * pointers and relative cross-document references resolved against `$id`),
 * `type`, `const`, `enum`, `properties`, `patternProperties`,
 * `additionalProperties`, `required`, `items`, `minItems`, `minimum`,
 * `pattern`, `propertyNames`, `allOf` / `anyOf` / `oneOf` / `not`,
 * `if` / `then` / `else`, and `unevaluatedProperties` with annotation
 * collection across applicators. Annotation-only keywords (`description`,
 * `default`, `format`, `title`, …) are ignored, as 2020-12 specifies for
 * `format` by default.
 *
 * Every schema document is supplied up front by URI. A `$ref` that does not
 * resolve to a supplied document fails validation as `unresolved $ref`; no
 * URL is ever fetched.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = boolean | { [key: string]: unknown };

export interface SchemaError {
  /** Instance location as a JSONPath-like string relative to the root. */
  path: string;
  message: string;
}

interface Outcome {
  errors: SchemaError[];
  /** Property names evaluated at this instance location (for unevaluatedProperties). */
  evaluated: Set<string>;
}

export class SchemaRegistry {
  private readonly docs = new Map<string, Schema>();

  add(uri: string, doc: Schema): this {
    this.docs.set(stripFragment(uri), doc);
    return this;
  }

  /** Validate `instance` against the schema at `uri` (may carry a `#/pointer`). */
  validate(uri: string, instance: unknown, rootPath = '$'): SchemaError[] {
    const target = this.resolve(uri, '');
    if (!target) return [{ path: rootPath, message: `unresolved $ref ${uri}` }];
    return this.check(target.schema, target.base, instance as Json, rootPath, 0).errors;
  }

  private resolve(ref: string, base: string): { schema: Schema; base: string } | null {
    const absolute = resolveUri(ref, base);
    const [docUri, fragment = ''] = absolute.split('#');
    const doc = this.docs.get(docUri ?? '');
    if (doc === undefined) return null;
    const schema = fragment ? pointer(doc, fragment) : doc;
    return schema === undefined ? null : { schema: schema as Schema, base: docUri ?? '' };
  }

  private check(schema: Schema, base: string, value: Json, path: string, depth: number): Outcome {
    const out: Outcome = { errors: [], evaluated: new Set() };
    if (schema === true) return out;
    if (schema === false) {
      out.errors.push({ path, message: 'is not allowed' });
      return out;
    }
    if (depth > 64) {
      out.errors.push({ path, message: 'schema nesting too deep' });
      return out;
    }
    const s = schema;
    const here = typeof s.$id === 'string' ? stripFragment(resolveUri(s.$id, base)) : base;
    const fail = (message: string) => out.errors.push({ path, message });
    const sub = (child: unknown, v: Json, p: string) => this.check(child as Schema, here, v, p, depth + 1);
    const absorb = (o: Outcome) => {
      out.errors.push(...o.errors);
      if (o.errors.length === 0) for (const k of o.evaluated) out.evaluated.add(k);
    };

    if (typeof s.$ref === 'string') {
      const target = this.resolve(s.$ref, here);
      if (!target) fail(`unresolved $ref ${s.$ref}`);
      else absorb(this.check(target.schema, target.base, value, path, depth + 1));
    }

    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some((t) => matchesType(String(t), value))) {
        fail(`must be ${types.join(' or ')}, got ${typeOf(value)}`);
        return out;
      }
    }
    if ('const' in s && !deepEqual(s.const, value)) fail(`must equal ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) {
      fail(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    }
    if (typeof s.minimum === 'number' && typeof value === 'number' && value < s.minimum) {
      fail(`must be >= ${s.minimum}`);
    }
    if (typeof s.pattern === 'string' && typeof value === 'string' && !compile(s.pattern).test(value)) {
      fail(`must match ${s.pattern}`);
    }

    if (Array.isArray(value)) {
      if (typeof s.minItems === 'number' && value.length < s.minItems) fail(`must have at least ${s.minItems} item(s)`);
      if (s.items !== undefined) {
        value.forEach((item, i) => out.errors.push(...sub(s.items, item, `${path}[${i}]`).errors));
      }
    }

    if (isObject(value)) {
      const keys = Object.keys(value);
      if (Array.isArray(s.required)) {
        for (const key of s.required) if (!(String(key) in value)) fail(`missing required property \`${key}\``);
      }
      const props = isObject(s.properties) ? s.properties : {};
      for (const key of keys) {
        if (key in props) {
          out.evaluated.add(key);
          out.errors.push(...sub(props[key], value[key] as Json, childPath(path, key)).errors);
        }
      }
      if (isObject(s.patternProperties)) {
        for (const [pattern, child] of Object.entries(s.patternProperties)) {
          const re = compile(pattern);
          for (const key of keys) {
            if (re.test(key)) {
              out.evaluated.add(key);
              out.errors.push(...sub(child, value[key] as Json, childPath(path, key)).errors);
            }
          }
        }
      }
      if (s.additionalProperties !== undefined) {
        const patterns = isObject(s.patternProperties) ? Object.keys(s.patternProperties).map(compile) : [];
        for (const key of keys) {
          if (key in props || patterns.some((re) => re.test(key))) continue;
          out.evaluated.add(key);
          if (s.additionalProperties === false) fail(`unknown property \`${key}\``);
          else out.errors.push(...sub(s.additionalProperties, value[key] as Json, childPath(path, key)).errors);
        }
      }
      if (s.propertyNames !== undefined) {
        for (const key of keys) {
          if (sub(s.propertyNames, key, path).errors.length > 0) fail(`property name \`${key}\` is not allowed`);
        }
      }
    }

    if (Array.isArray(s.allOf)) for (const part of s.allOf) absorb(sub(part, value, path));
    if (Array.isArray(s.anyOf)) {
      const results = s.anyOf.map((part) => sub(part, value, path));
      const passing = results.filter((r) => r.errors.length === 0);
      if (passing.length === 0) out.errors.push(...closest(results, path, 'any'));
      for (const r of passing) for (const k of r.evaluated) out.evaluated.add(k);
    }
    if (Array.isArray(s.oneOf)) {
      const results = s.oneOf.map((part) => sub(part, value, path));
      const passing = results.filter((r) => r.errors.length === 0);
      if (passing.length === 0) out.errors.push(...closest(discriminate(s, results, path), path, 'one'));
      else if (passing.length > 1) fail(`matches ${passing.length} oneOf branches, expected exactly one`);
      else for (const k of passing[0]!.evaluated) out.evaluated.add(k);
    }
    if (s.not !== undefined && sub(s.not, value, path).errors.length === 0) fail('matches a schema it must not match');
    if (s.if !== undefined) {
      const cond = sub(s.if, value, path);
      if (cond.errors.length === 0) {
        for (const k of cond.evaluated) out.evaluated.add(k);
        if (s.then !== undefined) absorb(sub(s.then, value, path));
      } else if (s.else !== undefined) {
        absorb(sub(s.else, value, path));
      }
    }

    // Once this location already failed, annotations from the failing
    // subschema are gone and every property would read as unevaluated;
    // reporting those adds noise without changing the verdict.
    if (s.unevaluatedProperties !== undefined && isObject(value) && out.errors.length === 0) {
      for (const key of Object.keys(value)) {
        if (out.evaluated.has(key)) continue;
        if (s.unevaluatedProperties === false) fail(`unknown property \`${key}\``);
        else out.errors.push(...sub(s.unevaluatedProperties, value[key] as Json, childPath(path, key)).errors);
        out.evaluated.add(key);
      }
    }
    return out;
  }
}

// A `discriminator.propertyName` (OpenAPI-style, used by the A2UI catalog's
// `anyComponent`) names the property that selects the branch. Drop the
// branches that rejected that property so errors come from the branch the
// instance asked for (a Text with a bad `text`, not "component must equal
// Divider").
function discriminate(s: Record<string, unknown>, results: Outcome[], path: string): Outcome[] {
  const d = s.discriminator;
  if (!isObject(d) || typeof d.propertyName !== 'string') return results;
  const at = childPath(path, d.propertyName);
  const matching = results.filter((r) => !r.errors.some((e) => e.path === at));
  return matching.length > 0 ? matching : results;
}

// When no branch of an anyOf/oneOf matches, report the branch that came
// closest so the message points at the likely intent: the branch whose
// errors reach deepest into the instance (it matched the most structure),
// then the one with the fewest errors.
function closest(results: Outcome[], path: string, kind: 'any' | 'one'): SchemaError[] {
  const depth = (o: Outcome) => Math.max(...o.errors.map((e) => e.path.length));
  let best: Outcome | undefined;
  for (const r of results) {
    if (!best || depth(r) > depth(best) || (depth(r) === depth(best) && r.errors.length < best.errors.length)) best = r;
  }
  if (!best || best.errors.length === 0) return [{ path, message: `matches no ${kind}Of branch` }];
  return best.errors;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: Json): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(t: string, v: Json): boolean {
  switch (t) {
    case 'null': return v === null;
    case 'array': return Array.isArray(v);
    case 'object': return isObject(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    default: return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

const patternCache = new Map<string, RegExp>();
function compile(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern, 'u');
    patternCache.set(pattern, re);
  }
  return re;
}

function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function stripFragment(uri: string): string {
  const i = uri.indexOf('#');
  return i < 0 ? uri : uri.slice(0, i);
}

function resolveUri(ref: string, base: string): string {
  if (ref.startsWith('#')) return `${base}${ref}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref;
  const dir = base.slice(0, base.lastIndexOf('/') + 1);
  return `${dir}${ref}`;
}

function pointer(doc: unknown, fragment: string): unknown {
  if (fragment === '' || fragment === '/') return doc;
  let node: unknown = doc;
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isObject(node)) node = node[key];
    else return undefined;
    if (node === undefined) return undefined;
  }
  return node;
}
