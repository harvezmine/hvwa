// src/districts/relic-market/rm-04-nosql-login/docstore.spec.ts — the lab's document store and its operator evaluator.
// Pure unit tests: no Express, no engine. The store is the "database" of RM-04 and must be safe for ANY query value.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { DOC_LIMITS, createStore } from './docstore.js';

const store = createStore([
  { username: 'relic_admin', username_lc: 'relic_admin', password: 'a1b2c3d4e5f60718', role: 'admin' },
  { username: 'pilgrim', username_lc: 'pilgrim', password: 'pilgrim', role: 'customer' },
  { username: 'Brother_Tobias', username_lc: 'brother_tobias', password: 'ave-maria', role: 'staff' },
]);
const names = (q: unknown): string | null => store.findOne(q)?.username ?? null;
const json = (s: string): unknown => JSON.parse(s);
/** The error message a query throws ('' when it does not throw). */
const errorOf = (q: unknown): string => { try { store.findOne(q); return ''; } catch (e) { return e instanceof Error ? e.message : String(e); } };
const nested = (depth: number, leaf: unknown, wrap: (inner: unknown) => unknown): unknown => { let v = leaf; for (let i = 0; i < depth; i++) v = wrap(v); return v; };

describe('docstore: documents', () => {
  it('documents are null-prototype objects in insertion order, and findOne returns the first match', () => {
    const d = store.findOne({});
    expect(d?.username).toBe('relic_admin');
    expect(Object.getPrototypeOf(d)).toBeNull();
    expect(names({ role: { $ne: 'nobody' } })).toBe('relic_admin');
    expect(names({ username: { $gt: 'o' } })).toBe('relic_admin');
    expect(names({ username: { $lt: 'q' } })).toBe('pilgrim'); // relic_admin > 'q', pilgrim < 'q'
  });

  it('every document string is at most 32 characters (the bound the $regex safety rests on)', () => {
    expect(DOC_LIMITS.docString).toBe(32);
    expect(() => createStore([{ username: 'x'.repeat(33), username_lc: 'x', password: 'x', role: 'x' }])).toThrow(/32/);
    expect(() => createStore([{ username: 'x'.repeat(32), username_lc: 'x', password: 'x', role: 'x' }])).not.toThrow();
  });

  it('a stored document cannot be changed through a result (the store hands out frozen copies)', () => {
    const d = store.findOne({ username: 'pilgrim' });
    expect(Object.isFrozen(d)).toBe(true);
  });
});

describe('docstore: equality and types', () => {
  it('matches fields by strict same-type equality', () => {
    expect(names({ username: 'pilgrim', password: 'pilgrim' })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: 'Pilgrim' })).toBeNull();
    expect(names({ username: 'pilgrim', password: 'nope' })).toBeNull();
    expect(names({ username: 'relic_admin', password: 'a1b2c3d4e5f60718' })).toBe('relic_admin');
  });

  it('a value of another type never equals a string: numbers, booleans, null, undefined, arrays and plain objects', () => {
    for (const v of [5, 0, true, false, null, undefined, [], ['pilgrim'], {}, { a: 1 }, [[]], NaN, 1e999]) {
      expect(names({ username: 'pilgrim', password: v }), String(v)).toBeNull();
    }
    expect(names({ username: undefined })).toBeNull(); // undefined matches only a MISSING field
    expect(names({ nosuch: undefined })).toBe('relic_admin');
    expect(names({ nosuch: null })).toBe('relic_admin'); // null matches missing or null
    expect(names({ username: null })).toBeNull();
    expect(names({ nosuch: 'x' })).toBeNull();
  });

  it('reads fields as own properties only: a field called like an Object.prototype member is just missing', () => {
    for (const f of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__']) {
      expect(names({ [f]: 'x' }), f).toBeNull();
      expect(names({ [f]: { $exists: false } }), f).toBe('relic_admin');
      expect(names({ [f]: { $exists: true } }), f).toBeNull();
    }
  });

  it('skips __proto__, constructor and prototype keys, and never sees an operator that is only inherited', () => {
    expect(names({ username: 'pilgrim', password: 'pilgrim', constructor: 'nope', prototype: 1 })).toBe('pilgrim');
    expect(names(json('{"username":"pilgrim","password":"pilgrim","__proto__":{"username":"zzz"}}'))).toBe('pilgrim');
    expect(names({ password: json('{"__proto__":{"$ne":"x"}}'), username: 'relic_admin' })).toBeNull();
    expect(names({ password: json('{"constructor":{"$ne":"x"}}'), username: 'relic_admin' })).toBeNull();
    expect(names({ password: json('{"prototype":{"$ne":"x"}}'), username: 'relic_admin' })).toBeNull();
    expect(names({ password: json('{"__proto__":1,"$ne":"x"}'), username: 'relic_admin' })).toBe('relic_admin'); // the real $ne still works
    expect(names({ password: Object.create({ $ne: 'x' }), username: 'relic_admin' })).toBeNull(); // inherited: not own
    const polluted: Record<string, unknown> = {};
    Object.setPrototypeOf(polluted, { $ne: 'x' });
    expect(names({ password: polluted, username: 'relic_admin' })).toBeNull();
  });

  it('a query must be a plain object', () => {
    for (const q of [null, undefined, 'x', 5, true, [], [{ username: 'pilgrim' }]]) expect(errorOf(q), String(q)).toMatch(/query must be an object/);
  });

  it('huge or deeply nested VALUES are never walked (no recursion, no stack overflow)', () => {
    const deepArray = nested(20_000, 'x', (v) => [v]);
    const deepObject = nested(20_000, 'x', (v) => ({ a: v }));
    expect(names({ username: 'pilgrim', password: deepArray })).toBeNull();
    expect(names({ username: 'pilgrim', password: deepObject })).toBeNull();
    expect(names({ username: 'pilgrim', password: { $eq: deepObject } })).toBeNull();
    expect(names({ username: 'pilgrim', password: { $ne: deepObject } })).toBe('pilgrim'); // not equal to a string
    expect(errorOf({ password: { $in: [deepArray] } })).toMatch(/\$in/);
  });
});

