// docstore.ts — RM-04's document store: the lab's "database", a few staff accounts and a MongoDB-style query matcher.
// Plumbing, not a lesson: which operators a request can reach is decided in levels/*.ts. Not served by View Source.
//
// SAFETY (platform rules, not the lesson). There is no real MongoDB and no dependency. Nothing here ever evaluates code:
// no eval, no Function, no vm, no dynamic import. `$where` is a small JavaScript SUBSET that is TOKENIZED and PARSED
// here and then walked as a tree (a guard test in docstore.spec.ts parses this folder's sources and fails on any of
// those). Every query value is treated as hostile: only own properties are read (Object.hasOwn), the keys __proto__,
// constructor and prototype are skipped, operators nest at most DOC_LIMITS.notDepth deep, `$regex` is bounded (below)
// and every document string is short, so no input can burn CPU or memory. Plain objects and arrays given as values are
// never walked, so a 20 000-level body costs nothing.

/** The bounds every query is held to. */
export const DOC_LIMITS = Object.freeze({
  /** The longest string in a stored document (what the `$regex` bound is computed against). */
  docString: 32,
  /** `$regex`: the longest pattern, and the most quantifier characters (* + ? {) it may contain. */
  regexSource: 64,
  regexQuantifiers: 4,
  /** `$in` / `$nin`: the most values. */
  inItems: 20,
  /** `$not` inside `$not`. */
  notDepth: 5,
  /** `$where`: characters, tokens and nesting (parentheses and `!`). */
  whereChars: 1000,
  whereTokens: 300,
  whereDepth: 32,
  /** Echoes of attacker text in an error message are clipped to this many characters. */
  messageClip: 200,
});

/** A stored document: a frozen null-prototype object of short strings. */
export type Doc = Readonly<Record<string, string>>;

/** The store: `findOne` returns the first matching document in insertion order, null for none, and throws StoreError for a query it refuses. */
export interface DocStore {
  findOne(query: unknown): Doc | null;
}

/** A refused query. Its message is what the route shows below Divine (`Query error: <message>`). */
export class StoreError extends Error {}

const clip = (s: string, n: number = DOC_LIMITS.messageClip): string => (s.length > n ? s.slice(0, n) : s);
const refuse = (message: string): never => { throw new StoreError(message); };

/** Keys that never take part in a query: the usual prototype-pollution names. */
const SKIPPED = new Set(['__proto__', 'constructor', 'prototype']);
const isPlain = (v: unknown): v is object => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A value object's OWN keys (Object.keys), without the skipped ones. */
const keysOf = (o: object): string[] => Object.keys(o).filter((k) => !SKIPPED.has(k));
/** An own property of a plain value, read only for a key keysOf returned. */
const ownValue = (o: object, key: string): unknown => (Object.hasOwn(o, key) ? Object.getOwnPropertyDescriptor(o, key)?.value : undefined);

type FieldPred = (value: unknown) => boolean;
type DocPred = (doc: Doc) => boolean;

/** Equality as the store means it: `undefined` matches only a missing field, `null` a missing or null one, objects and arrays nothing, else same type and equal. */
function equals(have: unknown, want: unknown): boolean {
  if (want === undefined) return have === undefined;
  if (want === null) return have === undefined || have === null;
  if (typeof want === 'object') return false;
  return typeof have === typeof want && have === want;
}

