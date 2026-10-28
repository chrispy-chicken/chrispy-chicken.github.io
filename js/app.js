import { Chessground } from '../vendor/chessground.js';
import { Chess } from '../vendor/chess.js';
import { parsePgn, extractLines, lineId, positionKey, plyInfo } from './pgn.js';
import * as store from './store.js';
import { sound, unlockAudio } from './sound.js';
import {
  INDEX_URL, OPPONENT_DELAY, AUTO_ADVANCE_DELAY, WEAK_THRESHOLD, WEAK_IF_LAST_MISSED,
} from './config.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const CHECK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* =====================================================================
   Data: repertoires → chapters → lines
   ===================================================================== */

const data = {
  status: 'loading',            // 'loading' | 'ready' | 'error'
  error: '',
  repertoires: [],              // [{ key, name, color, chapters: [...] , error }]
  chapters: new Map(),          // chapterId → chapter
  alternatives: { white: new Map(), black: new Map() }, // positionKey → Set(san)
};

const ui = {
  selected: new Set(),          // chapter ids
  collapsed: new Set(),         // repertoire keys
};

function normColor(value) {
  const c = String(value || '').trim().toLowerCase();
  return c === 'white' || c === 'black' ? c : null;
}

function chapterNameFromEvent(event) {
  if (!event || event === '?') return null;
  const i = event.indexOf(': ');
  return i === -1 ? event : event.slice(i + 2);
}

