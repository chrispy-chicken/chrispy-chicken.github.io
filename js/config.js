// Tuning knobs. Change these freely.

// Where your repertoire list lives (relative to index.html).
export const INDEX_URL = 'repertoires/index.json';

// A line counts as "weak" when its success rate is below this value,
// or when you got it wrong the last time you played it.
//   0.5 = you fail it at least as often as you get it right.
export const WEAK_THRESHOLD = 0.5;

// Also treat a line as weak if the most recent attempt was a miss.
export const WEAK_IF_LAST_MISSED = true;

// Delay before the opponent's reply, in milliseconds.
export const OPPONENT_DELAY = 380;

// Delay before moving on after a clean line (when auto-advance is on).
export const AUTO_ADVANCE_DELAY = 900;

// Prefix of the backup string. Bump the number if the format ever changes.
export const BACKUP_PREFIX = 'REPTRAIN1:';
