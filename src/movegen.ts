import { Move, State, Color, fileOf, rankOf, opposite, pieceColor, Promotion } from './types.js';

const KNIGHT_JUMPS: [number, number][] = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_STEPS: [number, number][] = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const DIAG: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHO: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function onBoard(f: number, r: number): boolean {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

/**
 * 返回攻击 sq 格的 by 方棋子所在格列表。
 * 纯攻击规则判定：兵的攻击格与移动格不同；被钉住的棋子依然计入攻击；
 * 不调用合法走子生成，避免无限递归。
 */
export function attackers(board: (string | null)[], sq: number, by: Color): number[] {
  const result: number[] = [];
  const f = fileOf(sq);
  const r = rankOf(sq);
  const white = by === 'w';

  // 兵：白兵向上攻击，黑兵向下攻击
  const pawnChar = white ? 'P' : 'p';
  const pawnRank = r + (white ? -1 : 1);
  if (pawnRank >= 0 && pawnRank < 8) {
    for (const df of [-1, 1]) {
      const pf = f + df;
      if (pf >= 0 && pf < 8 && board[pawnRank * 8 + pf] === pawnChar) {
        result.push(pawnRank * 8 + pf);
      }
    }
  }

  // 马
  const knightChar = white ? 'N' : 'n';
  for (const [df, dr] of KNIGHT_JUMPS) {
    const nf = f + df;
    const nr = r + dr;
    if (onBoard(nf, nr) && board[nr * 8 + nf] === knightChar) {
      result.push(nr * 8 + nf);
    }
  }

  // 王
  const kingChar = white ? 'K' : 'k';
  for (const [df, dr] of KING_STEPS) {
    const nf = f + df;
    const nr = r + dr;
    if (onBoard(nf, nr) && board[nr * 8 + nf] === kingChar) {
      result.push(nr * 8 + nf);
    }
  }

  // 滑动子：象/后沿斜线，车/后沿直线
  const bishopChar = white ? 'B' : 'b';
  const rookChar = white ? 'R' : 'r';
  const queenChar = white ? 'Q' : 'q';
  const scan = (dirs: [number, number][], chars: Set<string>) => {
    for (const [df, dr] of dirs) {
      let nf = f + df;
      let nr = r + dr;
      while (onBoard(nf, nr)) {
        const p = board[nr * 8 + nf];
        if (p !== null) {
          if (chars.has(p)) result.push(nr * 8 + nf);
          break;
        }
        nf += df;
        nr += dr;
      }
    }
  };
  scan(DIAG, new Set([bishopChar, queenChar]));
  scan(ORTHO, new Set([rookChar, queenChar]));

  return result;
}

export function isAttacked(board: (string | null)[], sq: number, by: Color): boolean {
  return attackers(board, sq, by).length > 0;
}

export function kingSquare(board: (string | null)[], color: Color): number {
  const k = color === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) {
    if (board[i] === k) return i;
  }
  return -1;
}

const PROMOTIONS: Promotion[] = ['q', 'r', 'b', 'n'];

/** 生成某一格的候选走子（不含王安全过滤）。 */
function pseudoForSquare(s: State, from: number, out: Move[]): void {
  const board = s.board;
  const p = board[from];
  if (p === null || pieceColor(p) !== s.turn) return;
  const white = s.turn === 'w';
  const f = fileOf(from);
  const r = rankOf(from);
  const lower = p.toLowerCase();

  const pushIf = (to: number) => {
    const t = board[to];
    if (t === null || pieceColor(t) !== s.turn) out.push({ from, to });
  };

  if (lower === 'p') {
    const dir = white ? 8 : -8;
    const startRank = white ? 1 : 6;
    const lastRank = white ? 7 : 0;
    const one = from + dir;
    if (one >= 0 && one < 64 && board[one] === null) {
      if (rankOf(one) === lastRank) {
        for (const pr of PROMOTIONS) out.push({ from, to: one, promotion: pr });
      } else {
        out.push({ from, to: one });
        const two = from + dir * 2;
        if (r === startRank && board[two] === null) {
          out.push({ from, to: two });
        }
      }
    }
    for (const df of [-1, 1]) {
      const cf = f + df;
      if (cf < 0 || cf > 7) continue;
      const to = from + dir + df;
      const t = board[to];
      const isCapture = t !== null && pieceColor(t) !== s.turn;
      const isEp = s.ep !== null && to === s.ep;
      if (isCapture || isEp) {
        if (rankOf(to) === lastRank) {
          for (const pr of PROMOTIONS) out.push({ from, to, promotion: pr });
        } else {
          out.push({ from, to });
        }
      }
    }
  } else if (lower === 'n') {
    for (const [df, dr] of KNIGHT_JUMPS) {
      const nf = f + df;
      const nr = r + dr;
      if (onBoard(nf, nr)) pushIf(nr * 8 + nf);
    }
  } else if (lower === 'k') {
    for (const [df, dr] of KING_STEPS) {
      const nf = f + df;
      const nr = r + dr;
      if (onBoard(nf, nr)) pushIf(nr * 8 + nf);
    }
    // 易位：权利、王车在位、途中空格、王起点/经过/终点不受攻击
    const enemy = opposite(s.turn);
    const home = white ? 4 : 60; // e1 / e8
    if (from === home && p === (white ? 'K' : 'k')) {
      const ksRight = white ? 'K' : 'k';
      const qsRight = white ? 'Q' : 'q';
      const rook = white ? 'R' : 'r';
      if (
        s.castling.includes(ksRight) &&
        board[home + 1] === null && board[home + 2] === null &&
        board[home + 3] === rook &&
        !isAttacked(board, home, enemy) &&
        !isAttacked(board, home + 1, enemy) &&
        !isAttacked(board, home + 2, enemy)
      ) {
        out.push({ from, to: home + 2 });
      }
      if (
        s.castling.includes(qsRight) &&
        board[home - 1] === null && board[home - 2] === null && board[home - 3] === null &&
        board[home - 4] === rook &&
        !isAttacked(board, home, enemy) &&
        !isAttacked(board, home - 1, enemy) &&
        !isAttacked(board, home - 2, enemy)
      ) {
        out.push({ from, to: home - 2 });
      }
    }
  } else {
    const dirs: [number, number][] =
      lower === 'b' ? DIAG : lower === 'r' ? ORTHO : [...DIAG, ...ORTHO];
    for (const [df, dr] of dirs) {
      let nf = f + df;
      let nr = r + dr;
      while (onBoard(nf, nr)) {
        const to = nr * 8 + nf;
        const t = board[to];
        if (t === null) {
          out.push({ from, to });
        } else {
          if (pieceColor(t) !== s.turn) out.push({ from, to });
          break;
        }
        nf += df;
        nr += dr;
      }
    }
  }
}