async function fetchText(url, reload) {
  const res = await fetch(url, reload ? { cache: 'reload' } : undefined);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function makeChapter(rep, id, name, color, src) {
  return { id, name, color, src, rep, lines: [], errors: [], failed: false };
}

function buildChapter(chapter, games, alternatives) {
  if (!chapter.color) {
    chapter.color = games.map((g) => normColor(g.headers.Orientation)).find(Boolean) || 'white';
  }
  const userTurn = chapter.color === 'white' ? 'w' : 'b';
  const alt = alternatives[chapter.color];
  const seen = new Set();

  for (const game of games) {
    const { lines, positions, errors } = extractLines(game);
    chapter.errors.push(...errors);
    for (const [key, sans] of positions) {
      if (!alt.has(key)) alt.set(key, new Set());
      for (const san of sans) alt.get(key).add(san);
    }
    for (const line of lines) {
      const id = lineId(line);
      if (seen.has(id)) continue;
      seen.add(id);
      const firstTurn = line.startFen.split(' ')[1];
      const userPlies = [];
      line.moves.forEach((_, i) => {
        const mover = (i % 2 === 0) === (firstTurn === 'w') ? 'w' : 'b';
        if (mover === userTurn) userPlies.push(i);
      });
      if (!userPlies.length) continue;
      chapter.lines.push({
        id,
        chapter,
        number: chapter.lines.length + 1,
        startFen: line.startFen,
        moves: line.moves,
        userPlies,
      });
    }
  }
  if (!games.length) chapter.errors.push('No moves found in this file.');
}

async function loadAll({ reload = false } = {}) {
  data.status = 'loading';
  renderHome();

  const indexUrl = new URL(INDEX_URL, document.baseURI);
  let index;
  try {
    const text = await fetchText(indexUrl, reload);
    try {
      index = JSON.parse(text);
    } catch (err) {
      throw new Error(`${INDEX_URL} isn’t valid JSON. ${err.message}`);
    }
  } catch (err) {
    data.status = 'error';
    data.error = err.message.startsWith('HTTP') ? `Couldn’t load ${INDEX_URL} (${err.message}).` : err.message;
    renderHome();
    return;
  }

  const repertoires = [];
  const chapters = new Map();
  const alternatives = { white: new Map(), black: new Map() };
  const takenIds = new Set();
  const uniqueId = (base) => {
    let id = base;
    for (let n = 2; takenIds.has(id); n++) id = `${base}~${n}`;
    takenIds.add(id);
    return id;
  };

  const jobs = [];
  const list = Array.isArray(index?.repertoires) ? index.repertoires : [];

  list.forEach((r, ri) => {
    const rep = {
      key: `r${ri}`,
      name: r?.name || `Repertoire ${ri + 1}`,
      color: normColor(r?.color),
      chapters: [],
      error: '',
    };
    repertoires.push(rep);

    if (Array.isArray(r?.chapters)) {
      // One PGN file per chapter.
      for (const c of r.chapters) {
        if (!c?.pgn) continue;
        const name = c.name || c.pgn.replace(/^.*\//, '').replace(/\.pgn$/i, '');
        const chapter = makeChapter(rep, uniqueId(c.id || c.pgn), name, normColor(c.color) || rep.color, c.pgn);
        rep.chapters.push(chapter);
        jobs.push(
          fetchText(new URL(c.pgn, indexUrl), reload).then(
            (text) => buildChapter(chapter, parsePgn(text), alternatives),
            (err) => { chapter.failed = true; chapter.errors.push(`Couldn’t load ${c.pgn} (${err.message}).`); },
          ),
        );
      }
    } else if (r?.pgn) {
      // One PGN for the whole repertoire (e.g. a Lichess study export): every game is a chapter.
      jobs.push(
        fetchText(new URL(r.pgn, indexUrl), reload).then(
          (text) => {
            parsePgn(text).forEach((game, gi) => {
              const name = game.headers.ChapterName || chapterNameFromEvent(game.headers.Event) || `Chapter ${gi + 1}`;
              const chapter = makeChapter(rep, uniqueId(`${r.pgn}#${name}`), name, rep.color, r.pgn);
              rep.chapters.push(chapter);
              buildChapter(chapter, [game], alternatives);
            });
          },
          (err) => { rep.error = `Couldn’t load ${r.pgn} (${err.message}).`; },
        ),
      );
    }
  });

  await Promise.all(jobs);

  for (const rep of repertoires) for (const ch of rep.chapters) chapters.set(ch.id, ch);
  data.repertoires = repertoires;
  data.chapters = chapters;
  data.alternatives = alternatives;
  data.status = 'ready';
  for (const id of [...ui.selected]) if (!chapters.get(id)?.lines.length) ui.selected.delete(id);
  renderHome();
}

/* =====================================================================
   Scores
   ===================================================================== */

function chapterSummary(chapter) {
  const agg = store.aggregate(chapter.id, chapter.lines.map((l) => l.id));
  let weak = 0;
  for (const line of chapter.lines) if (store.isWeak(store.lineStat(chapter.id, line.id))) weak++;
  return { ...agg, weak, lines: chapter.lines.length };
}

function isLineWeak(line) {
  return store.isWeak(store.lineStat(line.chapter.id, line.id));
}

function tone(ratio) {
  if (ratio == null) return '';
  if (ratio >= 0.8) return 'good';
  if (ratio >= WEAK_THRESHOLD) return 'mid';
  return 'bad';
}

function meterHtml(ratio) {
  const filled = ratio == null ? 0 : Math.round(ratio * 8);
  let cells = '';
  for (let i = 0; i < 8; i++) cells += `<i class="${i < filled ? 'on' : ''}"></i>`;
  return `<span class="meter ${tone(ratio)}" aria-hidden="true">${cells}</span>`;
}

function pctHtml(ratio, attempts) {
  if (ratio == null) return '<span class="pct new">new</span>';
  const label = `${Math.round(ratio * 100)}% correct over ${plural(attempts, 'attempt')}`;
  return `<span class="pct" aria-label="${label}">${Math.round(ratio * 100)}%</span>`;
}

/* =====================================================================
   Home screen
   ===================================================================== */

function playableIds() {
  return [...data.chapters.values()].filter((c) => c.lines.length).map((c) => c.id);
}

function scopeIds() {
  return ui.selected.size ? [...ui.selected] : playableIds();
}

function renderHome() {
  const list = $('rep-list');
  const overall = $('overall');

  if (data.status === 'loading' && !data.repertoires.length) {
    overall.textContent = '';
    list.innerHTML = '<div class="empty"><p class="lead">Loading your repertoire…</p></div>';
    updateHomeBar();
    return;
  }
  if (data.status === 'error') {
    overall.textContent = '';
    list.innerHTML = `
      <div class="empty">
        <p class="lead">${esc(data.error)}</p>
        <p>The app looks for <code>${esc(INDEX_URL)}</code> next to <code>index.html</code>.</p>
        <button class="btn secondary" type="button" data-action="retry">Try again</button>
      </div>`;
    updateHomeBar();
    return;
  }
  if (!data.repertoires.length) {
    overall.textContent = '';
    list.innerHTML = `
      <div class="empty">
        <p class="lead">No repertoires yet</p>
        <p>Add one to <code>${esc(INDEX_URL)}</code>. The README shows the format.</p>
      </div>`;
    updateHomeBar();
    return;
  }

  let totalAttempts = 0;
  let totalCorrect = 0;
  let totalLines = 0;
  const problems = [];

  const html = data.repertoires.map((rep) => {
    const rows = rep.chapters.map((ch) => {
      const s = chapterSummary(ch);
      totalAttempts += s.attempts;
      totalCorrect += s.correct;
      totalLines += s.lines;
      if (ch.errors.length) problems.push(ch);

      const playable = s.lines > 0;
      const selected = ui.selected.has(ch.id);
      let meta;
      if (ch.failed) meta = '<span class="warn">Couldn’t load the file</span>';
      else if (!playable) meta = '<span class="warn">No lines to practice</span>';
      else {
        meta = plural(s.lines, 'line');
        if (s.weak) meta += `, <span class="review">${s.weak} to review</span>`;
        if (ch.errors.length) meta += `, <span class="warn">${plural(ch.errors.length, 'problem')} in the PGN</span>`;
      }
      return { ch, s, html: `
        <li class="chapter${selected ? ' selected' : ''}">
          <button class="check${selected ? ' on' : ''}" type="button" role="checkbox"
            aria-checked="${selected}" aria-label="Select ${esc(ch.name)}"
            data-action="select" data-id="${esc(ch.id)}" ${playable ? '' : 'disabled'}>
            <span class="box">${CHECK_SVG}</span>
          </button>
          <button class="chapter-main" type="button" data-action="practice" data-id="${esc(ch.id)}" ${playable ? '' : 'disabled'}>
            <span class="ch-text">
              <span class="ch-name">${esc(ch.name)}</span>
              <span class="ch-meta">${meta}</span>
            </span>
            <span class="score">${meterHtml(s.ratio)}${pctHtml(s.ratio, s.attempts)}</span>
          </button>
        </li>` };
    });

    const attempts = rows.reduce((a, r) => a + r.s.attempts, 0);
    const correct = rows.reduce((a, r) => a + r.s.correct, 0);
    const ratio = attempts ? correct / attempts : null;
    const ids = rows.filter((r) => r.s.lines).map((r) => r.ch.id);
    const all = ids.length > 0 && ids.every((id) => ui.selected.has(id));
    const some = !all && ids.some((id) => ui.selected.has(id));
    const collapsed = ui.collapsed.has(rep.key);
    const colors = new Set(rep.chapters.map((c) => c.color));
    const side = colors.size === 1 ? [...colors][0] : rep.color;
    const sideHtml = side
      ? `<span class="side side-${side}"></span>You play ${side === 'white' ? 'White' : 'Black'}`
      : '';
    const metaHtml = rep.error ? `<span class="warn">${esc(rep.error)}</span>` : sideHtml;

    return `
      <section class="rep${collapsed ? ' collapsed' : ''}">
        <div class="rep-head">
          <button class="check${all ? ' on' : some ? ' some' : ''}" type="button" role="checkbox"
            aria-checked="${all ? 'true' : some ? 'mixed' : 'false'}"
            aria-label="Select every chapter in ${esc(rep.name)}"
            data-action="select-rep" data-rep="${rep.key}" ${ids.length ? '' : 'disabled'}>
            <span class="box">${CHECK_SVG}</span>
          </button>
          <button class="rep-toggle" type="button" aria-expanded="${!collapsed}" data-action="toggle-rep" data-rep="${rep.key}">
            <span class="rep-name">${esc(rep.name)} ${CHEVRON_SVG}</span>
            <span class="rep-meta">${metaHtml}</span>
          </button>
          <span class="score">${meterHtml(ratio)}${pctHtml(ratio, attempts)}</span>
        </div>
        <ul class="chapters">${rows.map((r) => r.html).join('')}</ul>
      </section>`;
  }).join('');

  let extra = '';
  if (problems.length) {
    extra += `
      <details class="problems">
        <summary>Some PGN moves couldn’t be read</summary>
        ${problems.map((ch) => `
          <h4>${esc(ch.rep.name)}, ${esc(ch.name)}</h4>
          <ul>${ch.errors.slice(0, 12).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`).join('')}
      </details>`;
  }
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS && !navigator.standalone) {
    extra += '<p class="install-hint">For a full-screen app: tap the Share button in Safari, then Add to Home Screen.</p>';
  }

  list.innerHTML = html + extra;

  overall.textContent = totalAttempts
    ? `${Math.round((totalCorrect / totalAttempts) * 100)}% correct over ${plural(totalAttempts, 'attempt')}`
    : `${plural(totalLines, 'line')} ready to practice`;

  updateHomeBar();
}

function weakCount(ids) {
  let n = 0;
  for (const id of ids) {
    const ch = data.chapters.get(id);
    if (ch) for (const line of ch.lines) if (isLineWeak(line)) n++;
  }
  return n;
}

function updateHomeBar() {
  const ready = data.status === 'ready';
  const n = ui.selected.size;
  const ids = ready ? scopeIds() : [];
  const lines = ids.reduce((a, id) => a + (data.chapters.get(id)?.lines.length || 0), 0);
  const weak = ready ? weakCount(ids) : 0;

  $('selection-row').hidden = !n;
  $('selection-note').textContent = `${plural(n, 'chapter')} selected`;

  const practice = $('btn-practice');
  practice.textContent = n ? 'Practice selected' : 'Practice all';
  practice.disabled = !lines;

  const weakBtn = $('btn-weak');
  weakBtn.textContent = weak ? `Weak lines (${weak})` : 'No weak lines';
  weakBtn.disabled = !weak;
}

$('rep-list').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id, rep: repKey } = el.dataset;

  if (action === 'retry') {
    loadAll({ reload: true });
  } else if (action === 'practice') {
    startSession([id], false);
  } else if (action === 'select') {
    if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
    renderHome();
  } else if (action === 'select-rep') {
    const rep = data.repertoires.find((r) => r.key === repKey);
    const ids = rep.chapters.filter((c) => c.lines.length).map((c) => c.id);
    const all = ids.every((x) => ui.selected.has(x));
    for (const x of ids) if (all) ui.selected.delete(x); else ui.selected.add(x);
    renderHome();
  } else if (action === 'toggle-rep') {
    if (ui.collapsed.has(repKey)) ui.collapsed.delete(repKey); else ui.collapsed.add(repKey);
    renderHome();
  }
});

