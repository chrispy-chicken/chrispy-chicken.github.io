// Everything that changes lives here: per-line results and a couple of settings.
// Results are stored per chapter, per line:  stats[chapterId][lineId] = [attempts, correct, lastOk]
import { BACKUP_PREFIX, WEAK_THRESHOLD, WEAK_IF_LAST_MISSED } from './config.js';

const STATS_KEY = 'reptrain.stats.v1';
const SETTINGS_KEY = 'reptrain.settings.v1';

const DEFAULT_SETTINGS = { autoAdvance: true, sound: true };

let stats = read(STATS_KEY, {});
let settings = { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not save', key, err);
  }
}

// Ask the browser not to evict our data under storage pressure.
try { navigator.storage?.persist?.(); } catch { /* not supported */ }

/* ---------- results ---------- */

export function lineStat(chapterId, lineId) {
  const s = stats[chapterId]?.[lineId];
  return s ? { attempts: s[0], correct: s[1], lastOk: s[2] === 1 } : null;
}

export function recordResult(chapterId, lineId, ok) {
  const chapter = (stats[chapterId] ||= {});
  const s = chapter[lineId] || [0, 0, 0];
  chapter[lineId] = [s[0] + 1, s[1] + (ok ? 1 : 0), ok ? 1 : 0];
  write(STATS_KEY, stats);
}

/** Correct lines / attempted lines, over the lines currently in the chapter. */
export function aggregate(chapterId, lineIds) {
  let attempts = 0;
  let correct = 0;
  const chapter = stats[chapterId];
  if (chapter) {
    for (const id of lineIds) {
      const s = chapter[id];
      if (s) { attempts += s[0]; correct += s[1]; }
    }
  }
  return { attempts, correct, ratio: attempts ? correct / attempts : null };
}

export function isWeak(stat) {
  if (!stat || !stat.attempts) return false;
  if (stat.correct / stat.attempts < WEAK_THRESHOLD) return true;
  return WEAK_IF_LAST_MISSED && !stat.lastOk;
}

export function resetStats() {
  stats = {};
  write(STATS_KEY, stats);
}

/* ---------- backup ---------- */

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function countRecords(source = stats) {
  let n = 0;
  for (const chapter of Object.values(source)) n += Object.keys(chapter).length;
  return n;
}

export function exportBackup() {
  return BACKUP_PREFIX + toBase64(JSON.stringify({ v: 1, t: Date.now(), s: stats }));
}

/**
 * Merge a backup into the current results. For every line, whichever copy has
 * more attempts wins, so restoring an old backup never throws away newer work.
 * Returns the number of lines restored.
 */
export function importBackup(input) {
  const clean = String(input || '').replace(/\s+/g, '');
  if (!clean) throw new Error('Paste a backup first.');
  if (!clean.startsWith(BACKUP_PREFIX)) {
    throw new Error(`That doesn’t look like a backup. It should start with ${BACKUP_PREFIX}`);
  }
  let data;
  try {
    data = JSON.parse(fromBase64(clean.slice(BACKUP_PREFIX.length)));
  } catch {
    throw new Error('The backup is incomplete or damaged. Copy the whole text and try again.');
  }
  if (!data || data.v !== 1 || typeof data.s !== 'object' || data.s === null) {
    throw new Error('This backup was made by a different version of the app.');
  }

  let restored = 0;
  for (const [chapterId, lines] of Object.entries(data.s)) {
    if (typeof lines !== 'object' || lines === null) continue;
    for (const [lineId, rec] of Object.entries(lines)) {
      if (!Array.isArray(rec) || rec.length < 3 || !rec.every((x) => Number.isFinite(x) && x >= 0)) continue;
      const [a, c, l] = rec.map((x) => Math.floor(x));
      if (c > a) continue;
      const mine = stats[chapterId]?.[lineId];
      if (!mine || a > mine[0]) {
        (stats[chapterId] ||= {})[lineId] = [a, c, l ? 1 : 0];
        restored++;
      }
    }
  }
  write(STATS_KEY, stats);
  return restored;
}

/* ---------- settings ---------- */

export function getSetting(key) {
  return settings[key];
}

export function setSetting(key, value) {
  settings[key] = value;
  write(SETTINGS_KEY, settings);
}
