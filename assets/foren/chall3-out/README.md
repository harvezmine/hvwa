# Chapter III evidence: "Exhibit 7"

- `exhibit7.png`: the evidence handed to players. Built from `../chall3.png` (the decoy drawing).
- `solve.mjs`: reference solve. Run `node solve.mjs exhibit7.png fixed.png`.

## How it is built

Scratchpad script: `build.mjs`.

1. The decoy drawing (1535x1024) has a 300-row strip appended below it. The strip holds the forger's handwritten note and a crimson right handprint.
2. IHDR is rewritten to claim height 1024, and its CRC is recomputed. Viewers show only the drawing.
3. The forger copies The Fool's habit of leaving a message, but shallowly:
   - `tEXt Comment` reads "The show goes on. Another debt paid in fire. - The Fool". The real Fool never signs, never explains, and always writes a riddle with base64.
4. `tEXt Description` reads "Crimson Guard archive. Exhibit 7 ... Cropped for the record." This is the hint.
5. The C2PA `caBX` chunk from the source image is dropped.

## Solve

1. exiftool or pngcheck shows that the file is "cropped" and that IDAT holds more data than 1024 rows.
2. Compute rows = inflated IDAT / (1 + 1535 * 3) = 1324.
3. Patch the IHDR height and fix the CRC.
4. Read the note: "H. talked, before the end. The ledgers and the diary - hidden at the old circus. Get there before the guild does. Burn whatever he wrote."

Answer: **the old circus** (accept `oldcircus`, `circus`, `thecircus`, `theoldcircus`).
