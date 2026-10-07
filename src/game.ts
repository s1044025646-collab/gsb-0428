import { Move, State, sqName, sqIndex, fileOf, rankOf, opposite, pieceColor, Promotion } from './types.js';
import { parseFen, toFen, FenError } from './fen.js';
import { attackers, applyMove, inCheck, kingSquare, legalMoves, pseudoMoves } from './movegen.js';

export const PIECE_NAMES: Record<string, string> = {
  p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王',
};

/**
 * 局面一致性规则（在 FEN 形式合法之上）：
 * - 双方各恰好一个王
 * - 兵不能停在第 1/8 横排
 * - 双方王不能相邻
 * - 非行棋方的王不能正被攻击（否则上一手非法）
 * - 易位权利所需的王与车必须在原位
 * - 过路兵格：目标格必须为空，且对应纵线上必须有刚走两格的兵
 * 形式合法但无法从初局到达的局面不额外追溯。
 */
export function validatePosition(s: State): string[] {
  const issues: string[] = [];
  const b = s.board;

  const wk = kingSquare(b, 'w');
  const bk = kingSquare(b, 'b');
  const count = (ch: string) => b.filter((p) => p === ch).length;
  if (count('K') !== 1) issues.push(`白王必须恰好一个，实际 ${count('K')} 个`);
  if (count('k') !== 1) issues.push(`黑王必须恰好一个，实际 ${count('k')} 个`);

  for (let f = 0; f < 8; f++) {
    const a = b[f];
    const h = b[56 + f];
    if (a === 'P' || a === 'p') issues.push(`兵不能停在第 1 横排（${sqName(f)}）`);
    if (h === 'P' || h === 'p') issues.push(`兵不能停在第 8 横排（${sqName(56 + f)}）`);
  }

  if (wk >= 0 && bk >= 0) {
    const df = Math.abs(fileOf(wk) - fileOf(bk));
    const dr = Math.abs(rankOf(wk) - rankOf(bk));
    if (df <= 1 && dr <= 1) {
      issues.push(`双方王不能相邻（白王 ${sqName(wk)}，黑王 ${sqName(bk)}）`);
    }
  }

  // 非行棋方的王不能处于被攻击状态
  const notTurn = opposite(s.turn);
  const ntKing = kingSquare(b, notTurn);
  if (ntKing >= 0 && attackers(b, ntKing, s.turn).length > 0) {
    issues.push(`非行棋方（${notTurn === 'w' ? '白' : '黑'}）的王正被攻击，该局面不可能由上一步合法走子产生`);
  }

  // 易位权利需要王车在位
  const need = (right: string, kingSq: number, king: string, rookSq: number, rook: string, label: string) => {
    if (s.castling.includes(right)) {
      if (b[kingSq] !== king || b[rookSq] !== rook) {
        issues.push(`易位权利 ${right} 要求 ${label} 在原位（王 ${sqName(kingSq)}、车 ${sqName(rookSq)}）`);
      }
    }
  };
  need('K', 4, 'K', 7, 'R', '白方王与 h1 车');
  need('Q', 4, 'K', 0, 'R', '白方王与 a1 车');
  need('k', 60, 'k', 63, 'r', '黑方王与 h8 车');
  need('q', 60, 'k', 56, 'r', '黑方王与 a8 车');

  // 过路兵格一致性（不保证一定存在合法的吃过路兵着法）
  if (s.ep !== null) {
    const ep = s.ep;
    if (b[ep] !== null) {
      issues.push(`过路兵目标格 ${sqName(ep)} 必须为空`);
    }
    const epRank = rankOf(ep);
    const epFile = fileOf(ep);
    if (epRank === 5) {
      if (b[ep - 8] !== 'p') issues.push(`过路兵格 ${sqName(ep)} 要求 ${sqName(ep - 8)} 有刚走两格的黑兵`);
      if (b[ep - 16] !== null) issues.push(`过路兵格 ${sqName(ep)} 要求兵起点 ${sqName(ep - 16)} 为空`);
    } else if (epRank === 2) {
      if (b[ep + 8] !== 'P') issues.push(`过路兵格 ${sqName(ep)} 要求 ${sqName(ep + 8)} 有刚走两格的白兵`);
      if (b[ep + 16] !== null) issues.push(`过路兵格 ${sqName(ep)} 要求兵起点 ${sqName(ep + 16)} 为空`);
    }
    void epFile;
  }

  return issues;
}

