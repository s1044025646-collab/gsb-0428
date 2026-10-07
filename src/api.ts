import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { parseFen, toFen, FenError } from './fen.js';
import { legalMoves, inCheck } from './movegen.js';
import { explainMove, moveToUci, parseUci, statusOf, tryApply, validatePosition } from './game.js';
import { Store, StoreError } from './store.js';
import { INITIAL_FEN } from './types.js';

interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function err(status: number, code: string, message: string, details?: unknown): ApiError {
  return { status, code, message, details };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function sendErr(res: ServerResponse, e: ApiError): void {
  send(res, e.status, { error: { code: e.code, message: e.message, details: e.details } });
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw err(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

function needFen(body: Record<string, unknown>): string {
  const fen = body.fen;
  if (typeof fen !== 'string' || fen.trim() === '') {
    throw err(400, 'MISSING_FEN', "请求体必须包含字符串字段 'fen'");
  }
  return fen;
}

function parseAndValidate(fen: string) {
  let state;
  try {
    state = parseFen(fen);
  } catch (e) {
    if (e instanceof FenError) throw err(400, 'INVALID_FEN', e.message, e.issues);
    throw e;
  }
  const issues = validatePosition(state);
  if (issues.length > 0) throw err(422, 'INVALID_POSITION', '局面不满足一致性规则: ' + issues.join('; '), issues);
  return state;
}

export function createApiServer(store: Store): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};

      // ---- 无状态局面接口 ----
      if (method === 'POST' && path === '/api/positions/validate') {
        const fen = needFen(body);
        let state;
        try {
          state = parseFen(fen);
        } catch (e) {
          if (e instanceof FenError) {
            send(res, 200, { ok: false, code: 'INVALID_FEN', issues: e.issues });
            return;
          }
          throw e;
        }
        const issues = validatePosition(state);
        send(res, 200, { ok: issues.length === 0, code: issues.length ? 'INVALID_POSITION' : 'OK', issues, fen: issues.length ? undefined : toFen(state) });
        return;
      }

      if (method === 'POST' && path === '/api/positions/legal-moves') {
        const state = parseAndValidate(needFen(body));
        const moves = legalMoves(state).map(moveToUci);
        send(res, 200, { fen: toFen(state), turn: state.turn, count: moves.length, moves });
        return;
      }

      if (method === 'POST' && path === '/api/positions/explain') {
        const state = parseAndValidate(needFen(body));
        const uci = typeof body.move === 'string' ? body.move : '';
        const move = parseUci(uci);
        if (!move) throw err(400, 'BAD_MOVE_FORMAT', `着法 '${uci}' 不是合法的 UCI 坐标格式`);
        send(res, 200, explainMove(state, move));
        return;
      }

      if (method === 'POST' && path === '/api/positions/apply') {
        const fen = needFen(body);
        const uci = typeof body.move === 'string' ? body.move : '';
        const result = tryApply(fen, uci);
        if (!result.ok) throw err(422, 'ILLEGAL_MOVE', result.reasons.join('; '), result.reasons);
        send(res, 200, { fen: result.fen, steps: result.explain.steps, status: statusOf(result.state) });
        return;
      }

      if (method === 'POST' && path === '/api/positions/status') {
        const state = parseAndValidate(needFen(body));
        send(res, 200, { fen: toFen(state), ...statusOf(state) });
        return;
      }

      // ---- 持久化对局接口 ----
      if (method === 'POST' && path === '/api/games') {
        const fen = typeof body.fen === 'string' && body.fen.trim() !== '' ? body.fen : INITIAL_FEN;
        const game = store.createGame(fen);
        send(res, 201, game);
        return;
      }

      const gameMatch = /^\/api\/games\/(\d+)(\/(moves|explain|status|history|replay|export))?$/.exec(path);
      if (gameMatch) {
        const id = Number(gameMatch[1]);
        const sub = gameMatch[3];

        if (method === 'GET' && !sub) {
          const game = store.getGame(id);
          send(res, 200, { ...game, ...statusOf(parseFen(game.current_fen)) });
          return;
        }
        if (method === 'GET' && sub === 'moves') {
          const game = store.getGame(id);
          const state = parseFen(game.current_fen);
          const moves = legalMoves(state).map(moveToUci);
          send(res, 200, { gameId: id, version: game.version, fen: game.current_fen, count: moves.length, moves });
          return;
        }
        if (method === 'POST' && sub === 'moves') {
          const uci = typeof body.move === 'string' ? body.move : '';
          if (uci === '') throw err(400, 'MISSING_MOVE', "请求体必须包含字符串字段 'move'（UCI，如 e2e4）");
          if (typeof body.version !== 'number' || !Number.isInteger(body.version)) {
            throw err(400, 'MISSING_VERSION', "请求体必须包含整数字段 'version'（当前对局版本，用于并发控制）");
          }
          const result = store.playMove(id, uci, body.version);
          send(res, 200, { game: result.game, move: result.move, steps: result.explanation });
          return;
        }
        if (method === 'GET' && sub === 'explain') {
          const game = store.getGame(id);
          const uci = url.searchParams.get('move') ?? '';
          const move = parseUci(uci);
          if (!move) throw err(400, 'BAD_MOVE_FORMAT', `查询参数 move='${uci}' 不是合法的 UCI 坐标格式`);
          send(res, 200, explainMove(parseFen(game.current_fen), move));
          return;
        }
        if (method === 'GET' && sub === 'status') {
          const game = store.getGame(id);
          const state = parseFen(game.current_fen);
          send(res, 200, { gameId: id, version: game.version, ...statusOf(state) });
          return;
        }
        if (method === 'GET' && sub === 'history') {
          send(res, 200, { gameId: id, moves: store.history(id) });
          return;
        }
        if (method === 'POST' && sub === 'replay') {
          send(res, 200, store.replay(id));
          return;
        }
        if (method === 'GET' && sub === 'export') {
          send(res, 200, store.exportGame(id));
          return;
        }
      }

      if (method === 'GET' && path === '/api/games') {
        send(res, 200, store.listGames());
        return;
      }

      throw err(404, 'NOT_FOUND', `${method} ${path} 不存在`);
    } catch (e) {
      if (e && typeof e === 'object' && 'status' in (e as object)) {
        sendErr(res, e as ApiError);
      } else if (e instanceof StoreError) {
        const status =
          e.code === 'NOT_FOUND' ? 404 :
          e.code === 'VERSION_CONFLICT' ? 409 :
          e.code === 'ILLEGAL_MOVE' || e.code === 'GAME_FINISHED' ? 422 : 400;
        sendErr(res, err(status, e.code, e.message, e.details));
      } else {
        sendErr(res, err(500, 'INTERNAL', (e as Error).message));
      }
    }
  });
  return server;
}

/** 启动服务；port 为 0 时由系统分配空闲端口（默认）。 */
export function startServer(store: Store, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolvePromise) => {
    const server = createApiServer(store);
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolvePromise({ server, port: actual });
    });
  });
}

