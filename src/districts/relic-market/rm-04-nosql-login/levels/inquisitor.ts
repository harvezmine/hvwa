import type { Doc, DocStore } from '../docstore.js';
import { raw } from '../model.js';

// INQUISITOR — real defense against operator objects, subtly wrong: both fields are forced to TEXT, so an object can no
// longer be an operator. But the lookup is case-insensitive, and that is written as a $where expression built by
// pasting the two texts into a string. A quote in the text ends the string literal and the rest is the attacker's.
//
// THE $where LANGUAGE (this lab never runs real JavaScript: the store parses this small subset and walks the tree;
// its code is plumbing and is not served, so the whole subset is listed here):
//   - this.<field>           a field of the document being tested (username, username_lc, password, role); a missing one is undefined
//   - .toLowerCase()  .toUpperCase()  .trim()   on a string, no arguments;   .length   of a string
//   - literals: 'single' or "double" quoted strings (escapes: \\ \' \" only), numbers like 12 or 1.5, true, false, null, undefined
//   - comparisons:  ==  ===  !=  !==  <  >  <=  >=     (== is strict, except that null == undefined; < > <= >= compare
//                   two strings or two numbers, anything else is false)
//   - logic and grouping:  &&  ||  !  and ( ... ), with JavaScript's precedence and short-circuit rules
//   - comments:  // to the end of the line, and /* ... */
//   - limits: 1000 characters, 300 tokens, nesting depth 32. Anything else (a call, an assignment, a global such as
//     process or eval, ;, [ ], { }, a template string) is a SyntaxError. A bad property access is a TypeError. Errors
//     name the expression, clipped to 200 characters.
// The first document that makes the whole expression truthy is the signed-in account (the admin is stored first).
export function login(store: DocStore, body: unknown): Doc | null {
  const u = String(raw(body, 'username') ?? '').toLowerCase();
  const p = String(raw(body, 'password') ?? '');
  return store.findOne({ $where: "this.username.toLowerCase() == '" + u + "' && this.password == '" + p + "'" });
}