$('btn-practice').addEventListener('click', () => startSession(scopeIds(), false));
$('btn-weak').addEventListener('click', () => startSession(scopeIds(), true));
$('clear-selection').addEventListener('click', () => { ui.selected.clear(); renderHome(); });

/* =====================================================================
   Practice
   ===================================================================== */

let cg = null;          // Chessground instance
let session = null;     // { ids, weakOnly, title, multi, deck, played, clean, last }
let drill = null;       // current line being practiced
let timer = 0;
let flashTimer = 0;

function clearTimer() {
  clearTimeout(timer);
  timer = 0;
}

function ensureBoard() {
  if (cg) { cg.redrawAll(); return; }
  cg = Chessground($('board'), {
    coordinates: true,
    animation: { enabled: !reducedMotion, duration: 200 },
    highlight: { lastMove: true, check: true },
    movable: { free: false, color: undefined, showDests: true, events: { after: onUserMove } },
    premovable: { enabled: false },
    draggable: { enabled: true, showGhost: true },
    drawable: {
      enabled: false,
      visible: true,
      brushes: { hint: { key: 'hint', color: '#2C8A62', opacity: 0.9, lineWidth: 12 } },
    },
    blockTouchScroll: true,
  });
}

function showView(name) {
  $('home').hidden = name !== 'home';
  $('practice').hidden = name !== 'practice';
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startSession(ids, weakOnly) {
  const chapters = ids.map((id) => data.chapters.get(id)).filter((c) => c && c.lines.length);
  if (!chapters.length) return;
  let title;
  if (weakOnly) title = 'Weak lines';
  else if (chapters.length === 1) title = chapters[0].name;
  else title = `${chapters.length} chapters`;

  session = {
    ids: chapters.map((c) => c.id),
    weakOnly,
    title,
    multi: weakOnly || chapters.length > 1,
    deck: [],
    played: 0,
    clean: 0,
    last: null,
  };
  showView('practice');
  if (history.state?.view !== 'practice') history.pushState({ view: 'practice' }, '');
  ensureBoard();
  nextLine();
}

function buildDeck() {
  const pool = [];
  for (const id of session.ids) {
    for (const line of data.chapters.get(id).lines) {
      if (!session.weakOnly || isLineWeak(line)) pool.push(line);
    }
  }
  shuffle(pool);
  // Don't serve the same line twice in a row across rounds.
  const n = pool.length;
  if (n > 1 && pool[n - 1] === session.last) [pool[0], pool[n - 1]] = [pool[n - 1], pool[0]];
  session.deck = pool;
}

function nextLine() {
  clearTimer();
  if (!session.deck.length) buildDeck();
  const line = session.deck.pop();
  if (!line) { showSessionEmpty(); return; }
  startLine(line);
}

function startLine(line) {
  clearTimer();
  drill = {
    line,
    chess: new Chess(line.startFen),
    ply: 0,
    missed: false,       // any mistake on this line
    wrongHere: 0,        // wrong tries on the current move
    revealed: false,     // answer shown for the current move
    marks: [],           // per user move: 'ok' | 'miss'
    lastMove: undefined,
    done: false,
  };
  session.last = line;
  cg.set({ orientation: line.chapter.color, lastMove: undefined });
  cg.setAutoShapes([]);
  syncBoard();
  setStatus('Your move');
  renderPractice();
  advance(true);
}

function isUserTurn(d) {
  return d.chess.turn() === (d.line.chapter.color === 'white' ? 'w' : 'b');
}

/** Play the opponent's reply if it's their turn, finish if the line is over. */
function advance(first = false) {
  const d = drill;
  if (d.ply >= d.line.moves.length) { finishLine(); return; }
  if (isUserTurn(d)) { syncBoard(); renderControls(); return; }
  syncBoard();
  renderControls();
  timer = setTimeout(() => {
    if (drill !== d) return;
    const m = d.line.moves[d.ply];
    const mv = d.chess.move(m.san);
    d.ply++;
    d.lastMove = [mv.from, mv.to];
    (mv.captured ? sound.capture : sound.move)();
    syncBoard();
    renderMoves();
    renderComment();
    advance();
  }, first ? OPPONENT_DELAY + 250 : OPPONENT_DELAY);
}

function toDests(chess) {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    const list = dests.get(m.from);
    if (!list.includes(m.to)) list.push(m.to);
  }
  return dests;
}

