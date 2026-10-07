import { State } from './types.js';

export class FenError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super('FEN 不合法: ' + issues.join('; '));
    this.name = 'FenError';
    this.issues = issues;
  }
}

const PIECE_CHARS = new Set(['p', 'n', 'b', 'r', 'q', 'k', 'P', 'N', 'B', 'R', 'Q', 'K']);

/** 解析并校验 FEN 六个字段；不合法时抛出携带逐项原因的 FenError。 */
export function parseFen(fen: string): State {
  const issues: string[] = [];
  const parts = fen.trim().split(/\s+/);
  if (parts.length !== 6) {
    throw new FenError([`FEN 必须有 6 个字段，实际为 ${parts.length} 个`]);
  }
  const [placement, turn, castling, ep, halfmove, fullmove] = parts;

  const board: (string | null)[] = new Array(64).fill(null);
  const rows = placement.split('/');
  if (rows.length !== 8) {
    issues.push(`棋盘字段必须有 8 行，实际为 ${rows.length} 行`);
  } else {
    for (let r = 0; r < 8; r++) {
      const row = rows[r];
      const rank = 7 - r; // FEN 第一行为第 8 横排
      let file = 0;
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          file += ch.charCodeAt(0) - 48;
        } else if (PIECE_CHARS.has(ch)) {
          if (file >= 8) {
            issues.push(`第 ${rank + 1} 横排格子数超过 8`);
            break;
          }
          board[rank * 8 + file] = ch;
          file++;
        } else {
          issues.push(`第 ${rank + 1} 横排含非法字符 '${ch}'`);
        }
      }
      if (file !== 8) {
        issues.push(`第 ${rank + 1} 横排格数为 ${file}，应为 8`);
      }
    }
  }

  if (turn !== 'w' && turn !== 'b') {
    issues.push(`行棋方必须为 'w' 或 'b'，实际为 '${turn}'`);
  }

  let cast = castling;
  if (castling === '-') {
    cast = '';
  } else if (!/^[KQkq]{1,4}$/.test(castling) || new Set(castling).size !== castling.length) {
    issues.push(`易位权利字段不合法: '${castling}'（应为 '-' 或 KQkq 的不重复子集）`);
    cast = '';
  }

  let epSq: number | null = null;
  if (ep !== '-') {
    if (!/^[a-h][36]$/.test(ep)) {
      issues.push(`过路兵格必须为 '-' 或第 3/6 横排的格子（如 e6），实际为 '${ep}'`);
    } else {
      epSq = (ep.charCodeAt(0) - 97) + (ep.charCodeAt(1) - 49) * 8;
    }
  }

  const hm = Number(halfmove);
  if (!Number.isInteger(hm) || hm < 0) {
    issues.push(`半回合计数必须为非负整数，实际为 '${halfmove}'`);
  }
  const fm = Number(fullmove);
  if (!Number.isInteger(fm) || fm < 1) {
    issues.push(`回合编号必须为不小于 1 的整数，实际为 '${fullmove}'`);
  }

  if (issues.length > 0) {
    throw new FenError(issues);
  }

  return {
    board,
    turn: turn as 'w' | 'b',
    castling: cast,
    ep: epSq,
    halfmove: hm,
    fullmove: fm,
  };
}

export function toFen(s: State): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const p = s.board[rank * 8 + file];
      if (p === null) {
        empty++;
      } else {
        if (empty > 0) {
          row += String(empty);
          empty = 0;
        }
        row += p;
      }
    }
    if (empty > 0) row += String(empty);
    rows.push(row);
  }
  const ep = s.ep === null ? '-' : 'abcdefgh'[s.ep & 7] + String((s.ep >> 3) + 1);
  return `${rows.join('/')} ${s.turn} ${s.castling === '' ? '-' : s.castling} ${ep} ${s.halfmove} ${s.fullmove}`;
}