export function moveToUci(m: Move): string {
  return sqName(m.from) + sqName(m.to) + (m.promotion ?? '');
}

export function parseUci(uci: string): Move | null {
  const m = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/.exec(uci.trim());
  if (!m) return null;
  const from = sqIndex(m[1])!;
  const to = sqIndex(m[2])!;
  const promotion = m[3] ? (m[3].toLowerCase() as Promotion) : undefined;
  return { from, to, promotion };
}

export interface Status {
  inCheck: boolean;
  legalMoveCount: number;
  checkmate: boolean;
  stalemate: boolean;
  finished: boolean;
}

export function statusOf(s: State): Status {
  const moves = legalMoves(s);
  const check = inCheck(s);
  const checkmate = check && moves.length === 0;
  const stalemate = !check && moves.length === 0;
  return {
    inCheck: check,
    legalMoveCount: moves.length,
    checkmate,
    stalemate,
    finished: checkmate || stalemate,
  };
}

export interface ExplainResult {
  legal: boolean;
  uci: string;
  /** 不合法时的实际原因（含相关格子） */
  reasons: string[];
  /** 合法时的逐项解释 */
  steps: string[];
  fenBefore: string;
  fenAfter?: string;
  givesCheck?: boolean;
  givesCheckmate?: boolean;
  givesStalemate?: boolean;
}

function describeCandidate(s: State, m: Move): string[] {
  const steps: string[] = [];
  const p = s.board[m.from]!;
  const lower = p.toLowerCase();
  const name = PIECE_NAMES[lower];
  const fromN = sqName(m.from);
  const toN = sqName(m.to);
  const target = s.board[m.to];

  if (lower === 'k' && Math.abs(m.to - m.from) === 2) {
    const side = m.to > m.from ? '短易位（王翼）' : '长易位（后翼）';
    const rookFrom = m.to > m.from ? m.from + 3 : m.from - 4;
    const rookTo = m.to > m.from ? m.from + 1 : m.from - 1;
    steps.push(`${side}：王 ${fromN} → ${toN}，车 ${sqName(rookFrom)} → ${sqName(rookTo)}，两子同时移动`);
    steps.push('易位后本方的全部易位权利移除');
  } else if (lower === 'p' && s.ep !== null && m.to === s.ep && target === null) {
    const captured = m.to + (s.turn === 'w' ? -8 : 8);
    steps.push(`吃过路兵：兵 ${fromN} → ${toN}，移除 ${sqName(captured)} 上刚走两格的兵`);
  } else if (lower === 'p' && m.promotion) {
    steps.push(`兵到底线升变：${fromN} → ${toN}，升为${PIECE_NAMES[m.promotion]}${target ? `，同时吃掉 ${toN} 的${PIECE_NAMES[target.toLowerCase()]}` : ''}`);
  } else if (lower === 'p' && Math.abs(m.to - m.from) === 16) {
    steps.push(`兵从起始位前进两格：${fromN} → ${toN}，本轮在 ${sqName((m.from + m.to) / 2)} 留下过路兵机会`);
  } else if (target) {
    steps.push(`${name} ${fromN} → ${toN}，吃掉 ${toN} 上的${PIECE_NAMES[target.toLowerCase()]}`);
  } else {
    steps.push(`${name} ${fromN} → ${toN}`);
  }

  if (lower === 'p' || target || (lower === 'p' && s.ep === m.to)) {
    steps.push('兵移动或吃子：半回合计数重置为 0');
  } else {
    steps.push(`非兵非吃子：半回合计数 ${s.halfmove} → ${s.halfmove + 1}`);
  }
  if (s.turn === 'b') {
    steps.push(`黑方走子：回合编号 ${s.fullmove} → ${s.fullmove + 1}`);
  }
  return steps;
}