function syncBoard() {
  const d = drill;
  const turn = d.chess.turn() === 'w' ? 'white' : 'black';
  const canMove = !d.done && isUserTurn(d) && d.ply < d.line.moves.length;
  cg.set({
    fen: d.chess.fen(),
    turnColor: turn,
    lastMove: d.lastMove,
    check: d.chess.inCheck() ? turn : false,
    movable: { color: canMove ? turn : undefined, dests: canMove ? toDests(d.chess) : new Map() },
  });
}

function flashSquare(square, cls) {
  clearTimeout(flashTimer);
  cg.set({ highlight: { custom: new Map([[square, cls]]) } });
  flashTimer = setTimeout(() => cg && cg.set({ highlight: { custom: new Map() } }), 650);
}

function onUserMove(orig, dest) {
  const d = drill;
  if (!d || d.done) return;
  const expected = d.line.moves[d.ply];
  const candidates = d.chess.moves({ verbose: true }).filter((m) => m.from === orig && m.to === dest);
  if (!candidates.length) { syncBoard(); return; }

  // Promotions: take the piece the line wants, otherwise a queen.
  const played =
    candidates.find((m) => (m.promotion || null) === expected.promotion && m.from === expected.from && m.to === expected.to) ||
    candidates.find((m) => !m.promotion || m.promotion === 'q') ||
    candidates[0];

  const correct = played.from === expected.from && played.to === expected.to &&
    (played.promotion || null) === expected.promotion;

  if (correct) {
    const mv = d.chess.move(played.san);
    d.marks.push(d.wrongHere || d.revealed ? 'miss' : 'ok');
    d.ply++;
    d.wrongHere = 0;
    d.revealed = false;
    d.lastMove = [mv.from, mv.to];
    cg.setAutoShapes([]);
    (mv.captured ? sound.capture : sound.move)();
    setStatus('Your move');
    syncBoard();
    renderMoves();
    renderComment();
    renderProgress();
    advance();
    return;
  }

  // Not this line's move. Is it at least part of the repertoire?
  const alt = data.alternatives[d.line.chapter.color].get(positionKey(d.chess.fen()));
  if (alt && alt.has(played.san)) {
    flashSquare(dest, 'alt');
    syncBoard();
    setStatus(`${fig(played.san)} is in your repertoire, but this line continues differently.`, 'alt');
    return;
  }

  d.missed = true;
  d.wrongHere++;
  sound.wrong();
  flashSquare(dest, 'wrong');
  syncBoard();
  if (d.wrongHere >= 2) reveal();
  else setStatus('Not this move. Try again.', 'bad', true);
  renderProgress();
}

