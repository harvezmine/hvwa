// src/districts/_shared/result.ts — the message a lab page shows, for the labs of every district.
// A view renders it as `<p class="lab-message lab-success|lab-error">` (docs/RECIPES.md section 5).

/** The lab's message: ok selects the success/error style. */
export interface Result { readonly ok: boolean; readonly text: string }