/** -1, 0 or 1 for two strings or two numbers; undefined for anything else (then every comparison is false). */
function compare(a: unknown, b: unknown): number | undefined {
  const same = (typeof a === 'string' && typeof b === 'string') || (typeof a === 'number' && typeof b === 'number');
  if (!same || Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return (a as string | number) < (b as string | number) ? -1 : (a as string | number) > (b as string | number) ? 1 : 0;
}

const isPrimitive = (v: unknown): boolean => v === null || (typeof v !== 'object' && typeof v !== 'function' && typeof v !== 'undefined');

/** `$regex` with a bound: a short pattern, no quantified group, at most 4 quantifier characters. Matched only against strings of at most DOC_LIMITS.docString characters, so even the worst allowed pattern costs a few thousand steps. */
function safeRegex(source: string, flags: string): RegExp {
  if (source.length > DOC_LIMITS.regexSource) refuse(`$regex pattern too long (max ${DOC_LIMITS.regexSource} characters)`);
  if (/\)[*+?{]/.test(source)) refuse('$regex quantified groups are not allowed');
  let quantifiers = 0;
  let escaped = false;
  let previous = '';
  for (const ch of source) {
    if (escaped) { escaped = false; previous = ""; continue; } // an escaped character is a literal, never the "(" of "(?"
    else if (ch === '\\') escaped = true;
    else if ('*+?{'.includes(ch) && !(ch === '?' && previous === '(')) quantifiers++; // "(?" is group syntax, not a quantifier
    previous = ch;
  }
  if (quantifiers > DOC_LIMITS.regexQuantifiers) refuse(`$regex has too many quantifiers (max ${DOC_LIMITS.regexQuantifiers})`);
  try {
    return new RegExp(source, flags);
  } catch (err) {
    return refuse(`$regex is not a valid pattern: ${clip(err instanceof Error ? err.message : String(err))}`);
  }
}

/** Compile the operators of one value object (all keys start with `$`). `depth` counts the `$not`s around it. */
function compileOps(ops: object, keys: readonly string[], depth: number): FieldPred {
  const preds: FieldPred[] = [];
  const hasRegex = keys.includes('$regex');
  for (const key of keys) {
    const operand = ownValue(ops, key);
    switch (key) {
      case '$eq': preds.push((v) => equals(v, operand)); break;
      case '$ne': preds.push((v) => !equals(v, operand)); break;
      case '$gt': preds.push((v) => (compare(v, operand) ?? -1) > 0); break;
      case '$gte': preds.push((v) => (compare(v, operand) ?? -1) >= 0); break;
      case '$lt': preds.push((v) => (compare(v, operand) ?? 1) < 0); break;
      case '$lte': preds.push((v) => (compare(v, operand) ?? 1) <= 0); break;
      case '$in':
      case '$nin': {
        if (!Array.isArray(operand)) refuse(`${key} needs an array`);
        const list: unknown[] = Array.isArray(operand) ? operand : [];
        if (list.length > DOC_LIMITS.inItems) refuse(`${key} takes at most ${DOC_LIMITS.inItems} values`);
        if (!list.every(isPrimitive)) refuse(`${key} values must be primitives`);
        preds.push(key === '$in' ? (v) => list.some((w) => equals(v, w)) : (v) => !list.some((w) => equals(v, w)));
        break;
      }
      case '$exists': {
        const want = operand === true || operand === 'true' ? true : operand === false || operand === 'false' ? false : refuse('$exists needs true or false');
        preds.push((v) => (v !== undefined) === want);
        break;
      }
      case '$not': {
        if (depth + 1 > DOC_LIMITS.notDepth) refuse('$not nested too deeply');
        const inner = isPlain(operand) ? keysOf(operand) : [];
        if (!isPlain(operand) || inner.length === 0 || !inner.some((k) => k.startsWith('$'))) refuse('$not needs an operator expression');
        if (!inner.every((k) => k.startsWith('$'))) refuse('cannot mix operators and fields in one value');
        const test = compileOps(isPlain(operand) ? operand : {}, inner, depth + 1);
        preds.push((v) => !test(v));
        break;
      }
      case '$regex': {
        if (typeof operand !== 'string') refuse('$regex needs a string');
        const options = Object.hasOwn(ops, '$options') ? ownValue(ops, '$options') : '';
        if (options !== '' && options !== 'i') refuse('Unsupported $options (only "i")');
        const re = safeRegex(typeof operand === 'string' ? operand : '', options === 'i' ? 'i' : '');
        preds.push((v) => typeof v === 'string' && re.test(v));
        break;
      }
      case '$options': {
        if (!hasRegex) refuse('$options needs $regex');
        const options = ownValue(ops, '$options');
        if (options !== '' && options !== 'i') refuse('Unsupported $options (only "i")');
        break;
      }
      default:
        refuse(`unknown operator: ${clip(key)}`);
    }
  }
  return (v) => preds.every((p) => p(v));
}

function compileField(name: string, value: unknown): DocPred {
  const read = (doc: Doc): unknown => (Object.hasOwn(doc, name) ? doc[name] : undefined);
  if (Array.isArray(value)) return () => false; // an array never equals a document value
  if (isPlain(value)) {
    const keys = keysOf(value);
    const ops = keys.filter((k) => k.startsWith('$'));
    if (ops.length === 0) return () => false; // a plain object (or one with only skipped keys) never equals a string
    if (ops.length !== keys.length) refuse('cannot mix operators and fields in one value');
    const test = compileOps(value, keys, 0);
    return (doc) => test(read(doc));
  }
  return (doc) => equals(read(doc), value);
}

// --- $where: a small JavaScript subset, parsed and walked, never evaluated as code --------------------------------------------

type Lit = string | number | boolean | null | undefined;
type Node =
  | { readonly k: 'lit'; readonly v: Lit }
  | { readonly k: 'this' }
  | { readonly k: 'prop'; readonly obj: Node; readonly name: string }
  | { readonly k: 'call'; readonly obj: Node; readonly name: string }
  | { readonly k: 'not'; readonly arg: Node }
  | { readonly k: 'logic'; readonly op: '&&' | '||'; readonly l: Node; readonly r: Node }
  | { readonly k: 'bin'; readonly op: '==' | '!=' | '===' | '!==' | '<' | '>' | '<=' | '>='; readonly l: Node; readonly r: Node };
type Tok = { readonly t: 'num' | 'str' | 'id' | 'op'; readonly v: string | number };

const METHODS = new Set(['toLowerCase', 'toUpperCase', 'trim']);
const LINE_END = /[\n\r\u2028\u2029]/;

/** SyntaxError / TypeError in the engine's style, with the expression (clipped) so the player sees what the app built. */
function fail(kind: 'SyntaxError' | 'TypeError', detail: string, src: string): never {
  return refuse(`${kind}: ${detail} in expression: ${clip(src)}`);
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const add = (t: Tok): void => {
    toks.push(t);
    if (toks.length > DOC_LIMITS.whereTokens) fail('SyntaxError', `too many tokens (max ${DOC_LIMITS.whereTokens})`, src);
  };
  const NUM = /\d+(?:\.\d+)?/y;
  const IDENT = /[A-Za-z_$][\w$]*/y;
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src.charAt(i + 1) === '/') { // a line comment ends at the line end
      while (i < src.length && !LINE_END.test(src.charAt(i))) i++;
      continue;
    }
    if (c === '/' && src.charAt(i + 1) === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('SyntaxError', 'unterminated comment', src);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        const ch = src.charAt(j);
        if (j >= src.length || LINE_END.test(ch)) fail('SyntaxError', 'invalid or unexpected token (unterminated string)', src);
        if (ch === c) break;
        if (ch === '\\') {
          const next = src.charAt(j + 1);
          if (next !== '\\' && next !== "'" && next !== '"') fail('SyntaxError', `invalid escape sequence (only \\\\, \\' and \\" exist here)`, src);
          value += next;
          j += 2;
        } else { value += ch; j++; }
      }
      add({ t: 'str', v: value });
      i = j + 1;
      continue;
    }
    if (c >= '0' && c <= '9') {
      NUM.lastIndex = i;
      const text = NUM.exec(src)?.[0] ?? c;
      i += text.length;
      if (/[A-Za-z_$]/.test(src.charAt(i))) fail('SyntaxError', 'invalid or unexpected token (an identifier right after a number)', src);
      add({ t: 'num', v: Number(text) });
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      IDENT.lastIndex = i;
      const text = IDENT.exec(src)?.[0] ?? c;
      i += text.length;
      add({ t: 'id', v: text });
      continue;
    }
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    const op = three === '===' || three === '!==' ? three : ['==', '!=', '<=', '>=', '&&', '||'].includes(two) ? two : '<>!().'.includes(c) ? c : '';
    if (op === '') fail('SyntaxError', `unexpected token '${c}'`, src);
    add({ t: 'op', v: op });
    i += op.length;
  }
  return toks;
}