function reveal() {
  const d = drill;
  if (!d || d.done || !isUserTurn(d)) return;
  const m = d.line.moves[d.ply];
  d.revealed = true;
  d.missed = true;
  cg.setAutoShapes([{ orig: m.from, dest: m.to, brush: 'hint' }]);
  setStatus(`The move is ${fig(m.san)}. Play it to continue.`, 'bad');
  renderProgress();
  renderControls();
}

function finishLine() {
  const d = drill;
  d.done = true;
  const ok = !d.missed;
  store.recordResult(d.line.chapter.id, d.line.id, ok);
  session.played++;
  if (ok) session.clean++;
  syncBoard();
  if (ok) sound.done();
  setStatus(ok ? 'Line complete' : 'Line complete, saved for review', ok ? 'good' : 'bad');
  renderPractice();
  if (ok && store.getSetting('autoAdvance')) {
    timer = setTimeout(() => { if (drill === d) nextLine(); }, AUTO_ADVANCE_DELAY);
  }
}

/** Leaving a line half-way counts as a miss only if a mistake was already made. */
function abandonLine() {
  const d = drill;
  clearTimer();
  if (d && !d.done && d.missed) {
    store.recordResult(d.line.chapter.id, d.line.id, false);
    session.played++;
  }
}

function showSessionEmpty() {
  drill = null;
  cg.set({
    fen: 'start',
    lastMove: undefined,
    check: false,
    movable: { color: undefined, dests: new Map() },
  });
  cg.setAutoShapes([]);
  if (session.weakOnly) {
    setStatus(session.played ? 'No weak lines left' : 'No weak lines here', 'good');
    $('p-comment').textContent = 'Lines show up here again when you miss them.';
  } else {
    setStatus('Nothing to practice');
    $('p-comment').textContent = 'These chapters have no lines yet.';
  }
  $('p-moves').innerHTML = '';
  $('p-progress').innerHTML = '';
  renderHeader();
  renderControls();
}

