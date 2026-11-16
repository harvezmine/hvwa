// ACOLYTE — no defense: the query is concatenated into the results HTML exactly as typed, in the results line and in
// the refine field. Whatever markup you search for becomes part of the librarian's page.
export function results(q: string): string {
  return `<p>No scrolls match <b>${q}</b>.</p>`
    + `<form class="refine"><label>Refine <input name="q" value="${q}"></label> <button>Search again</button></form>`;
}
