// src/range/modes.ts — per-lab scoring mode (lab_modes, migration 5): 'individual' (the default) or 'team'.
// The admin dashboard (a later task) calls setLabMode; the catalog, lab pages and team leaderboard read it.
// No row means individual, so a lab keeps its current behaviour until an admin flips it.
import type { DatabaseSync } from 'node:sqlite';

export const LAB_MODES = Object.freeze(['individual', 'team'] as const);
export type LabMode = (typeof LAB_MODES)[number];
export const isLabMode = (x: unknown): x is LabMode => typeof x === 'string' && (LAB_MODES as readonly string[]).includes(x);

/** The mode of one lab (individual when no row is stored). */
export function labMode(db: DatabaseSync, labId: string): LabMode {
  const r = db.prepare('SELECT mode FROM lab_modes WHERE lab_id = ?').get(labId) as { mode: string } | undefined;
  return isLabMode(r?.mode) ? r.mode : 'individual';
}

/** Every stored mode, by lab id (labs with no row are absent: individual is the default). */
export function labModes(db: DatabaseSync): Map<string, LabMode> {
  const rows = db.prepare('SELECT lab_id, mode FROM lab_modes').all() as { lab_id: string; mode: string }[];
  const out = new Map<string, LabMode>();
  for (const r of rows) if (isLabMode(r.mode)) out.set(r.lab_id, r.mode);
  return out;
}

/** Upsert a lab's mode (the later admin dashboard's switch). `by` is the acting admin's id, when known. */
export function setLabMode(db: DatabaseSync, labId: string, mode: LabMode, by: number | undefined, at: number): void {
  db.prepare(`INSERT INTO lab_modes (lab_id, mode, updated_at, updated_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (lab_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(labId, mode, at, by ?? null);
}

/** A lab's stored mode row plus who last changed it (undefined when the lab still has the default: no row). */
export interface LabModeMeta {
  readonly mode: LabMode;
  readonly updatedAt: number;
  readonly updatedBy: number | null;
  readonly updatedByName: string | null;
}

/** The last-updated metadata the admin dashboard's Labs page shows (undefined = never changed). */
export function labModeMeta(db: DatabaseSync, labId: string): LabModeMeta | undefined {
  const r = db.prepare(`SELECT lm.mode AS mode, lm.updated_at AS updated_at, lm.updated_by AS updated_by,
    u.username AS updated_by_name FROM lab_modes lm LEFT JOIN users u ON u.id = lm.updated_by WHERE lm.lab_id = ?`)
    .get(labId) as { mode: string; updated_at: number; updated_by: number | null; updated_by_name: string | null } | undefined;
  if (!r) return undefined;
  return {
    mode: isLabMode(r.mode) ? r.mode : 'individual', updatedAt: Number(r.updated_at),
    updatedBy: r.updated_by === null ? null : Number(r.updated_by), updatedByName: r.updated_by_name,
  };
}