describe('docstore: field operators', () => {
  it('$eq and $ne (a different type is not equal, so $ne matches it)', () => {
    expect(names({ password: { $eq: 'pilgrim' } })).toBe('pilgrim');
    expect(names({ password: { $eq: 5 } })).toBeNull();
    expect(names({ password: { $eq: { a: 1 } } })).toBeNull();
    expect(names({ username: 'pilgrim', password: { $ne: 'x' } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $ne: 'pilgrim' } })).toBeNull();
    expect(names({ username: 'pilgrim', password: { $ne: 5 } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $ne: [] } })).toBe('pilgrim');
    expect(names({ nosuch: { $ne: 'x' } })).toBe('relic_admin'); // a missing field is not equal to 'x'
  });

  it('$gt $gte $lt $lte compare strings with strings and numbers with numbers, anything else is false', () => {
    expect(names({ username: 'pilgrim', password: { $gt: '' } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $gte: 'pilgrim' } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $gt: 'pilgrim' } })).toBeNull();
    expect(names({ username: 'pilgrim', password: { $lte: 'pilgrim' } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $lt: 'pilgrim' } })).toBeNull();
    expect(names({ username: 'pilgrim', password: { $lt: 'zzz' } })).toBe('pilgrim');
    for (const op of ['$gt', '$gte', '$lt', '$lte']) {
      for (const v of [5, true, null, undefined, [], {}, { a: 1 }]) expect(names({ username: 'pilgrim', password: { [op]: v } }), `${op} ${String(v)}`).toBeNull();
    }
    expect(names({ nosuch: { $gt: '' } })).toBeNull();
  });

  it('$in and $nin take an array of at most 20 primitives', () => {
    expect(names({ password: { $in: ['x', 'pilgrim'] } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $in: [] } })).toBeNull();
    expect(names({ username: 'pilgrim', password: { $nin: ['x'] } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $nin: ['pilgrim'] } })).toBeNull();
    expect(names({ password: { $in: Array.from({ length: 20 }, (_, i) => `p${i}`) } })).toBeNull();
    expect(errorOf({ password: { $in: Array.from({ length: 21 }, (_, i) => `p${i}`) } })).toMatch(/\$in .*20/);
    expect(errorOf({ password: { $nin: Array.from({ length: 21 }, () => 'x') } })).toMatch(/\$nin .*20/);
    for (const bad of ['pilgrim', 5, {}, null, undefined]) expect(errorOf({ password: { $in: bad } }), String(bad)).toMatch(/\$in needs an array/);
    for (const el of [{}, [], [1], { a: 1 }]) expect(errorOf({ password: { $in: [el] } }), JSON.stringify(el)).toMatch(/primitive/);
  });

  it('$exists takes a boolean (or "true"/"false" as a form field carries it)', () => {
    expect(names({ password: { $exists: true } })).toBe('relic_admin');
    expect(names({ password: { $exists: 'true' } })).toBe('relic_admin');
    expect(names({ password: { $exists: false } })).toBeNull();
    expect(names({ password: { $exists: 'false' } })).toBeNull();
    expect(names({ nosuch: { $exists: false } })).toBe('relic_admin');
    for (const bad of ['yes', 1, null, {}, []]) expect(errorOf({ password: { $exists: bad } }), String(bad)).toMatch(/\$exists needs true or false/);
  });

  it('$not negates an operator expression and nests at most 5 deep', () => {
    expect(names({ username: 'pilgrim', password: { $not: { $eq: 'x' } } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $not: { $eq: 'pilgrim' } } })).toBeNull();
    const notN = (n: number): unknown => nested(n, { $eq: 'pilgrim' }, (inner) => ({ $not: inner }));
    expect(names({ username: 'pilgrim', password: notN(5) })).toBeNull(); // five negations of "equals": not equal
    expect(names({ username: 'pilgrim', password: notN(4) })).toBe('pilgrim');
    expect(errorOf({ password: notN(6) })).toMatch(/\$not nested too deeply/);
    expect(errorOf({ password: notN(500) })).toMatch(/\$not nested too deeply/);
    for (const bad of ['x', 5, null, [], { a: 1 }, { $eq: 'x', a: 1 }]) expect(errorOf({ password: { $not: bad } }), JSON.stringify(bad)).toMatch(/\$not needs|cannot mix/);
  });

  it('several operators in one object must all hold', () => {
    expect(names({ username: 'pilgrim', password: { $gte: 'a', $lt: 'z', $ne: 'x' } })).toBe('pilgrim');
    expect(names({ username: 'pilgrim', password: { $gte: 'a', $lt: 'b' } })).toBeNull();
  });

  it('an unknown operator, a value that mixes operators and fields, and an unknown top-level operator are errors', () => {
    expect(errorOf({ password: { $foo: 1 } })).toBe('unknown operator: $foo');
    expect(errorOf({ password: { $where: '1' } })).toBe('unknown operator: $where');
    expect(errorOf({ password: { $ne: 'x', a: 1 } })).toMatch(/cannot mix/);
    expect(errorOf({ password: { a: 1, $ne: 'x' } })).toMatch(/cannot mix/);
    expect(errorOf({ $foo: 1 })).toBe('unknown top-level operator: $foo');
    expect(errorOf({ $or: [{ username: 'pilgrim' }] })).toBe('unknown top-level operator: $or');
    expect(errorOf({ username: 'pilgrim', $and: [] })).toMatch(/unknown top-level operator: \$and/);
    expect(errorOf({ password: { ['$' + 'x'.repeat(500)]: 1 } }).length).toBeLessThan(260); // the key is clipped in the message
  });

  it('a query is validated as a whole before any document is looked at', () => {
    expect(errorOf({ username: 'zzz-no-match', password: { $foo: 1 } })).toBe('unknown operator: $foo');
    expect(errorOf({ username: 'pilgrim', password: { $regex: '[' } })).toMatch(/\$regex/);
  });
});

