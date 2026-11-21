// src/core/page-csp.ts — the Content-Security-Policy of a platform/portal PAGE (the login, account, registration and
// range pages): scripts, styles and images only from this origin, and only HVWA itself may frame the page. Shared by the
// range router (src/range/index.ts) and the auth routers (src/auth), which mount outside it. Labs are never covered:
// a lab's framing and scripts are its lesson, set per level by setLabHeaders (core/http.ts).
export const SCOPED_PAGE_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'self'";
