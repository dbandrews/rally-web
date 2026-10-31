/**
 * src/game/ghosts/names.ts — GHOSTS BUILDER. The SAVE GHOST name rules.
 *
 * The original asks for a name (locale 414 "GHOST NAME", 615 "Enter ghost name"), checks it (profileOrGhostInvalid: "This
 * ghost file name is invalid.", 614) and asks before overwriting an existing file (profileOrGhostExists, 882). The check
 * itself lives in an unnamed menu handler that was not traced; a ghost is saved as a FILE named after it, so the port uses
 * the Windows file-name rule [I]: after trimming, 1..MAX_GHOST_NAME characters, none of  \ / : * ? " < > |  or a control
 * character, no trailing dot, and not a reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9). Names compare case-
 * insensitively (NTFS), which is also how "already exists" is decided.
 */
export const MAX_GHOST_NAME = 32;

export type GhostNameCheck = { ok: true; name: string; key: string } | { ok: false; reason: 'empty' | 'invalid' | 'long' };

const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function checkGhostName(raw: string): GhostNameCheck {
  const trimmed = raw.trim();
  if (BAD_CHARS.test(trimmed)) return { ok: false, reason: 'invalid' }; // before the space collapse: a tab is a control character
  const name = trimmed.replace(/ {2,}/g, ' ');
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (name.length > MAX_GHOST_NAME) return { ok: false, reason: 'long' };
  if (/[. ]$/.test(name) || RESERVED.test(name)) return { ok: false, reason: 'invalid' };
  return { ok: true, name, key: name.toLowerCase() };
}

/** The original's wording (LocaleEnglish ids). */
export const GHOST_TEXT = {
  save: 'SAVE GHOST', // 413
  name: 'GHOST NAME', // 414
  enterName: 'Enter ghost name', // 615
  invalid: 'This ghost file name is invalid.', // 614
  exists: 'This ghost name already exists.\nDo you want to overwrite it?', // 882
  saving: 'Saving ghost file...', // 572
  noSpace: "Your computer doesn't have enough free space\nto save a ghost file.", // 612
  deleteConfirm: 'Do you really want to\ndelete the ghost file:', // 636
  corrupt: 'Unable to load ghost file.', // 749
  none: 'No ghost files are available for this track', // 1271
  deleteHint: 'Press the DELETE key to remove the highlighted ghost file', // 1270
} as const;