describe('docstore: $regex', () => {
  it('matches strings, case-sensitively unless $options is i', () => {
    expect(names({ username: { $regex: '^pil' } })).toBe('pilgrim');
    expect(names({ username: { $regex: '^PIL' } })).toBeNull();
    expect(names({ username: { $regex: '^PIL', $options: 'i' } })).toBe('pilgrim');
    expect(names({ username: { $regex: '^pil', $options: '' } })).toBe('pilgrim');
    expect(names({ password: { $regex: '.' } })).toBe('relic_admin');
    expect(names({ nosuch: { $regex: '.' } })).toBeNull(); // not a string
    expect(names({ password: { $regex: '^[0-9a-f]{16}$' } })).toBe('relic_admin');
  });

  it('only the i option exists, and $options needs $regex', () => {
    for (const o of ['m', 's', 'g', 'x', 'ii', 'im', ' i', 5, null, {}, ['i']]) expect(errorOf({ username: { $regex: 'a', $options: o } }), String(o)).toMatch(/\$options/);
    expect(errorOf({ username: { $options: 'i' } })).toMatch(/\$options needs \$regex/);
  });

  it('refuses what could backtrack badly: a long source, a quantified group, more than 4 quantifier characters', () => {
    expect(DOC_LIMITS.regexSource).toBe(64);
    expect(errorOf({ username: { $regex: 'a'.repeat(64) } })).toBe('');
    expect(errorOf({ username: { $regex: 'a'.repeat(65) } })).toMatch(/too long/);
    for (const p of ['(a+)+$', '(a*)*', '(a|aa)+', '(a?){5}', '(?:a+)+', '(a+)?', '(a)*', '(a){2}', '([a-z]+)*x']) {
      expect(errorOf({ username: { $regex: p } }), p).toMatch(/quantified group/);
    }
    expect(errorOf({ username: { $regex: 'a*a*a*a*' } })).toBe('');
    expect(errorOf({ username: { $regex: 'a*a*a*a*a*' } })).toMatch(/too many quantifiers/);
    expect(errorOf({ username: { $regex: 'a?b?c?d?e?' } })).toMatch(/too many quantifiers/);
    // An escaped paren is a literal, so the ? after it IS a quantifier (and "(?" group syntax is not).
    expect(errorOf({ username: { $regex: '\\(?'.repeat(10) } })).toMatch(/too many quantifiers/);
    expect(errorOf({ username: { $regex: '(?:a)(?=b)(?!c)' } })).toBe('');
    expect(errorOf({ username: { $regex: '.{1,3}.{1,3}.{1,3}.{1,3}.{1,3}' } })).toMatch(/too many quantifiers/);
  });

  it('the worst pattern that is allowed is fast on the longest document string', () => {
    const long = createStore([{ username: 'a'.repeat(32), username_lc: 'a'.repeat(32), password: 'a'.repeat(31) + 'b', role: 'x' }]);
    const t0 = performance.now();
    for (const p of ['a*a*a*a*c', '.*.*.*.*c', '[a-z]*[a-z]*[a-z]*[a-z]*1', 'a+a+a+a+c', '(?=a*a*a*)a*c']) {
      expect(long.findOne({ username: { $regex: p } }), p).toBeNull();
    }
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('an invalid or non-string pattern is an error, with the engine\'s own message clipped', () => {
    for (const p of ['[', '(', '\\', '*a', 'a{2,1}', '(?<n>a)(?<n>b)']) expect(errorOf({ username: { $regex: p } }), p).toMatch(/\$regex/);
    for (const p of [5, null, {}, ['a'], true, undefined]) expect(errorOf({ username: { $regex: p } }), String(p)).toMatch(/\$regex needs a string/);
  });
});

describe('docstore: $where, a small PARSED subset of JavaScript (never evaluated as code)', () => {
  const w = (expr: unknown, extra: Record<string, unknown> = {}) => names({ $where: expr, ...extra });

  it('this.<field> with == / === and string literals', () => {
    expect(w("this.username == 'pilgrim'")).toBe('pilgrim');
    expect(w('this.username === "pilgrim"')).toBe('pilgrim');
    expect(w("this.username != 'relic_admin'")).toBe('pilgrim');
    expect(w("this.username !== 'relic_admin'")).toBe('pilgrim');
    expect(w("this.username == 'zzz'")).toBeNull();
    expect(w("'pilgrim' == this.username")).toBe('pilgrim');
  });

  it('.toLowerCase() .toUpperCase() .trim() .length', () => {
    expect(w("this.username.toLowerCase() == 'brother_tobias'")).toBe('Brother_Tobias');
    expect(w("this.username.toUpperCase() == 'PILGRIM'")).toBe('pilgrim');
    expect(w("'  pilgrim '.trim() == this.username")).toBe('pilgrim');
    expect(w('this.username.length == 7')).toBe('pilgrim');
    expect(w('this.username.length > 11')).toBe('Brother_Tobias');
    expect(w("this.username.trim().toLowerCase().toUpperCase() == 'PILGRIM'")).toBe('pilgrim');
    expect(w("'abc'.length == 3")).toBe('relic_admin');
  });

  it('numbers, true, false, null and undefined', () => {
    expect(w('1 == 1')).toBe('relic_admin');
    expect(w('1.5 > 1')).toBe('relic_admin');
    expect(w("1 == '1'")).toBeNull(); // == is strict
    expect(w('true')).toBe('relic_admin');
    expect(w('false')).toBeNull();
    expect(w('null')).toBeNull();
    expect(w('undefined')).toBeNull();
    expect(w('0')).toBeNull();
    expect(w("''")).toBeNull();
    expect(w('this.nosuch == null')).toBe('relic_admin'); // == is strict EXCEPT null and undefined
    expect(w('this.nosuch == undefined')).toBe('relic_admin');
    expect(w('null == undefined')).toBe('relic_admin');
    expect(w('this.nosuch === null')).toBeNull();
    expect(w('this.username == null')).toBeNull();
    expect(w('this.username != null')).toBe('relic_admin');
    expect(w('0 == null')).toBeNull();
    expect(w("'' == null")).toBeNull();
  });

  it('< > <= >= compare a string with a string and a number with a number, anything else is false', () => {
    expect(w("this.username < 'q'")).toBe('pilgrim');
    expect(w("this.username >= 'r'")).toBe('relic_admin');
    expect(w('this.username.length <= 7')).toBe('pilgrim');
    expect(w("this.username.length > '3'")).toBeNull();
    expect(w('this.nosuch > 1')).toBeNull();
    expect(w('this.nosuch < 1')).toBeNull();
  });

  it('&& || ! and parentheses, with short-circuit evaluation and JS precedence', () => {
    expect(w("this.username == 'pilgrim' && this.password == 'pilgrim'")).toBe('pilgrim');
    expect(w("this.username == 'pilgrim' && this.password == 'x'")).toBeNull();
    expect(w("this.username == 'zzz' || this.password == 'ave-maria'")).toBe('Brother_Tobias');
    expect(w("!(this.username == 'relic_admin')")).toBe('pilgrim');
    expect(w("!!this.username")).toBe('relic_admin');
    expect(w("this.username == 'x' || this.username == 'pilgrim' && this.role == 'customer'")).toBe('pilgrim'); // && binds tighter
    expect(w("(this.username == 'relic_admin' || this.username == 'pilgrim') && this.role == 'customer'")).toBe('pilgrim');
    expect(w('1 < 2 == true')).toBe('relic_admin'); // relational binds tighter than equality
    expect(w("this.username == 'zzz' && this.nosuch.length")).toBeNull(); // the right side never runs, so no TypeError
    expect(w("this.username != 'zzz' || this.nosuch.length")).toBe('relic_admin');
    expect(w("'a' && 'b' == 'b'")).toBe('relic_admin');
  });

  it('// and /* */ comments', () => {
    expect(w("this.username == 'pilgrim' // && this.password == 'x'")).toBe('pilgrim');
    expect(w("this.username == 'pilgrim'//")).toBe('pilgrim');
    expect(w("this.username == /* the user */ 'pilgrim'")).toBe('pilgrim');
    expect(w("/* a */ this /* b */ . /* c */ username == 'pilgrim'")).toBe('pilgrim');
    expect(w("this.username == 'zzz' // comment\n|| this.username == 'pilgrim'")).toBe('pilgrim'); // a line comment ends at the newline
    expect(w("this.username == 'a//b' || this.username == 'pilgrim'")).toBe('pilgrim'); // // inside a string is no comment
  });

  it('string escapes are \\\\ \\\' and \\" only', () => {
    expect(w("'a\\\\b' == 'a\\\\b'")).toBe('relic_admin');
    expect(w("'it\\'s' == \"it's\"")).toBe('relic_admin');
    expect(w('"say \\"hi\\"" == \'say "hi"\'')).toBe('relic_admin');
    for (const bad of ["'\\n'", "'\\x41'", "'\\u0041'", "'\\0'"]) expect(errorOf({ $where: bad }), bad).toMatch(/^SyntaxError: .*escape/);
  });

  it('a $where value must be a string', () => {
    for (const bad of [1, true, null, undefined, {}, [], ['1']]) expect(errorOf({ $where: bad }), String(bad)).toMatch(/\$where needs a string/);
  });

  it('$where and field conditions must both hold', () => {
    expect(names({ role: 'customer', $where: "this.username == 'pilgrim'" })).toBe('pilgrim');
    expect(names({ role: 'admin', $where: "this.username == 'pilgrim'" })).toBeNull();
  });

  it('syntax errors are SyntaxError, name the expression (clipped to 200 characters) and never contain a document value', () => {
    for (const bad of [
      "this.username == 'pilgrim", 'this.username ==', '(', ')', 'this.', 'this..username', 'this.username.', "this.username = 'x'", 'a == b',
      'this.username & 1', 'this.username | 1', '1 +', '1 + 1', "'a' 'b'", '/* open', '@', '#', '{}', '[]', '`x`', "this.username == 'x';", 'this', '!', '1 2',
      'this.username.toLowerCase', 'this.username.toLowerCase(1)', "this.username.startsWith('p')", "this.username.substr(0)", 'this.username.valueOf()', 'this.username.toString()', 'this.username.constructor()', 'this.valueOf()',
      'this.username["x"]', 'this["username"]', 'process', 'globalThis', 'eval("1")', 'Function("return 1")()', 'require("fs")', 'x => x',
    ]) {
      const e = errorOf({ $where: bad });
      expect(e, bad).toMatch(/^SyntaxError: /);
      expect(e, bad).not.toMatch(/a1b2c3d4|ave-maria/);
    }
    const long = errorOf({ $where: `this.username == '${'x'.repeat(300)}` });
    expect(long).toMatch(/^SyntaxError: /);
    expect(long.length).toBeLessThan(400);
    expect(long).toContain('x'.repeat(100));
    expect(long).not.toContain('x'.repeat(250));
  });

  it('type errors are TypeError, raised only when evaluated', () => {
    expect(errorOf({ $where: 'this.nosuch.toLowerCase() == 1' })).toMatch(/^TypeError: /);
    expect(errorOf({ $where: 'this.nosuch.length > 1' })).toMatch(/^TypeError: /);
    expect(errorOf({ $where: 'null.length' })).toMatch(/^TypeError: /);
    expect(errorOf({ $where: '1.toLowerCase()' })).toMatch(/^(Syntax|Type)Error: /);
    expect(errorOf({ $where: '(1).toLowerCase()' })).toMatch(/^TypeError: /);
    expect(errorOf({ $where: 'true.trim()' })).toMatch(/^(Syntax|Type)Error: /);
    expect(errorOf({ $where: 'this.toLowerCase()' })).toMatch(/^TypeError: /);
    expect(errorOf({ $where: 'this.username.length.toLowerCase()' })).toMatch(/^TypeError: /);
    expect(errorOf({ $where: "this.nosuch.toLowerCase() == 1 || 'x'" }).startsWith('TypeError: ')).toBe(true);
  });

  it('cannot reach anything but the document: no prototype, no constructor, no globals, no calls', () => {
    expect(w('this.__proto__ == undefined')).toBe('relic_admin');
    expect(w('this.constructor == undefined')).toBe('relic_admin');
    expect(w('this.hasOwnProperty == undefined')).toBe('relic_admin');
    expect(errorOf({ $where: 'this.constructor.constructor' })).toMatch(/^TypeError: /);
    expect(errorOf({ $where: 'this.__proto__.polluted' })).toMatch(/^TypeError: /);
    expect(w("this.username.constructor == undefined")).toBe('relic_admin');
    expect(w("this.username.__proto__ == undefined")).toBe('relic_admin');
    expect(w("this.username.length.constructor == undefined")).toBe('relic_admin');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('is bounded: 1000 characters, 300 tokens, nesting depth 32', () => {
    expect(DOC_LIMITS.whereChars).toBe(1000);
    expect(DOC_LIMITS.whereTokens).toBe(300);
    expect(DOC_LIMITS.whereDepth).toBe(32);
    const pad = (n: number) => `/*${'x'.repeat(n)}*/`;
    expect(w(`true${pad(992)}`)).toBe('relic_admin'); // 1000 characters exactly
    expect(errorOf({ $where: `true${pad(993)}` })).toMatch(/^SyntaxError: expression too long/);
    const tokens = (k: number) => '!1' + '||1'.repeat(k); // 2 + 2k tokens in 2 + 3k characters
    expect(w(tokens(149))).toBe('relic_admin'); // exactly 300 tokens
    expect(errorOf({ $where: tokens(150) })).toMatch(/^SyntaxError: too many tokens/);
  });

  it('nesting beyond 32 is refused, 32 is fine, for parentheses and for !', () => {
    const parens = (n: number) => `${'('.repeat(n)}true${')'.repeat(n)}`;
    expect(w(parens(32))).toBe('relic_admin');
    expect(errorOf({ $where: parens(33) })).toMatch(/^SyntaxError: expression nested too deeply/);
    expect(errorOf({ $where: parens(5000) })).toMatch(/^SyntaxError: (expression nested too deeply|expression too long)/);
    expect(w(`${'!'.repeat(32)}true`)).toBe('relic_admin');
    expect(errorOf({ $where: `${'!'.repeat(33)}true` })).toMatch(/nested too deeply/);
    expect(errorOf({ $where: '!'.repeat(5000) + 'true' })).toMatch(/^SyntaxError: /);
  });
});

describe('docstore: the source never evaluates code', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = [
    ...readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => join(dir, f)),
    ...readdirSync(join(dir, 'levels')).filter((f) => f.endsWith('.ts')).map((f) => join(dir, 'levels', f)),
  ];

  it('covers the store, the model, the routes and every level', () => {
    const base = files.map((f) => f.slice(dir.length + 1).replace(/\\/g, '/'));
    expect(base).toEqual(expect.arrayContaining(['docstore.ts', 'model.ts', 'challenge.ts', 'levels/acolyte.ts', 'levels/templar.ts', 'levels/inquisitor.ts', 'levels/divine.ts']));
  });

  it('has no eval, Function, vm, dynamic import, require, child process, worker or any use of the name constructor (parsed, so comments do not count)', () => {
    const found: string[] = [];
    for (const f of files) found.push(...unsafeUses(f, readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });

  it('the guard itself sees the evasions: destructuring, a property descriptor lookup, a string key, a bracket access, a plain property access', () => {
    const bad = (code: string): string[] => unsafeUses('probe.ts', code);
    expect(bad('const { constructor: F } = fn; F("x");')).not.toEqual([]);
    expect(bad('const { constructor } = fn;')).not.toEqual([]);
    expect(bad('const d = Object.getOwnPropertyDescriptor(x, "constructor");')).not.toEqual([]);
    expect(bad('const o = { constructor: 1 };')).not.toEqual([]);
    expect(bad('const o = { "constructor": 1 };')).not.toEqual([]);
    expect(bad('x["constructor"]("y");')).not.toEqual([]);
    expect(bad('x.constructor("y");')).not.toEqual([]);
    expect(bad('Reflect.get(x, "constructor");')).not.toEqual([]);
    expect(bad('eval("1");')).not.toEqual([]);
    expect(bad('new Function("return 1");')).not.toEqual([]);
    expect(bad('import("node:vm");')).not.toEqual([]);
    expect(bad('import vm from "node:vm";')).not.toEqual([]);
    expect(bad('setTimeout("x()", 1);')).not.toEqual([]);
    // What is allowed: the SKIPPED list of keys the store ignores, and nothing else.
    expect(bad('const SKIPPED = new Set(["__proto__", "constructor", "prototype"]);')).toEqual([]);
    expect(bad('const OTHER = new Set(["constructor"]);')).not.toEqual([]);
    expect(bad('const x = 1; // constructor eval Function')).toEqual([]);
  });
});

/** Every use in the code of something that could reach dynamic code, as readable strings (empty when clean). Parsed, so comments never count. */
function unsafeUses(file: string, code: string): string[] {
  const BAD_IDS = new Set(['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'vm', 'require', 'globalThis', 'Reflect', 'Proxy', 'WebAssembly']);
  const BAD_MODULES = /^(node:)?(vm|child_process|worker_threads|cluster|repl|module|inspector)$/;
  const found: string[] = [];
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** The only place the name constructor may appear: the string list the store skips (const SKIPPED = new Set([...])). */
  const inSkippedList = (node: ts.Node): boolean => {
    const arr = node.parent;
    if (arr === undefined || !ts.isArrayLiteralExpression(arr)) return false;
    const call = arr.parent;
    if (!ts.isNewExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'Set') return false;
    const decl = call.parent;
    return ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) && decl.name.text === 'SKIPPED';
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && BAD_IDS.has(node.text)) found.push(file + ': identifier ' + node.text);
    if (ts.isIdentifier(node) && node.text === 'constructor') found.push(file + ': the name constructor (property, binding or key)');
    if (ts.isStringLiteralLike(node) && node.text === 'constructor' && !inSkippedList(node)) found.push(file + ': the string "constructor"');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push(file + ': dynamic import()');
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) && BAD_MODULES.test(node.moduleSpecifier.text)) {
      found.push(file + ': module ' + node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'setTimeout' || node.expression.text === 'setInterval') && node.arguments[0] !== undefined && ts.isStringLiteralLike(node.arguments[0])) found.push(file + ': string timer');
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
