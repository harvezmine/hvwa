// src/quest/types.ts — the shape of a story quest (src/quest/<quest>/story.ts): a cast, and chapters made of scene
// steps that static/quest.js plays in order. Every line of text is bilingual; the server picks the player's language
// before a chapter leaves it (localize), so the browser only ever sees one language and only the chapters it has
// unlocked. A case chapter ends in a challenge: its evidence and its answer check stay on the server, and the scenes
// after it (`post`) are sent only once the answer is right.
import type { Lang } from '../core/i18n.js';

/** A line in both languages. */
export interface Text { readonly en: string; readonly id: string }

/** Where a portrait stands on the stage. */
export type Spot = 'left' | 'center' | 'right';

/**
 * One beat of a scene. The player advances through text beats (narr, say, you, letter); the rest run on their own.
 * Images are names under /static/quest/<art>/bg (bg, cg) and characters are cast ids.
 */
export type Step =
  | { readonly bg: string | null; readonly fx?: 'fade' | 'cut' | 'slow' }    // null: an empty, dark stage          // the backdrop (crossfades by default)
  | { readonly music: string | null; readonly fade?: number }              // a track under /static/quest/<art>/music, or silence
  | { readonly sfx: string }                                               // a synthesized effect (static/quest.js)
  | { readonly black: boolean }                                            // fade the whole stage to/from black
  | { readonly narr: Text }                                                // the narrator: a box in the middle of the screen
  | { readonly say: string; readonly text: Text; readonly pose?: string; readonly at?: Spot; readonly as?: Text;
      readonly style?: 'shout' | 'whisper'; readonly react?: 'shake' | 'jump';
      readonly off?: boolean }                                             // a cast line (off: heard, not shown)
  | { readonly you: Text }                                                 // the player's own line (their adventurer)
  | { readonly show: string; readonly pose?: string; readonly at: Spot }   // bring a portrait on stage
  | { readonly hide: string }                                              // a cast id, or 'all'
  | { readonly cg: string | null }                                         // a full-screen picture over the scene
  | { readonly item: { readonly glyph: string; readonly title: Text; readonly text: Text; readonly hand?: boolean } }
  // A tarot card drawn by the stage (no picture needed): its numeral, name and sign, upright or reversed, with a line
  // written on it (or about it) underneath.
  | { readonly tarot: { readonly n: string; readonly name: Text; readonly sign: string; readonly reversed?: boolean; readonly text?: Text } }
  | { readonly letter: Text }                                              // a parchment letter, read in full
  | { readonly title: Text; readonly sub?: Text }                          // a chapter title card
  | { readonly accept: { readonly title: Text; readonly reward: number } } // the Grand Quest contract, stamped
  | { readonly choice: readonly { readonly label: Text; readonly then: readonly Step[] }[] }
  // Places to search: with `at` ([x, y] as fractions of the backdrop) each is a glowing spot on the picture itself.
  | { readonly explore: { readonly prompt: Text; readonly spots: readonly { readonly label: Text; readonly at?: readonly [number, number]; readonly then: readonly Step[] }[] } }
  | { readonly place: Text; readonly time?: Text }                         // a location caption, top left, fades by itself
  | { readonly amb: string | null }                                        // a synthesized ambience loop (static/quest.js)
  | { readonly particles: string | null }                                  // dust, fireflies, embers or ash over the scene
  // A reveal: 'big' a white flash, sting and hard shake; 'small' a dark blink; 'dark' the screen closes in like a held
  // breath; 'blood' a red pulse, kept for violence.
  | { readonly shock: 'big' | 'small' | 'dark' | 'blood' }
  // A heartbeat that keeps going under the lines that follow ('slow' dread, 'fast' panic) until { heart: null }: a
  // lub-dub, and the whole picture throbs with it while the edges of the screen pulse dark red.
  | { readonly heart: 'slow' | 'fast' | null }
  | { readonly intro: { readonly who: string; readonly title: Text; readonly text: Text } } // a character card
  | { readonly notes: { readonly title: Text; readonly items: readonly Text[] } }           // the case so far
  | { readonly clue: Text }                                                // a 'new clue' slip, top right, by itself
  | { readonly cam: 'push' | 'reset' }                                     // a slow push-in on the scene, or back
  | { readonly tint: 'warm' | 'cold' | 'red' | 'memory' | null }          // a colour grade over the scene
  | { readonly letterbox: boolean }                                        // cinema bars
  // A memory: the whole stage is graded (golden: a fond memory, blue: a cold one, sepia: an old wound), with a soft
  // blurred edge, film grain, a faded paper dialogue box and slower typing, until `flashback: null`.
  | { readonly flashback: 'golden' | 'blue' | 'sepia' | null }
  | { readonly shake: true }
  | { readonly flash: 'white' | 'red' }
  | { readonly wait: number };                                             // ms

export interface CastMember {
  readonly name: Text;
  readonly role?: Text;
  /** Portrait per pose ('' is the default pose); none for a voice off stage. */
  readonly art?: Readonly<Record<string, string>>;
  /** Which way the portrait looks as drawn; the stage mirrors it so the two sides of a talk face each other. */
  readonly face?: 'left' | 'right' | 'front';
  /** The pitch of the voice blips while this character's line is typed (Hz). */
  readonly voice?: number;
}

export interface Challenge {
  readonly title: Text;
  readonly brief: Text;
  /** Files handed to the player, served by the quest router only once the chapter is unlocked. */
  readonly evidence: readonly { readonly file: string; readonly as: string; readonly label: Text }[];
  readonly placeholder: Text;
  /** Accepted answers, already normalised (see normalise in src/quest/index.ts). */
  readonly answers: readonly string[];
  /** A path outside the quest (for example a hidden "archive") that serves evidence once this chapter is unlocked. */
  readonly drop?: { readonly path: string; readonly files: readonly { readonly file: string; readonly as: string }[] };
}

export interface Chapter {
  readonly n: number;
  readonly title: Text;
  readonly sub: Text;
  /** The card art in the quest journal (a bg name). */
  readonly cover: string;
  readonly pre: readonly Step[];
  /** What happens before the case, in a few lines: shown when the player asks to skip ahead. */
  readonly recap: Text;
  /** The same for the scenes after the case (sent with them, never before the answer). */
  readonly recapPost?: Text;
  readonly challenge?: Challenge;
  readonly post?: readonly Step[];
}

export interface Quest {
  readonly id: string;
  /** The folder under /static/quest with bg/, sprite/ and music/. */
  readonly art: string;
  readonly title: Text;
  readonly tagline: Text;
  readonly reward: number;
  readonly cast: Readonly<Record<string, CastMember>>;
  readonly chapters: readonly Chapter[];
  /** Chapters planned but not written yet: shown as "coming soon" in the journal. */
  readonly upcoming: readonly { readonly title: Text; readonly sub: Text }[];
}

/** Pick one language out of every Text in a value (a Text is an object with exactly the keys en and id). */
export function localize<T>(value: T, lang: Lang): unknown {
  if (Array.isArray(value)) return value.map((v) => localize(v, lang));
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 2 && 'en' in value && 'id' in value) return (value as unknown as Text)[lang];
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localize(v, lang)]));
  }
  return value;
}