/** Parse an expression into a tree (recursive descent; JS precedence: ! over relational over equality over && over ||). */
function parseWhere(src: string): Node {
  if (src.length > DOC_LIMITS.whereChars) fail('SyntaxError', `expression too long (max ${DOC_LIMITS.whereChars} characters)`, src);
  const toks = tokenize(src);
  let pos = 0;
  let depth = 0;
  const peekOp = (): string | undefined => { const t = toks[pos]; return t !== undefined && t.t === 'op' ? String(t.v) : undefined; };
  const describe = (t: Tok | undefined): string => (t === undefined ? 'end of input' : t.t === 'str' ? 'string' : t.t === 'num' ? 'number' : t.t === 'id' ? `identifier '${String(t.v)}'` : `token '${String(t.v)}'`);
  const unexpected = (): never => fail('SyntaxError', `unexpected ${describe(toks[pos])}`, src);
  const enter = (): void => { depth++; if (depth > DOC_LIMITS.whereDepth) fail('SyntaxError', 'expression nested too deeply', src); };

  const primary = (): Node => {
    const t = toks[pos];
    if (t === undefined) return unexpected();
    if (t.t === 'num' || t.t === 'str') { pos++; return { k: 'lit', v: t.v }; }
    if (t.t === 'id') {
      pos++;
      switch (t.v) {
        case 'true': return { k: 'lit', v: true };
        case 'false': return { k: 'lit', v: false };
        case 'null': return { k: 'lit', v: null };
        case 'undefined': return { k: 'lit', v: undefined };
        case 'this':
          if (peekOp() !== '.') return fail('SyntaxError', "'this' must be followed by .field", src);
          return { k: 'this' };
        default: pos--; return unexpected();
      }
    }
    if (t.v === '(') {
      enter();
      pos++;
      const inner = or();
      if (peekOp() !== ')') return unexpected();
      pos++;
      depth--;
      return inner;
    }
    return unexpected();
  };
  const member = (): Node => {
    let node = primary();
    while (peekOp() === '.') {
      pos++;
      const name = toks[pos];
      if (name === undefined || name.t !== 'id') return unexpected();
      pos++;
      const id = String(name.v);
      if (peekOp() === '(') {
        if (!METHODS.has(id)) return fail('SyntaxError', `unsupported method '${clip(id, 40)}' (only toLowerCase, toUpperCase and trim exist here)`, src);
        pos++;
        if (peekOp() !== ')') return fail('SyntaxError', `${id}() takes no arguments`, src);
        pos++;
        node = { k: 'call', obj: node, name: id };
      } else if (METHODS.has(id)) {
        return fail('SyntaxError', `expected '(' after ${id}`, src);
      } else node = { k: 'prop', obj: node, name: id };
    }
    return node;
  };
  const unary = (): Node => {
    if (peekOp() !== '!') return member();
    enter();
    pos++;
    const arg = unary();
    depth--;
    return { k: 'not', arg };
  };
  const rel = (): Node => {
    let l = unary();
    for (let op = peekOp(); op === '<' || op === '>' || op === '<=' || op === '>='; op = peekOp()) { pos++; l = { k: 'bin', op, l, r: unary() }; }
    return l;
  };
  const eq = (): Node => {
    let l = rel();
    for (let op = peekOp(); op === '==' || op === '!=' || op === '===' || op === '!=='; op = peekOp()) { pos++; l = { k: 'bin', op, l, r: rel() }; }
    return l;
  };
  const and = (): Node => {
    let l = eq();
    while (peekOp() === '&&') { pos++; l = { k: 'logic', op: '&&', l, r: eq() }; }
    return l;
  };
  function or(): Node {
    let l = and();
    while (peekOp() === '||') { pos++; l = { k: 'logic', op: '||', l, r: and() }; }
    return l;
  }
  const ast = or();
  if (pos < toks.length) return unexpected();
  return ast;
}

