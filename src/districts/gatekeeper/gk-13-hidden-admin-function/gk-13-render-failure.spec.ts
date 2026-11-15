// A render failure on the denial path must reach the error handler (500), never hang the request or crash the process.
import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { freshSession } from '../../../../tests/helpers.js';
import { LEVELS } from '../../../core/levels.js';
import { GK13 } from './challenge.js'; // registers GK-13 before createApp() inside freshSession

const fail = vi.hoisted(() => ({ on: false }));
vi.mock('../../../core/render.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../core/render.js')>();
  return {
    ...real,
    sendPage: (res: Parameters<typeof real.sendPage>[0], view: string, data?: Record<string, unknown>) =>
      fail.on && view.endsWith('admin.ejs') ? Promise.reject(new Error('forced render failure')) : real.sendPage(res, view, data),
  };
});

const LAB = '/d/gatekeeper/hidden-admin-function';
const rejections: unknown[] = [];
const onRejection = (e: unknown) => { rejections.push(e); };
process.on('unhandledRejection', onRejection);
afterEach(() => { fail.on = false; });
afterAll(() => { process.off('unhandledRejection', onRejection); });

describe('GK-13 denial path failures', () => {
  it('a failing render of the denial is a 500 from the error handler at every guarded level, and no unhandled rejection', async () => {
    expect(GK13.id).toBe('GK-13');
    const { agent } = await freshSession();
    fail.on = true;
    for (const level of LEVELS.filter((l) => l !== 'acolyte')) {
      const path = level === 'templar' ? '/admin/export' : level === 'inquisitor' ? '/ADMIN/export' : '/anything';
      const res = await agent.get(`${LAB}${path}?level=${level}`).timeout(3000);
      expect(res.status, level).toBe(500);
      expect(res.text, level).not.toContain('forced render failure'); // stack-free handler
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(rejections).toEqual([]);
  });
});