/** 解释一步候选着法：合法时给出逐项说明与新 FEN，非法时给出实际原因与相关格子。 */
export function explainMove(s: State, m: Move): ExplainResult {
  const uci = moveToUci(m);
  const fenBefore = toFen(s);
  const base: ExplainResult = { legal: false, uci, reasons: [], steps: [], fenBefore };

  const p = s.board[m.from];
  if (p === null) {
    base.reasons.push(`起点格 ${sqName(m.from)} 上没有棋子`);
    return base;
  }
  if (pieceColor(p) !== s.turn) {
    base.reasons.push(`${sqName(m.from)} 上是${pieceColor(p) === 'w' ? '白' : '黑'}方棋子，现在轮到${s.turn === 'w' ? '白' : '黑'}方走子`);
    return base;
  }
  const target = s.board[m.to];
  if (target !== null && pieceColor(target) === s.turn) {
    base.reasons.push(`终点格 ${sqName(m.to)} 被己方棋子占据`);
    return base;
  }
  if (target !== null && target.toLowerCase() === 'k') {
    base.reasons.push(`不能吃掉对方王（${sqName(m.to)}），王只能被将死`);
    return base;
  }

  const lower = p.toLowerCase();
  const lastRank = s.turn === 'w' ? 7 : 0;
  if (lower === 'p' && rankOf(m.to) === lastRank && !m.promotion) {
    base.reasons.push(`兵到达底线（${sqName(m.to)}）必须指定升变：q（后）、r（车）、b（象）或 n（马），不允许默认升后`);
    return base;
  }
  if (m.promotion && !(lower === 'p' && rankOf(m.to) === lastRank)) {
    base.reasons.push(`只有兵到达底线才能升变（${sqName(m.from)} → ${sqName(m.to)} 不是升变着法）`);
    return base;
  }

  const pseudo = pseudoMoves(s);
  const isPseudo = pseudo.some(
    (x) => x.from === m.from && x.to === m.to && (x.promotion ?? '') === (m.promotion ?? ''),
  );
  if (!isPseudo) {
    base.reasons.push(
      `${PIECE_NAMES[lower]}不能按此方式从 ${sqName(m.from)} 走到 ${sqName(m.to)}（不符合该棋子的移动规则，或途中被阻挡，或不满足易位/吃过路兵条件）`,
    );
    return base;
  }

  const next = applyMove(s, m);
  const ksq = kingSquare(next.board, s.turn);
  const kingAttackers = attackers(next.board, ksq, opposite(s.turn));
  if (kingAttackers.length > 0) {
    const names = kingAttackers
      .map((a) => `${PIECE_NAMES[next.board[a]!.toLowerCase()]}@${sqName(a)}`)
      .join('、');
    base.reasons.push(`走子后己方王在 ${sqName(ksq)} 仍被 ${names} 攻击，属于送王入将，禁止`);
    return base;
  }

  base.legal = true;
  base.steps = describeCandidate(s, m);
  base.fenAfter = toFen(next);
  const st = statusOf(next);
  if (st.checkmate) {
    base.givesCheckmate = true;
    base.steps.push('此着将死对方，对局结束');
  } else if (st.inCheck) {
    base.givesCheck = true;
    base.steps.push('此着将军');
  } else if (st.stalemate) {
    base.givesStalemate = true;
    base.steps.push('此着造成逼和（对方无合法着法且未被将军），对局为和棋');
  }
  return base;
}

export interface ApplyOk {
  ok: true;
  state: State;
  fen: string;
  explain: ExplainResult;
}
export interface ApplyErr {
  ok: false;
  reasons: string[];
}
export type ApplyResult = ApplyOk | ApplyErr;

/** 解析 FEN + UCI 并尝试执行，返回新状态或原因。 */
export function tryApply(fen: string, uci: string): ApplyResult {
  let state: State;
  try {
    state = parseFen(fen);
  } catch (e) {
    if (e instanceof FenError) return { ok: false, reasons: e.issues };
    throw e;
  }
  const posIssues = validatePosition(state);
  if (posIssues.length > 0) return { ok: false, reasons: posIssues };
  const move = parseUci(uci);
  if (!move) return { ok: false, reasons: [`着法 '${uci}' 不是合法的 UCI 坐标格式（如 e2e4、e7e8q）`] };
  const ex = explainMove(state, move);
  if (!ex.legal) return { ok: false, reasons: ex.reasons };
  return { ok: true, state: applyMove(state, move), fen: ex.fenAfter!, explain: ex };
}