const truthy = (v: unknown): boolean => !(v === false || v === 0 || v === '' || v === null || v === undefined || Number.isNaN(v));
/** `==` is strict, except that null and undefined are equal to each other. */
const looseEquals = (a: unknown, b: unknown): boolean => ((a === null || a === undefined) && (b === null || b === undefined)) || a === b;

function evaluate(node: Node, doc: Doc, src: string): unknown {
  switch (node.k) {
    case 'lit': return node.v;
    case 'this': return doc;
    case 'not': return !truthy(evaluate(node.arg, doc, src));
    case 'logic': {
      const l = evaluate(node.l, doc, src);
      return node.op === '&&' ? (truthy(l) ? evaluate(node.r, doc, src) : l) : (truthy(l) ? l : evaluate(node.r, doc, src));
    }
    case 'prop': {
      const o = evaluate(node.obj, doc, src);
      if (o === undefined || o === null) return fail('TypeError', `cannot read properties of ${String(o)} (reading '${clip(node.name, 40)}')`, src);
      if (o === doc) return Object.hasOwn(doc, node.name) ? doc[node.name] : undefined; // fields only, never the prototype
      return typeof o === 'string' && node.name === 'length' ? o.length : undefined;
    }
    case 'call': {
      const o = evaluate(node.obj, doc, src);
      if (o === undefined || o === null) return fail('TypeError', `cannot read properties of ${String(o)} (reading '${node.name}')`, src);
      if (typeof o !== 'string') return fail('TypeError', `${node.name} is not a function`, src);
      return node.name === 'toLowerCase' ? o.toLowerCase() : node.name === 'toUpperCase' ? o.toUpperCase() : o.trim();
    }
    case 'bin': {
      const l = evaluate(node.l, doc, src);
      const r = evaluate(node.r, doc, src);
      switch (node.op) {
        case '==': return looseEquals(l, r);
        case '!=': return !looseEquals(l, r);
        case '===': return l === r;
        case '!==': return l !== r;
        case '<': return (compare(l, r) ?? 1) < 0;
        case '>': return (compare(l, r) ?? -1) > 0;
        case '<=': return (compare(l, r) ?? 1) <= 0;
        default: return (compare(l, r) ?? -1) >= 0;
      }
    }
  }
}