function leaveSession() {
  abandonLine();
  drill = null;
  session = null;
  showView('home');
  renderHome();
}

/* ---------- Practice rendering ---------- */

const FIGURINES = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
function fig(san) {
  return esc(san).replace(/[KQRBN]/g, (p) => `<span class="fig">${FIGURINES[p]}\uFE0E</span>`);
}

function setStatus(html, kind = '', shake = false) {
  const el = $('p-status');
  el.innerHTML = html;
  el.className = `status${kind ? ` ${kind}` : ''}`;
  if (shake && !reducedMotion) {
    void el.offsetWidth; // restart the animation
    el.classList.add('shake');
  }
}

function renderHeader() {
  $('p-title').textContent = session.title;
  const d = drill;
  let sub = '';
  if (d) {
    const ch = d.line.chapter;
    const where = `line ${d.line.number} of ${ch.lines.length}`;
    sub = session.multi ? `${ch.name}, ${where}` : where[0].toUpperCase() + where.slice(1);
  }
  $('p-sub').textContent = sub;
  const tally = $('p-tally');
  const missed = session.played - session.clean;
  tally.innerHTML = session.played
    ? `<span class="t-good">${session.clean}</span><span class="t-bad">${missed}</span>`
    : '';
  tally.setAttribute('aria-label', session.played
    ? `${plural(session.clean, 'clean line')}, ${plural(missed, 'missed line')}`
    : '');
}

