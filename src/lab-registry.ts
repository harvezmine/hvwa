// src/lab-registry.ts — the range's lab registry (labs/registry.json, spec 2026-11-20 range §8.4 and §12): one entry per
// lab image = the lab's manifest (lab.json) + its version + its image pinned by digest. Data only (zod). The portal
// reads it for the catalog and the scoring; the warden for the image allowlist, the container template and the Traefik
// labels. Nothing else decides which image a range container runs, and no key here can widen a container.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { FLAG_LEVELS, LEVELS, pointsForLevel, type Level } from './core/levels.js';

/** r00..r99 (lower case: Docker repository names, hvwa-lab/<id>:<version>). r00 is the fixture lab. */
export const LAB_ID_RE = /^r\d{2}$/;
export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'expert'] as const);
export type Difficulty = (typeof DIFFICULTIES)[number];
/** Base points per rating (spec §8.2); a level scales them like every other challenge (core/levels.ts). */
export const DIFFICULTY_POINTS: Readonly<Record<Difficulty, number>> = Object.freeze({ easy: 100, medium: 200, hard: 300, expert: 400 });
/**
 * An image the warden may run: `sha256:<64 hex>` (a local image id, for a lab built on this host) or
 * `<repo>[:<tag>]@sha256:<64 hex>` (a pulled image, by its manifest digest). A tag alone is never enough.
 */
export const IMAGE_REF_RE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@)?sha256:[a-f0-9]{64}$/;
/** Where the lab's start hook plants the flag (spec §6, §8.4). */
export const FLAG_PLACEMENT_RE = /^(?:file:\/[A-Za-z0-9_./-]{1,200}|db:[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}|env-only|custom)$/;
/** Spec §7's defaults, which are also the ceilings: a manifest may only lower them. */
export const LAB_LIMITS = Object.freeze({ memoryMiB: 256, pids: 128, cpus: 0.5, tmpfsMiB: 64 });

const text = z.object({ en: z.string().trim().min(1).max(600), id: z.string().trim().min(1).max(600) }).strict();
const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const tmpfsPath = z.string().regex(/^\/[A-Za-z0-9_./-]{1,100}$/)
  .refine((p) => !p.split('/').includes('..') && !p.includes('//'), 'must be a plain absolute path');

export const labManifestSchema = z.object({
  id: z.string().regex(LAB_ID_RE, 'must be r00..r99'),
  slug: z.string().max(40).regex(kebab),
  title: text,
  app: z.string().trim().min(1).max(60),
  category: z.string().trim().min(1).max(60),
  difficulty: z.enum(DIFFICULTIES),
  levels: z.array(z.enum(LEVELS)).min(1).max(4)
    .refine((ls) => new Set(ls).size === ls.length, 'levels must be unique')
    .refine((ls) => ls.some((l) => FLAG_LEVELS.includes(l)), 'needs at least one exploitable level'),
  port: z.number().int().min(1024).max(65535),
  health: z.string().regex(/^\/[\x21-\x7e]{0,199}$/, 'must be a path such as /healthz'),
  flag: z.object({ placement: z.string().regex(FLAG_PLACEMENT_RE) }).strict(),
  resources: z.object({
    memoryMiB: z.number().int().min(32).max(LAB_LIMITS.memoryMiB),
    pids: z.number().int().min(16).max(LAB_LIMITS.pids),
    cpus: z.number().min(0.1).max(LAB_LIMITS.cpus),
  }).partial().strict().default({}),
  tmpfs: z.array(z.object({ path: tmpfsPath, sizeMiB: z.number().int().min(1).max(LAB_LIMITS.tmpfsMiB) }).strict())
    .min(1).max(8)
    .default([{ path: '/tmp', sizeMiB: LAB_LIMITS.tmpfsMiB }])
    .refine((ts) => ts.reduce((n, t) => n + t.sizeMiB, 0) <= LAB_LIMITS.tmpfsMiB, `tmpfs sizes must total at most ${LAB_LIMITS.tmpfsMiB} MiB`)
    .refine((ts) => new Set(ts.map((t) => t.path)).size === ts.length, 'tmpfs paths must be unique'),
  needsBot: z.boolean(),
  themeId: z.string().max(40).regex(kebab),
  scenario: text,
  briefing: text,
  hints: z.array(z.object({
    id: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    cost: z.number().int().min(0).max(1000),
    text,
  }).strict()).max(3).default([])
    .refine((hs) => new Set(hs.map((h) => h.id)).size === hs.length, 'hint ids must be unique'),
}).strict();

export const registryEntrySchema = labManifestSchema.extend({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be x.y.z'),
  image: z.string().regex(IMAGE_REF_RE, 'image must be pinned by digest (sha256:...)'),
}).strict();

const registrySchema = z.object({ schema: z.literal(1), labs: z.array(registryEntrySchema).max(100) }).strict()
  .superRefine((r, ctx) => {
    for (const key of ['id', 'slug'] as const) {
      const seen = new Set<string>();
      r.labs.forEach((lab, i) => {
        if (seen.has(lab[key])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labs', i, key], message: `duplicate ${key} ${lab[key]}` });
        seen.add(lab[key]);
      });
    }
  });

export type LabManifest = z.output<typeof labManifestSchema>;
export type LabEntry = z.output<typeof registryEntrySchema>;
export interface LabRegistry {
  readonly labs: readonly LabEntry[];
  get(id: string): LabEntry | undefined;
}

/** Validate a parsed registry; throws one readable line per problem. */
export function parseRegistry(raw: unknown): LabRegistry {
  const r = registrySchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`lab registry: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const labs = Object.freeze(r.data.labs.map((lab) => Object.freeze(lab)));
  const byId = new Map(labs.map((lab) => [lab.id, lab]));
  return Object.freeze({ labs, get: (id: string) => byId.get(id) });
}

/** Read and validate a registry file (the portal and the warden, at start-up). */
export function loadRegistry(path: string): LabRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`lab registry ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseRegistry(raw);
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Points a solve of `lab` at `level` is worth (Divine: 0). */
export function labPoints(lab: Pick<LabEntry, 'difficulty'>, level: Level): number {
  return pointsForLevel(DIFFICULTY_POINTS[lab.difficulty], level);
}
