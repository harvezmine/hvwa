// src/core/xss/limits.ts — the oracle's bounds. Every page it reads is attacker-influenced, and parse5 is synchronous:
// these keep one oracle call to a bounded amount of work (measured in tests/xss.spec.ts, "bounds").

/**
 * Bounds on what the XSS oracle parses. Measured with parse5 8.0.1 (Node 22): its worst inputs are superlinear (one
 * tag with thousands of distinct attributes: the tokenizer's duplicate check is quadratic; deep or misnested trees:
 * the tree builder's scope checks are O(depth) per token; an unclosed formatting element is rebuilt inside every
 * later block), so the page size and the tag count are capped BEFORE parsing, the tree is capped WHILE it is built
 * (a tree adapter counts every element parse5 creates, rebuilt copies included), and every further parse (framed
 * documents, the mXSS round trip) draws on one budget.
 */
export const XSS_LIMITS = Object.freeze({
  /** Longest page (UTF-16 code units) the oracle parses; a longer one is refused unparsed (`limited: 'size'`). */
  htmlLength: 16_384,
  /**
   * Most `<` that can open a tag, comment or doctype (`<` followed by a letter, `!`, `/` or `?`), counted before
   * parsing: an upper bound on tokens and tree depth, which keeps parse5's per-token scope checks linear-ish and its
   * EOF-in-template recursion shallow. A page with more is refused unparsed (`limited: 'tags'`).
   */
  tags: 1024,
  /**
   * Most elements one parse may create, counted as parse5 creates them (a formatting element rebuilt in every later
   * block counts each time): past it the parse stops and the page (or that framed document) is refused
   * (`limited: 'nodes'`). Four times the tag cap: implied and rebuilt elements of an ordinary page fit easily.
   */
  elements: 4 * 1024,
  /**
   * Most attribute text (names and values) one parse may create, rebuilt copies included: an unclosed `<a href=...>`
   * with a long href, copied into every later block, stops here (`limited: 'nodes'`).
   */
  attributeText: 8 * 16_384,
  /**
   * Deepest tree the mXSS round trip serializes (parse5's serializer recurses once per level; Chromium caps a parsed
   * DOM at the same depth). A deeper tree is still checked for sinks; only the round trip is skipped (`'depth'`).
   */
  depth: 512,
  /** How deep `<iframe srcdoc>` documents are read (a frame in a frame is 2); deeper ones are not (`'srcdoc'`). */
  srcdocDepth: 2,
  /** Characters parsed in all by one call: the page, its framed documents, and the round trip's re-parses (`'budget'`). */
  parseBudget: 4 * 16_384,
  /**
   * The mXSS round trips stop once this much time has passed since the call began (`'time'`): checked before each
   * round trip and every 256 elements inside its parse. Time never stops the page itself or its framed documents:
   * they are always read whole (the bounds above make that finish), so `executes` and `sinks` never depend on load.
   */
  timeMs: 250,
  /**
   * Most sinks a verdict lists (`executes` and `mxss` still consider all of them). Small on purpose: an XSS browser keeps
   * its last verdicts in the world, so 5 pages x (page + DOM write) x 16 sinks x 80 chars bounds that.
   */
  sinks: 16,
  /** Most URLs linkSinks returns. */
  links: 64,
  /** Longest sink detail kept ('iframe[srcdoc] > svg:a[xlink:href=javascript:]'). */
  detailLength: 80,
});
