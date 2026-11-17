// TEMPLAR — naive filter: the first "<script>" and the first "</script>" are cut out of the query, once, as written
// (case-sensitive, not repeated). Then the query is concatenated as before. Only one spelling of one tag is filtered;
// every other element, and every event attribute of an ordinary element, passes through.
export function results(q: string): string {
  const filtered = q.replace('<script>', '').replace('</script>', '');
  return `<p>No scrolls match <b>${filtered}</b>.</p>`
    + `<form class="refine"><label>Refine <input name="q" value="${filtered}"></label> <button>Search again</button></form>`;
}
