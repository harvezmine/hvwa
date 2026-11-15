// Minimal ambient declaration for ejs (no official types / @types/ejs pinned).
// `options` is deliberately REQUIRED: with only (file, data), ejs pulls options
// out of the data object, which allows option injection from request data.
declare module 'ejs' {
  export interface Options {
    cache?: boolean;
    filename?: string;
    root?: string | string[];
    async?: boolean;
    strict?: boolean;
    rmWhitespace?: boolean;
    [key: string]: unknown;
  }
  export function render(template: string, data: Record<string, unknown>, options: Options): string;
  export function renderFile(
    path: string,
    data: Record<string, unknown>,
    options: Options,
  ): Promise<string>;
}
