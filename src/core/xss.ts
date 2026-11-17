// src/core/xss.ts — XSS labs (docs/RECIPES.md, "XSS labs"): import everything XSS from here.
//
// The proof is static and server-side: no player JavaScript ever runs in the server process. parse5 builds the tree a
// browser would build from the exact bytes the simulated admin receives, and a rules table decides whether attacker
// bytes made a sink that runs the lab's marker call `hvwa('<nonce>')` (per player and level).
//
//   core/xss/limits.ts   XSS_LIMITS: size, tag, depth, srcdoc and parse-budget bounds on every oracle call
//   core/xss/marker.ts   the marker call: markerCall(nonce), markerNonce, markerPattern
//   core/xss/rules.ts    the sink rules table (event handlers, script types, javascript:/data: URLs, sandbox)
//   core/xss/oracle.ts   xssOracle (sinks, marker reachability, mXSS round trip), roundTrip, linkSinks
//   core/xss/preview.ts  previewFrame: the sandboxed iframe the player watches the payload fire in
//
//   core/victim.ts       the victim side: newMarker() per player and level, xssBrowser (the admin views a page ->
//                        the oracle -> the stolen canary in the attacker log), XSS_STEAL_URL
//
// core/xss/ imports only parse5 and the sim's copying clip (tests/xss.spec.ts guards it); it is never reachable from
// core/sim/, whose no-network guard stays as it was.
export { XSS_LIMITS } from './xss/limits.js';
export { MARKER_FUNCTION, markerCall, markerNonce, markerPattern } from './xss/marker.js';
export {
  linkSinks, roundTrip, xssOracle,
  type LinkSink, type Sink, type SinkKind, type SinkTrigger, type XssInsertion, type XssLimit, type XssOracleOptions, type XssVerdict,
} from './xss/oracle.js';
export { PREVIEW_CSP, PREVIEW_SANDBOX, previewFrame, type PreviewOptions } from './xss/preview.js';
export { DOCUMENT_MIME_TYPES } from './xss/rules.js';
export {
  XSS_STEAL_URL, newMarker, rendersDocument, xssBrowser,
  type XssBrowser, type XssDomWrite, type XssMarker, type XssPage, type XssPageVerdict, type XssVictimOptions,
} from './victim.js';