/** 全部候选走子（伪合法，未做王安全过滤）。 */
export function pseudoMoves(s: State): Move[] {
  const out: Move[] = [];
  for (let i = 0; i < 64; i++) pseudoForSquare(s, i, out);
  return out;
}

function removeCastling(castling: string, ...rights: string[]): string {
  let c = castling;
  for (const r of rights) c = c.replace(r, '');
  return c;
}

/** 应用一步候选走子，返回新状态（不做合法性校验）。 */
export function applyMove(s: State, m: Move): State {
  const board = s.board.slice();
  const p = board[m.from]!;
  const white = s.turn === 'w';
  const lower = p.toLowerCase();
  const target = board[m.to];
  const isCapture = target !== null || (lower === 'p' && s.ep !== null && m.to === s.ep);

  board[m.from] = null;

  // 吃过路兵：移除旁边的兵
  if (lower === 'p' && s.ep !== null && m.to === s.ep && target === null) {
    board[m.to + (white ? -8 : 8)] = null;
  }

  // 易位：同时移动车
  if (lower === 'k' && Math.abs(m.to - m.from) === 2) {
    const home = white ? 4 : 60;
    if (m.to === home + 2) {
      board[home + 1] = board[home + 3];
      board[home + 3] = null;
    } else if (m.to === home - 2) {
      board[home - 1] = board[home - 4];
      board[home - 4] = null;
    }
  }

  board[m.to] = m.promotion ? (white ? m.promotion.toUpperCase() : m.promotion) : p;

  // 易位权利更新：王动、车动、角落车被吃
  let castling = s.castling;
  if (p === 'K') castling = removeCastling(castling, 'K', 'Q');
  if (p === 'k') castling = removeCastling(castling, 'k', 'q');
  if (m.from === 7) castling = removeCastling(castling, 'K');
  if (m.from === 0) castling = removeCastling(castling, 'Q');
  if (m.from === 63) castling = removeCastling(castling, 'k');
  if (m.from === 56) castling = removeCastling(castling, 'q');
  if (m.to === 7) castling = removeCastling(castling, 'K');
  if (m.to === 0) castling = removeCastling(castling, 'Q');
  if (m.to === 63) castling = removeCastling(castling, 'k');
  if (m.to === 56) castling = removeCastling(castling, 'q');

  // 过路兵目标格：仅兵走两格时设置，仅下一轮有效
  let ep: number | null = null;
  if (lower === 'p' && Math.abs(m.to - m.from) === 16) {
    ep = (m.from + m.to) / 2;
  }

  return {
    board,
    turn: opposite(s.turn),
    castling,
    ep,
    halfmove: lower === 'p' || isCapture ? 0 : s.halfmove + 1,
    fullmove: s.turn === 'b' ? s.fullmove + 1 : s.fullmove,
  };
}

const PROM_ORDER: Record<string, number> = { q: 0, r: 1, b: 2, n: 3 };

function moveCompare(a: Move, b: Move): number {
  if (a.from !== b.from) return a.from - b.from;
  if (a.to !== b.to) return a.to - b.to;
  return (PROM_ORDER[a.promotion ?? 'q'] ?? 0) - (PROM_ORDER[b.promotion ?? 'q'] ?? 0);
}

/**
 * 合法走子 = 候选走子中，试走后己方王不受攻击者。
 * 输出顺序固定：起点格 a1→h8，再终点格 a1→h8，升变按 q,r,b,n。
 */
export function legalMoves(s: State): Move[] {
  const enemy = opposite(s.turn);
  const out: Move[] = [];
  for (const m of pseudoMoves(s)) {
    const next = applyMove(s, m);
    const ksq = kingSquare(next.board, s.turn);
    if (ksq >= 0 && !isAttacked(next.board, ksq, enemy)) {
      out.push(m);
    }
  }
  out.sort(moveCompare);
  return out;
}

export function inCheck(s: State): boolean {
  const ksq = kingSquare(s.board, s.turn);
  return ksq >= 0 && isAttacked(s.board, ksq, opposite(s.turn));
}

/** 计算从当前局面出发 depth 层的叶子数（perft，仅用于规则测试）。 */
export function perft(s: State, depth: number): number {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const m of legalMoves(s)) {
    nodes += perft(applyMove(s, m), depth - 1);
  }
  return nodes;
}
