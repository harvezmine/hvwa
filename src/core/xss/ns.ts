// src/core/xss/ns.ts — the namespaces the rules and the XML reader name (their own module: the rules read data: SVG
// images with the XML reader, which needs them too, and neither imports the other's module for them).
export const NS = Object.freeze({
  HTML: 'http://www.w3.org/1999/xhtml',
  SVG: 'http://www.w3.org/2000/svg',
  MATHML: 'http://www.w3.org/1998/Math/MathML',
  XLINK: 'http://www.w3.org/1999/xlink',
  XML: 'http://www.w3.org/XML/1998/namespace',
  XMLNS: 'http://www.w3.org/2000/xmlns/',
});