function compileWhere(src: unknown): DocPred {
  if (typeof src !== 'string') return refuse('$where needs a string');
  const ast = parseWhere(src);
  return (doc) => truthy(evaluate(ast, doc, src));
}

// --- The store ----------------------------------------------------------------------------------------------------------------

function compileQuery(query: unknown): DocPred {
  if (!isPlain(query)) return refuse('query must be an object');
  const preds: DocPred[] = [];
  for (const key of keysOf(query)) {
    const value = ownValue(query, key);
    if (!key.startsWith('$')) preds.push(compileField(key, value));
    else if (key === '$where') preds.push(compileWhere(value));
    else refuse(`unknown top-level operator: ${clip(key)}`);
  }
  return (doc) => preds.every((p) => p(doc));
}

/** A store of `docs` (each a few short strings), kept as frozen null-prototype objects in the order given. */
export function createStore(docs: readonly Readonly<Record<string, string>>[]): DocStore {
  const stored: Doc[] = docs.map((d) => {
    const doc: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(d)) {
      if (v.length > DOC_LIMITS.docString) throw new Error(`document string "${k}" is longer than ${DOC_LIMITS.docString} characters`);
      doc[k] = v;
    }
    return Object.freeze(doc);
  });
  return Object.freeze({
    findOne(query: unknown): Doc | null {
      const test = compileQuery(query); // the whole query is validated before any document is looked at
      return stored.find(test) ?? null;
    },
  });
}
