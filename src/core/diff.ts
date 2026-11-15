// src/core/diff.ts — LCS line diff (pure; rendering lives in render.ts).

export type DiffRow =
  | { kind: 'same'; left: string; right: string }
  | { kind: 'changed'; left: string; right: string }
  | { kind: 'del'; left: string }
  | { kind: 'add'; right: string };

type Op = { kind: 'same' | 'del' | 'add'; text: string };

/** Split into lines: CRLF = LF, one trailing newline ignored, '' = no lines. */
export function splitLines(src: string): string[] {
  if (src === '') return [];
  const lines = src.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Classic LCS over lines → same / del (left only) / add (right only).
function lineOps(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ kind: 'del', text: a[i++] });
    else ops.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) ops.push({ kind: 'del', text: a[i++] });
  while (j < m) ops.push({ kind: 'add', text: b[j++] });
  return ops;
}

/**
 * Side-by-side rows for `left` vs `right`: each run of deletions/insertions
 * pairs into "changed" rows, leftovers stay one-sided.
 */
export function diffLines(left: string, right: string): DiffRow[] {
  const ops = lineOps(splitLines(left), splitLines(right));
  const rows: DiffRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.kind === 'same') { rows.push({ kind: 'same', left: op.text, right: op.text }); k++; continue; }
    const dels: string[] = [];
    const adds: string[] = [];
    while (k < ops.length && ops[k].kind !== 'same') {
      (ops[k].kind === 'del' ? dels : adds).push(ops[k].text);
      k++;
    }
    const paired = Math.min(dels.length, adds.length);
    for (let p = 0; p < paired; p++) rows.push({ kind: 'changed', left: dels[p], right: adds[p] });
    for (const l of dels.slice(paired)) rows.push({ kind: 'del', left: l });
    for (const r of adds.slice(paired)) rows.push({ kind: 'add', right: r });
  }
  return rows;
}
