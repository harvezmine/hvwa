// src/districts/relic-market/_shared/sql.ts — the Relic Market's SQL read helpers now live in districts/_shared/sql.ts
// (every district's SQL labs use them). This file only re-exports them under their old names, so the Relic Market labs
// keep importing from here: `clip` is the shared `cell` (display text, at most n characters).
export { firstRows, cell as clip } from '../../_shared/sql.js';
