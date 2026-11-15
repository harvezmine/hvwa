// src/core/challenge-db.ts — challenge-side data, kept apart from the platform DB.
import { DatabaseSync } from 'node:sqlite';

/**
 * A fresh, private in-memory database for one challenge's vulnerable data
 * (users, products, orders, ...). The platform DB (solves, hints, events) is
 * never reachable from challenge code, so an injection in a lab can only
 * touch that lab's own tables.
 *
 * Call it once at module level in the challenge's routes.ts and close over
 * the handle in handlers and in a custom check():
 *
 *   const db = challengeDb(SCHEMA, (d) => { d.exec(SEED_SQL); });
 */
export function challengeDb(schemaSql: string, seed?: (db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  seed?.(db);
  return db;
}