function renderMoves() {
  const d = drill;
  const el = $('p-moves');
  if (!d) { el.innerHTML = ''; return; }
  const parts = [];
  let userIdx = 0;
  for (let i = 0; i < d.ply; i++) {
    const m = d.line.moves[i];
    const { number, white } = plyInfo(d.line.startFen, i);
    const isUser = d.line.userPlies.includes(i);
    const miss = isUser && d.marks[userIdx] === 'miss';
    if (isUser) userIdx++;
    const no = white ? `${number}.` : i === 0 ? `${number}…` : '';
    const cls = `mv${i === d.ply - 1 ? ' last' : ''}${miss ? ' miss' : ''}`;
    parts.push(`${no ? `<span class="no">${no}</span>` : ''}<span class="${cls}">${fig(m.san)}</span>`);
  }
  el.innerHTML = parts.join(' ');
  const panel = el.closest('.panel');
  panel.scrollTop = panel.scrollHeight;
}

function renderComment() {
  const d = drill;
  if (!d) return;
  const notes = [];
  for (let i = Math.max(0, d.ply - 2); i < d.ply; i++) {
    const c = d.line.moves[i].comment;
    if (c && !notes.includes(c)) notes.push(c);
  }
  $('p-comment').textContent = notes.join(' ');
}

function renderProgress() {
  const d = drill;
  const el = $('p-progress');
  if (!d) { el.innerHTML = ''; return; }
  const total = d.line.userPlies.length;
  let html = '';
  for (let i = 0; i < total; i++) {
    let cls = '';
    if (i < d.marks.length) cls = d.marks[i];
    else if (i === d.marks.length && !d.done) cls = `cur${d.wrongHere || d.revealed ? ' miss' : ''}`;
    html += `<i class="${cls}"></i>`;
  }
  el.innerHTML = html;
}

