import { parseFen, toFen, FenError } from './fen.js';
import { legalMoves, perft } from './movegen.js';
import { explainMove, moveToUci, parseUci, statusOf, tryApply, validatePosition } from './game.js';
import { Store, StoreError, defaultDbPath } from './store.js';
import { startServer } from './api.js';
import { INITIAL_FEN } from './types.js';

const USAGE = `国际象棋合法走子后端 CLI

用法: node dist/cli.js <命令> [参数]

无状态局面命令（FEN 需用引号包裹）:
  validate <fen>            校验 FEN 与局面一致性
  legal <fen>               列出全部合法着法（UCI，固定顺序）
  explain <fen> <uci>       解释一步候选着法（合法给出逐项说明，非法给出原因）
  apply <fen> <uci>         执行着法并输出新 FEN
  status <fen>              查询将军/将死/逼和状态
  perft [depth] [fen]       叶子计数（默认 depth=2 初始局面，仅供规则测试）

持久化对局命令（SQLite，数据目录 ./data，可用 CHESS_DB 覆盖）:
  new [fen]                 导入局面创建对局（默认初始局面）
  games                     列出全部对局
  show <id>                 查看对局当前局面与状态
  moves <id>                列出当前合法着法
  play <id> <uci> [ver]     落子（需带版本号，缺省自动读取当前版本）
  history <id>              查看着法链
  replay <id>               从初始 FEN 按已保存着法链重放并核验
  export <id>               导出初始 FEN + 着法链

服务与演示:
  serve [--port N]          启动 HTTP API（默认端口 0 = 自动选择空闲端口）
  demo                      演示正常着法、王安全拒绝与特殊走子
`;

function out(x: unknown): void {
  console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
}

function fail(code: string, message: string, details?: unknown): never {
  out({ error: { code, message, details } });
  process.exitCode = 1;
  throw new ExitError();
}

class ExitError extends Error {}

