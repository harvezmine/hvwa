// ACOLYTE — no defense: the bio is written into the profile card exactly as saved. Any markup in it becomes part of
// the profile page of whoever opens it, the moderator included.
export function renderBio(bio: string): string {
  return `<div class="bio">${bio}</div>`;
}