function renderControls() {
  const left = $('btn-left');
  const right = $('btn-right');
  const d = drill;

  if (!d) {
    left.hidden = true;
    right.hidden = false;
    right.textContent = 'Back to chapters';
    right.className = 'btn primary';
    right.dataset.action = 'back';
    return;
  }
  if (d.done) {
    left.hidden = !d.missed;
    left.textContent = 'Try again';
    left.dataset.action = 'retry';
    left.disabled = false;
    right.hidden = false;
    right.textContent = 'Next line';
    right.className = 'btn primary';
    right.dataset.action = 'next';
    return;
  }
  left.hidden = false;
  left.textContent = 'Show move';
  left.dataset.action = 'reveal';
  left.disabled = d.revealed || !isUserTurn(d);
  right.hidden = false;
  right.textContent = 'Skip line';
  right.className = 'btn secondary';
  right.dataset.action = 'skip';
}

function renderPractice() {
  renderHeader();
  renderMoves();
  renderComment();
  renderProgress();
  renderControls();
}

function onControl(e) {
  const action = e.currentTarget.dataset.action;
  if (!session) return;
  if (action === 'reveal') reveal();
  else if (action === 'skip') { abandonLine(); nextLine(); }
  else if (action === 'next') nextLine();
  else if (action === 'retry') startLine(drill.line);
  else if (action === 'back') goBack();
}
$('btn-left').addEventListener('click', onControl);
$('btn-right').addEventListener('click', onControl);

function goBack() {
  if (history.state?.view === 'practice') history.back();
  else leaveSession();
}
$('btn-back').addEventListener('click', goBack);
window.addEventListener('popstate', () => { if (session) leaveSession(); });

/* =====================================================================
   Settings
   ===================================================================== */

const sheet = $('settings');

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2000);
}

$('open-settings').addEventListener('click', () => {
  $('set-auto').checked = !!store.getSetting('autoAdvance');
  $('set-sound').checked = !!store.getSetting('sound');
  $('backup-out').value = store.exportBackup();
  $('backup-in').value = '';
  $('restore-msg').textContent = '';
  $('restore-msg').className = 'hint';
  $('weak-explainer').textContent =
    `A line counts as weak when you play it cleanly less than ${Math.round(WEAK_THRESHOLD * 100)}% of the time` +
    `${WEAK_IF_LAST_MISSED ? ', or when you missed it the last time' : ''}. ` +
    'A chapter’s score is clean lines divided by attempts. You can change the threshold in js/config.js.';
  sheet.showModal();
});

$('close-settings').addEventListener('click', () => sheet.close());
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

$('set-auto').addEventListener('change', (e) => store.setSetting('autoAdvance', e.target.checked));
$('set-sound').addEventListener('change', (e) => store.setSetting('sound', e.target.checked));

$('copy-backup').addEventListener('click', async () => {
  const out = $('backup-out');
  out.value = store.exportBackup();
  try {
    await navigator.clipboard.writeText(out.value);
    toast('Backup copied');
  } catch {
    out.focus();
    out.select();
    const ok = document.execCommand && document.execCommand('copy');
    toast(ok ? 'Backup copied' : 'Select the text and copy it');
  }
});

$('restore-backup').addEventListener('click', () => {
  const msg = $('restore-msg');
  try {
    const n = store.importBackup($('backup-in').value);
    msg.textContent = n
      ? `Restored ${plural(n, 'line')}.`
      : 'Nothing to restore. This device already has the same or newer progress.';
    msg.className = 'hint ok';
    $('backup-in').value = '';
    $('backup-out').value = store.exportBackup();
    renderHome();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'hint err';
  }
});

$('reload-files').addEventListener('click', async () => {
  sheet.close();
  await loadAll({ reload: true });
  if (data.status === 'ready') toast('Files reloaded');
});

$('reset-progress').addEventListener('click', () => {
  if (!confirm('Erase all progress on this device? Copy a backup first if you might want it back.')) return;
  store.resetStats();
  $('backup-out').value = store.exportBackup();
  renderHome();
  toast('Progress erased');
});

/* =====================================================================
   App-like behaviour and start-up
   ===================================================================== */

// Stop pinch and double-tap zoom from fighting with the board.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

unlockAudio();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
}

loadAll();