function parseFenOrFail(fen: string) {
  try {
    const state = parseFen(fen);
    const issues = validatePosition(state);
    if (issues.length > 0) fail('INVALID_POSITION', '局面不满足一致性规则: ' + issues.join('; '), issues);
    return state;
  } catch (e) {
    if (e instanceof FenError) fail('INVALID_FEN', e.message, e.issues);
    throw e;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return;

    case 'validate': {
      const fen = args[1];
      if (!fen) fail('MISSING_ARG', '缺少 FEN 参数');
      try {
        const state = parseFen(fen);
        const issues = validatePosition(state);
        out({ ok: issues.length === 0, issues, fen: issues.length ? undefined : toFen(state) });
      } catch (e) {
        if (e instanceof FenError) out({ ok: false, issues: e.issues });
        else throw e;
      }
      return;
    }

    case 'legal': {
      const state = parseFenOrFail(args[1] ?? '');
      const moves = legalMoves(state).map(moveToUci);
      out({ fen: toFen(state), turn: state.turn, count: moves.length, moves });
      return;
    }

    case 'explain': {
      const state = parseFenOrFail(args[1] ?? '');
      const move = parseUci(args[2] ?? '');
      if (!move) fail('BAD_MOVE_FORMAT', `着法 '${args[2]}' 不是合法的 UCI 坐标格式`);
      out(explainMove(state, move));
      return;
    }

    case 'apply': {
      const result = tryApply(args[1] ?? '', args[2] ?? '');
      if (!result.ok) fail('ILLEGAL_MOVE', result.reasons.join('; '), result.reasons);
      out({ fen: result.fen, steps: result.explain.steps, status: statusOf(result.state) });
      return;
    }

    case 'status': {
      const state = parseFenOrFail(args[1] ?? '');
      out({ fen: toFen(state), ...statusOf(state) });
      return;
    }

    case 'perft': {
      const depth = args[1] ? Number(args[1]) : 2;
      if (!Number.isInteger(depth) || depth < 0 || depth > 6) fail('BAD_ARG', 'depth 必须是 0..6 的整数');
      const state = parseFenOrFail(args[2] ?? INITIAL_FEN);
      const t0 = Date.now();
      const nodes = perft(state, depth);
      out({ depth, nodes, ms: Date.now() - t0 });
      return;
    }

    case 'serve': {
      let port = process.env.PORT ? Number(process.env.PORT) : 0;
      const pi = args.indexOf('--port');
      if (pi >= 0 && args[pi + 1]) port = Number(args[pi + 1]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('BAD_ARG', '端口必须是 0..65535 的整数（0 表示自动选择空闲端口）');
      const store = new Store(defaultDbPath());
      const { port: actual } = await startServer(store, port);
      console.log(`API 服务已启动: http://127.0.0.1:${actual}  (数据库: ${defaultDbPath()})`);
      return;
    }

    case 'new': {
      const store = new Store(defaultDbPath());
      try {
        out(store.createGame(args[1]));
      } catch (e) {
        if (e instanceof StoreError) fail(e.code, e.message, e.details);
        throw e;
      } finally {
        store.close();
      }
      return;
    }

    case 'games': {
      const store = new Store(defaultDbPath());
      out(store.listGames());
      store.close();
      return;
    }

    case 'show': {
      const store = new Store(defaultDbPath());
      const game = store.getGame(Number(args[1]));
      out({ ...game, ...statusOf(parseFen(game.current_fen)) });
      store.close();
      return;
    }

    case 'moves': {
      const store = new Store(defaultDbPath());
      const game = store.getGame(Number(args[1]));
      const state = parseFen(game.current_fen);
      const moves = legalMoves(state).map(moveToUci);
      out({ gameId: game.id, version: game.version, count: moves.length, moves });
      store.close();
      return;
    }

    case 'play': {
      const store = new Store(defaultDbPath());
      try {
        const id = Number(args[1]);
        const uci = args[2] ?? '';
        const version = args[3] !== undefined ? Number(args[3]) : store.getGame(id).version;
        const result = store.playMove(id, uci, version);
        out({ game: result.game, move: result.move, steps: result.explanation });
      } catch (e) {
        if (e instanceof StoreError) fail(e.code, e.message, e.details);
        throw e;
      } finally {
        store.close();
      }
      return;
    }

    case 'history': {
      const store = new Store(defaultDbPath());
      out(store.history(Number(args[1])));
      store.close();
      return;
    }

    case 'replay': {
      const store = new Store(defaultDbPath());
      out(store.replay(Number(args[1])));
      store.close();
      return;
    }

    case 'export': {
      const store = new Store(defaultDbPath());
      out(store.exportGame(Number(args[1])));
      store.close();
      return;
    }

    case 'demo': {
      runDemo();
      return;
    }

    default:
      console.log(USAGE);
      fail('UNKNOWN_COMMAND', `未知命令 '${cmd}'`);
  }
}

function runDemo(): void {
  console.log('=== 演示 1：正常着法（初始局面 e2e4） ===');
  let r = tryApply(INITIAL_FEN, 'e2e4');
  if (r.ok) {
    console.log('变更前 FEN:', INITIAL_FEN);
    console.log('变更后 FEN:', r.fen);
    console.log('逐项解释:');
    for (const s of r.explain.steps) console.log('  -', s);
  }

  console.log();
  console.log('=== 演示 2：因王安全被拒绝（被钉住的马不能走） ===');
  const pinFen = '4k3/8/8/8/4r3/8/4N3/4K3 w - - 0 1';
  const ex = explainMove(parseFen(pinFen), parseUci('e2g3')!);
  console.log('局面 FEN:', pinFen, '（e2 马被 e4 黑车钉在 e 线）');
  console.log('尝试着法: e2g3');
  console.log('结果: 拒绝');
  for (const s of ex.reasons) console.log('  原因:', s);

  console.log();
  console.log('=== 演示 3：特殊走子（白方短易位 e1g1） ===');
  const castleFen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  r = tryApply(castleFen, 'e1g1');
  if (r.ok) {
    console.log('变更前 FEN:', castleFen);
    console.log('变更后 FEN:', r.fen);
    console.log('逐项解释:');
    for (const s of r.explain.steps) console.log('  -', s);
  }
}

main().catch((e) => {
  if (e instanceof ExitError) return;
  if (e instanceof StoreError) {
    out({ error: { code: e.code, message: e.message, details: e.details } });
    process.exitCode = 1;
    return;
  }
  console.error(e);
  process.exitCode = 1;
});
