// PGN parsing with full variation support, and expansion of the move tree
// into practice lines (one line = one path from the start to a leaf).
import { Chess } from '../vendor/chess.js';

const RESULT = /^(1-0|0-1|1\/2-1\/2|\*)$/;
const TAG = /\[\s*([A-Za-z0-9_]+)\s*"((?:[^"\\]|\\.)*)"\s*\]/y;

/** Parse a PGN file (possibly holding several games) into move trees. */
export function parsePgn(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const games = [];
  let game = null;
  let cur = null;
  let stack = [];

  const newGame = () => {
    game = { headers: {}, root: { san: null, comment: '', children: [], parent: null }, hasMoves: false, ended: false };
    games.push(game);
    cur = game.root;
    stack = [];
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];

    if (ch === ' ' || ch === '\n' || ch === '\t') { i++; continue; }

    // "%" escape lines are ignored entirely.
    if (ch === '%' && (i === 0 || text[i - 1] === '\n')) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }

    if (ch === '[') {
      if (!game || game.hasMoves || game.ended) newGame();
      TAG.lastIndex = i;
      const m = TAG.exec(text);
      if (m) {
        game.headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
        i = TAG.lastIndex;
      } else {
        const end = text.indexOf(']', i);
        i = end === -1 ? n : end + 1;
      }
      continue;
    }

    if (ch === '{') {
      const end = text.indexOf('}', i);
      const body = text.slice(i + 1, end === -1 ? n : end);
      if (!game || game.ended) newGame();
      cur.comment = cur.comment ? `${cur.comment} ${body}` : body;
      i = end === -1 ? n : end + 1;
      continue;
    }

    if (ch === ';') {
      const end = text.indexOf('\n', i);
      const body = text.slice(i + 1, end === -1 ? n : end);
      if (game && !game.ended) cur.comment = cur.comment ? `${cur.comment} ${body}` : body;
      i = end === -1 ? n : end + 1;
      continue;
    }

    if (ch === '(') {
      if (!game || game.ended) newGame();
      stack.push(cur);
      // A variation is an alternative to the last move played.
      if (cur.parent) cur = cur.parent;
      i++;
      continue;
    }

    if (ch === ')') {
      if (stack.length) cur = stack.pop();
      i++;
      continue;
    }

    if (ch === '$') {
      i++;
      while (i < n && /\d/.test(text[i])) i++;
      continue;
    }

    // A plain token: move number, move, annotation or result.
    let j = i;
    while (j < n && !/[\s{}()\[\];$]/.test(text[j])) j++;
    let tok = text.slice(i, j);
    i = j === i ? i + 1 : j;

    if (RESULT.test(tok)) {
      if (game) game.ended = true;
      continue;
    }
    if (/^[0O]-[0O]-[0O]/.test(tok)) tok = 'O-O-O' + tok.slice(5);
    else if (/^[0O]-[0O]/.test(tok)) tok = 'O-O' + tok.slice(3);
    tok = tok.replace(/^\d+\.+/, '');          // "12." / "12..." / "1.e4"
    tok = tok.replace(/[!?]+$/, '');             // annotation glyphs
    if (!tok || /^\.+$/.test(tok) || /^\d+$/.test(tok)) continue;

    if (!game || game.ended) newGame();
    const node = { san: tok, comment: '', children: [], parent: cur };
    cur.children.push(node);
    cur = node;
    game.hasMoves = true;
  }

  return games
    .filter((g) => g.hasMoves)
    .map((g) => ({ headers: g.headers, root: g.root }));
}

/** Remove Lichess/ChessBase commands like [%cal ...] and [%clk ...] from comments. */
export function cleanComment(text) {
  return (text || '').replace(/\[%[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}

/** Position key for transposition-aware lookups (board, side, castling, ep). */
export function positionKey(fen) {
  return fen.split(' ').slice(0, 4).join(' ');
}

/**
 * Walk a game's move tree and return every root-to-leaf line.
 * Also records, for every position reached, which moves the PGN plays there
 * (used to recognise "that's in your repertoire, just not this line").
 */
export function extractLines(game) {
  const headerFen = game.headers.FEN;
  let chess;
  try {
    chess = headerFen ? new Chess(headerFen) : new Chess();
  } catch {
    return { lines: [], positions: new Map(), errors: [`Invalid FEN header: ${headerFen}`] };
  }
  const startFen = chess.fen();
  const lines = [];
  const errors = [];
  const positions = new Map();
  const path = [];

  const walk = (node) => {
    if (!node.children.length) {
      if (path.length) lines.push({ startFen, moves: path.slice() });
      return;
    }
    for (const child of node.children) {
      const key = positionKey(chess.fen());
      let mv = null;
      try { mv = chess.move(child.san); } catch { mv = null; }
      if (!mv) {
        errors.push(`“${child.san}” is not a legal move after ${formatLine(path, startFen) || 'the start'}`);
        if (path.length) lines.push({ startFen, moves: path.slice() });
        continue;
      }
      if (!positions.has(key)) positions.set(key, new Set());
      positions.get(key).add(mv.san);
      path.push({
        san: mv.san,
        from: mv.from,
        to: mv.to,
        promotion: mv.promotion || null,
        comment: cleanComment(child.comment),
      });
      walk(child);
      path.pop();
      chess.undo();
    }
  };
  walk(game.root);
  return { lines, positions, errors };
}

/** Fast, stable 53-bit string hash (cyrb53), returned in base 36. */
export function hash(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function lineId(line) {
  return hash(`${line.startFen}|${line.moves.map((m) => m.san).join(' ')}`);
}

/** Move number info for ply index i in a line starting from startFen. */
export function plyInfo(startFen, i) {
  const parts = startFen.split(' ');
  const whiteStarts = parts[1] !== 'b';
  const startNo = parseInt(parts[5], 10) || 1;
  const offset = whiteStarts ? i : i + 1;
  return {
    number: startNo + Math.floor(offset / 2),
    white: offset % 2 === 0,
  };
}

/** Plain-text rendering of a move list, e.g. "1.e4 e5 2.Nf3". */
export function formatLine(moves, startFen) {
  return moves
    .map((m, i) => {
      const { number, white } = plyInfo(startFen, i);
      if (white) return `${number}.${m.san}`;
      if (i === 0) return `${number}…${m.san}`;
      return m.san;
    })
    .join(' ');
}
