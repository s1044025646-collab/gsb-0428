export type Color = 'w' | 'b';
export type Promotion = 'q' | 'r' | 'b' | 'n';

/** 棋盘状态。board 为长度 64 的数组，索引 0 = a1，63 = h8；大写为白方棋子。 */
export interface State {
  board: (string | null)[];
  turn: Color;
  /** 易位权利，子集 "KQkq"，无权利时为 '' */
  castling: string;
  /** 过路兵目标格索引，无则 null */
  ep: number | null;
  halfmove: number;
  fullmove: number;
}

export interface Move {
  from: number;
  to: number;
  promotion?: Promotion;
}

export const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function sqName(idx: number): string {
  return 'abcdefgh'[idx & 7] + String((idx >> 3) + 1);
}

export function sqIndex(name: string): number | null {
  if (!/^[a-h][1-8]$/.test(name)) return null;
  return (name.charCodeAt(0) - 97) + (name.charCodeAt(1) - 49) * 8;
}

export function fileOf(idx: number): number {
  return idx & 7;
}

export function rankOf(idx: number): number {
  return idx >> 3;
}

export function isWhitePiece(p: string): boolean {
  return p >= 'A' && p <= 'Z';
}

export function pieceColor(p: string): Color {
  return isWhitePiece(p) ? 'w' : 'b';
}

export function opposite(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}
