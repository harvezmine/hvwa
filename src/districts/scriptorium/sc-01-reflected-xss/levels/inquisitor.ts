// INQUISITOR — real defense, subtly flawed: & < > are escaped, so no tag can be opened anywhere. But the refine field
// writes the value WITHOUT quotes (value=...). An unquoted attribute value ends at the first space, and whatever
// follows is read as more attributes of the same <input>: no angle bracket is needed to add an event handler.
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function results(q: string): string {
  const shown = escapeText(q);
  return `<p>No scrolls match <b>${shown}</b>.</p>`
    + `<form class="refine"><label>Refine <input name=q value=${shown}></label> <button>Search again</button></form>`;
}
