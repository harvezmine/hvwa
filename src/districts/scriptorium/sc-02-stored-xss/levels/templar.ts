// TEMPLAR — naive filter: a denylist. Every "<script" and every "onerror" is deleted from the review before it is
// written into the page (each in one pass, case-sensitive). The two spellings the author thought of are gone; any other
// element, any other event attribute, and any other spelling of these two still reach the page as markup.
export function renderReview(body: string): string {
  return body.replaceAll('<script', '').replaceAll('onerror', '');
}
