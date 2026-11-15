// Minimal ambient declaration for ejs (no official types / @types/ejs pinned).
declare module 'ejs' {
  export interface Options {
    cache?: boolean;
    filename?: string;
    root?: string | string[];
    async?: boolean;
    [key: string]: unknown;
  }
  export function render(template: string, data?: Record<string, unknown>, options?: Options): string;
  export function renderFile(
    path: string,
    data?: Record<string, unknown>,
    options?: Options,
  ): Promise<string>;
}
