import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseFen, toFen } from './fen.js';
import { applyMove } from './movegen.js';
import { explainMove, parseUci, statusOf, validatePosition, moveToUci } from './game.js';
import { INITIAL_FEN } from './types.js';

export class StoreError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface GameRow {
  id: number;
  initial_fen: string;
  current_fen: string;
  version: number;
  status: string;
  created_at: string;
}

export interface MoveRow {
  id: number;
  game_id: number;
  ply: number;
  uci: string;
  fen_after: string;
  in_check: number;
  checkmate: number;
  stalemate: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  initial_fen TEXT NOT NULL,
  current_fen TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id),
  ply INTEGER NOT NULL,
  uci TEXT NOT NULL,
  fen_after TEXT NOT NULL,
  in_check INTEGER NOT NULL DEFAULT 0,
  checkmate INTEGER NOT NULL DEFAULT 0,
  stalemate INTEGER NOT NULL DEFAULT 0
);
`;

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createGame(fen: string = INITIAL_FEN): GameRow {
    let state;
    try {
      state = parseFen(fen);
    } catch (e) {
      if (e instanceof Error && e.name === 'FenError') {
        throw new StoreError('INVALID_FEN', (e as Error).message, (e as { issues?: string[] }).issues);
      }
      throw e;
    }
    const issues = validatePosition(state);
    if (issues.length > 0) {
      throw new StoreError('INVALID_POSITION', '局面不满足一致性规则: ' + issues.join('; '), issues);
    }
    const normalized = toFen(state);
    const st = statusOf(state);
    const status = st.checkmate ? 'checkmate' : st.stalemate ? 'stalemate' : 'active';
    const r = this.db
      .prepare('INSERT INTO games (initial_fen, current_fen, status) VALUES (?, ?, ?)')
      .run(normalized, normalized, status);
    return this.getGame(Number(r.lastInsertRowid));
  }

  getGame(id: number): GameRow {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as GameRow | undefined;
    if (!row) throw new StoreError('NOT_FOUND', `对局 ${id} 不存在`);
    return row;
  }

  listGames(): GameRow[] {
    return this.db.prepare('SELECT * FROM games ORDER BY id').all() as unknown as GameRow[];
  }

  history(gameId: number): MoveRow[] {
    this.getGame(gameId);
    return this.db.prepare('SELECT * FROM moves WHERE game_id = ? ORDER BY ply').all(gameId) as unknown as MoveRow[];
  }

  /**
   * 落子：要求 expectedVersion 与当前 version 一致（乐观并发控制），
   * 非法走子不写库；成功时在同一事务内写入着法并更新局面与版本。
   */
  playMove(gameId: number, uci: string, expectedVersion: number): { game: GameRow; move: MoveRow; explanation: string[] } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const game = this.getGame(gameId);
      if (game.version !== expectedVersion) {
        throw new StoreError(
          'VERSION_CONFLICT',
          `版本冲突：期望 ${expectedVersion}，当前 ${game.version}。请重新获取局面后重试`,
          { expected: expectedVersion, actual: game.version },
        );
      }
      if (game.status !== 'active') {
        throw new StoreError('GAME_FINISHED', `对局已结束（${game.status}），不能再落子`);
      }
      const state = parseFen(game.current_fen);
      const move = parseUci(uci);
      if (!move) {
        throw new StoreError('BAD_MOVE_FORMAT', `着法 '${uci}' 不是合法的 UCI 坐标格式（如 e2e4、e7e8q）`);
      }
      const ex = explainMove(state, move);
      if (!ex.legal) {
        throw new StoreError('ILLEGAL_MOVE', ex.reasons.join('; '), ex.reasons);
      }
      const next = applyMove(state, move);
      const st = statusOf(next);
      const status = st.checkmate ? 'checkmate' : st.stalemate ? 'stalemate' : 'active';
      const ply = game.version + 1;
      const fenAfter = toFen(next);
      const mr = this.db
        .prepare('INSERT INTO moves (game_id, ply, uci, fen_after, in_check, checkmate, stalemate) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(gameId, ply, moveToUci(move), fenAfter, st.inCheck ? 1 : 0, st.checkmate ? 1 : 0, st.stalemate ? 1 : 0);
      this.db
        .prepare('UPDATE games SET current_fen = ?, version = version + 1, status = ? WHERE id = ? AND version = ?')
        .run(fenAfter, status, gameId, game.version);
      this.db.exec('COMMIT');
      const moveRow = this.db.prepare('SELECT * FROM moves WHERE id = ?').get(Number(mr.lastInsertRowid)) as unknown as MoveRow;
      return { game: this.getGame(gameId), move: moveRow, explanation: ex.steps };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 从初始 FEN 按已保存着法链重放并核验，返回最终 FEN 是否与当前局面一致。 */
  replay(gameId: number): { ok: boolean; plies: number; finalFen: string; currentFen: string; mismatchAt?: number } {
    const game = this.getGame(gameId);
    const moves = this.history(gameId);
    let state = parseFen(game.initial_fen);
    for (const m of moves) {
      const mv = parseUci(m.uci);
      if (!mv) return { ok: false, plies: m.ply - 1, finalFen: toFen(state), currentFen: game.current_fen, mismatchAt: m.ply };
      const ex = explainMove(state, mv);
      if (!ex.legal) return { ok: false, plies: m.ply - 1, finalFen: toFen(state), currentFen: game.current_fen, mismatchAt: m.ply };
      state = applyMove(state, mv);
      if (toFen(state) !== m.fen_after) {
        return { ok: false, plies: m.ply, finalFen: toFen(state), currentFen: game.current_fen, mismatchAt: m.ply };
      }
    }
    const finalFen = toFen(state);
    return { ok: finalFen === game.current_fen, plies: moves.length, finalFen, currentFen: game.current_fen };
  }

  exportGame(gameId: number): { id: number; initialFen: string; moves: string[]; currentFen: string; status: string } {
    const game = this.getGame(gameId);
    const moves = this.history(gameId).map((m) => m.uci);
    return { id: game.id, initialFen: game.initial_fen, moves, currentFen: game.current_fen, status: game.status };
  }
}

/** 默认数据目录：项目内 data/chess.db，可用 CHESS_DB 覆盖。 */
export function defaultDbPath(): string {
  return process.env.CHESS_DB ?? resolve(process.cwd(), 'data', 'chess.db');
}

