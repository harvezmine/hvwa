import { describe, it, expect } from 'vitest';
import { diffLines, splitLines } from '../src/core/diff.js';

const kinds = (a: string, b: string) => diffLines(a, b).map((r) => r.kind);

describe('diffLines (LCS)', () => {
  it('treats empty input as zero lines', () => {
    expect(splitLines('')).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
  });

  it("'' vs 'a' is a single add row (no empty left line)", () => {
    expect(diffLines('', 'a')).toEqual([{ kind: 'add', right: 'a' }]);
  });

  it("'a' vs '' is a single del row", () => {
    expect(diffLines('a', '')).toEqual([{ kind: 'del', left: 'a' }]);
  });

  it('aligns an insertion without shifting later lines', () => {
    expect(kinds('a\nb\nc', 'a\nX\nb\nc')).toEqual(['same', 'add', 'same', 'same']);
  });

  it('pairs a replacement into one changed row', () => {
    expect(diffLines('a\nold\nc', 'a\nnew\nc')[1]).toEqual({ kind: 'changed', left: 'old', right: 'new' });
  });

  it('normalises CRLF and one trailing newline', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});
