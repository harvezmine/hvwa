import type { DatabaseSync } from 'node:sqlite';
export function seed(db: DatabaseSync): void {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO users (username,password,role,email,secret_note) VALUES (?,?,?,?,?)');
  ins.run('templar_admin', 'ChangeMe!2026', 'admin', 'admin@citadel.test', 'flag-source');
  ins.run('pilgrim', 'password123', 'user', 'pilgrim@citadel.test', null);
}
