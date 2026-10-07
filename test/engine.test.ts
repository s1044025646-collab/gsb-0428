import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFen, toFen } from '../src/fen.js';
import { legalMoves, perft } from '../src/movegen.js';
import { explainMove, moveToUci, parseUci, statusOf, tryApply, validatePosition } from '../src/game.js';
import { INITIAL_FEN } from '../src/types.js';

const uciList = (fen: string) => legalMoves(parseFen(fen)).map(moveToUci);

test('FEN 往返：初始局面与含易位/过路兵局面', () => {
  assert.equal(toFen(parseFen(INITIAL_FEN)), INITIAL_FEN);
  const fen = 'r3k2r/pp1ppppp/8/2pP4/8/8/PPP1PPPP/R3K2R w KQkq c6 0 3';
  assert.equal(toFen(parseFen(fen)), fen);
});

test('FEN 字段校验：行数、格数、非法棋子、行棋方、易位、过路格', () => {
  assert.throws(() => parseFen('8/8/8/8/8/8/8 w - - 0 1'), /8 行/);
  assert.throws(() => parseFen('9/8/8/8/8/8/8/K6k w - - 0 1'), /格数/);
  assert.throws(() => parseFen('x7/8/8/8/8/8/8/K6k w - - 0 1'), /非法字符/);
  assert.throws(() => parseFen('8/8/8/8/8/8/8/K6k x - - 0 1'), /行棋方/);
  assert.throws(() => parseFen('8/8/8/8/8/8/8/K6k w KK - 0 1'), /易位权利/);
  assert.throws(() => parseFen('8/8/8/8/8/8/8/K6k w - e4 0 1'), /过路兵/);
});

test('一致性规则：双王、兵在首末行、王相邻、易位权利需王车在位', () => {
  assert.ok(validatePosition(parseFen('8/8/8/8/8/8/8/K6k w - - 0 1')).length === 0);
  assert.ok(validatePosition(parseFen('8/8/8/8/8/8/8/K6K w - - 0 1')).some((s) => s.includes('黑王')));
  assert.ok(validatePosition(parseFen('P6k/8/8/8/8/8/8/K7 w - - 0 1')).some((s) => s.includes('第 8 横排')));
  assert.ok(validatePosition(parseFen('8/8/8/8/8/4k3/4K3/8 w - - 0 1')).some((s) => s.includes('相邻')));
  assert.ok(validatePosition(parseFen('4k3/8/8/8/8/8/8/4K3 w K - 0 1')).some((s) => s.includes('易位权利 K')));
  assert.ok(validatePosition(parseFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1')).length === 0);
  assert.ok(validatePosition(parseFen('4k3/8/8/8/8/8/8/4K2R w Q - 0 1')).some((s) => s.includes('易位权利 Q')));
});

test('perft：初始局面第一层 20，第二层 400，第三层 8902', () => {
  const s = parseFen(INITIAL_FEN);
  assert.equal(perft(s, 1), 20);
  assert.equal(perft(s, 2), 400);
  assert.equal(perft(s, 3), 8902);
});

test('着法输出顺序固定（起点格 a1→h8，再终点格，升变 q,r,b,n）', () => {
  assert.deepEqual(uciList(INITIAL_FEN), [
    'b1a3', 'b1c3', 'g1f3', 'g1h3',
    'a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3', 'c2c4', 'd2d3', 'd2d4',
    'e2e3', 'e2e4', 'f2f3', 'f2f4', 'g2g3', 'g2g4', 'h2h3', 'h2h4',
  ]);
});

test('易位：正常、穿越受攻击格被拒绝、无权利被拒绝', () => {
  const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
  const moves = uciList(fen);
  assert.ok(moves.includes('e1g1') && moves.includes('e1c1'));
  // f1 被黑车攻击（f 线无兵阻挡）：短易位非法，长易位仍合法
  const attacked = 'r3k2r/pppp1ppp/8/8/8/5r2/PPPPP1PP/R3K2R w KQkq - 0 1';
  const m2 = uciList(attacked);
  assert.ok(!m2.includes('e1g1'));
  assert.ok(m2.includes('e1c1'));
  // 王正被将军不能易位
  const inCheckFen = 'r3k2r/pppppppp/8/8/4r3/8/PPPP1PPP/R3K2R w KQkq - 0 1';
  const m3 = uciList(inCheckFen);
  assert.ok(!m3.includes('e1g1') && !m3.includes('e1c1'));
  // 无权利
  const noRight = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w - - 0 1';
  const m4 = uciList(noRight);
  assert.ok(!m4.includes('e1g1') && !m4.includes('e1c1'));
  // 易位同时移动王与车，并清除权利
  const r = tryApply(fen, 'e1g1');
  assert.ok(r.ok);
  assert.equal(r.fen, 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R4RK1 b kq - 1 1');
});

test('吃过路兵：仅本轮有效；暴露己王的吃过路兵被拒绝', () => {
  const fen = '4k3/8/8/2KPp2r/8/8/8/8 w - e6 0 1';
  // d5xe6 e.p. 会打开 h5 车对 c5 王的横线 → 非法
  const ex = explainMove(parseFen(fen), parseUci('d5e6')!);
  assert.equal(ex.legal, false);
  assert.ok(ex.reasons.join().includes('攻击'));
  // 正常吃过路兵
  const okFen = '4k3/8/8/3Pp3/8/8/8/4K3 w - e6 0 1';
  const r = tryApply(okFen, 'd5e6');
  assert.ok(r.ok);
  assert.equal(r.fen, '4k3/8/4P3/8/8/8/8/4K3 b - - 0 1');
  // 过路兵机会仅本轮：走别的着法后 ep 消失
  const r2 = tryApply('4k3/8/8/3Pp3/8/8/8/4K2R w K e6 0 1', 'h1h2');
  assert.ok(r2.ok);
  assert.equal(r2.fen.split(' ')[3], '-');
});

test('升变：四种升变均合法，不指定升变被拒绝', () => {
  const fen = '8/P7/8/8/8/8/8/k6K w - - 0 1';
  const moves = uciList(fen).filter((m) => m.startsWith('a7'));
  assert.deepEqual(moves, ['a7a8q', 'a7a8r', 'a7a8b', 'a7a8n']);
  const ex = explainMove(parseFen(fen), parseUci('a7a8')!);
  assert.equal(ex.legal, false);
  assert.ok(ex.reasons.join().includes('升变'));
  const r = tryApply(fen, 'a7a8n');
  assert.ok(r.ok);
  assert.equal(r.fen.split(' ')[0], 'N7/8/8/8/8/8/8/k6K');
});

test('被钉住的子：不能走，但仍参与攻击判定（王不能走入其攻击格）', () => {
  // 白车 c1 将黑马 c3 钉在 c 线（黑王 c7）；马仍攻击 a2/b1
  const fen = '8/2k5/8/8/8/2n5/8/K1r5 w - - 0 1';
  const moves = uciList(fen);
  assert.ok(!moves.includes('a1b1'), 'b1 被被钉住的马攻击');
  assert.ok(!moves.includes('a1a2'), 'a2 被被钉住的马攻击');
  assert.ok(moves.includes('a1b2'));
  // 白方被钉住的马不能走
  const pin = '4k3/8/8/8/4r3/8/4N3/4K3 w - - 0 1';
  assert.ok(!uciList(pin).some((m) => m.startsWith('e2')));
});

test('双将：只有动王能解，挡一子不够', () => {
  const fen = '4k3/8/8/8/1b6/5n2/8/3RK3 w - - 0 1';
  const moves = uciList(fen);
  assert.ok(!moves.includes('d1d2'), '挡住象但马仍将军');
  assert.ok(moves.includes('e1f1'));
  assert.ok(moves.every((m) => m.startsWith('e1')), '双将时只有王能动');
});

test('将死与逼和', () => {
  const mate = statusOf(parseFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'));
  assert.equal(mate.inCheck, true);
  assert.equal(mate.checkmate, true);
  assert.equal(mate.stalemate, false);
  const stale = statusOf(parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'));
  assert.equal(stale.inCheck, false);
  assert.equal(stale.checkmate, false);
  assert.equal(stale.stalemate, true);
});

test('王不能相邻走入对方王攻击格', () => {
  const fen = '8/8/8/8/8/4k3/8/4K3 w - - 0 1';
  const moves = uciList(fen);
  assert.ok(!moves.includes('e1e2') && !moves.includes('e1d2') && !moves.includes('e1f2'));
  assert.ok(moves.includes('e1d1') && moves.includes('e1f1'));
});

test('不能吃掉对方王', () => {
  const fen = '8/8/8/8/8/8/4k3/4K3 w - - 0 1';
  const ex = explainMove(parseFen(fen), parseUci('e1e2')!);
  assert.equal(ex.legal, false);
  assert.ok(ex.reasons.join().includes('王'));
});

test('半回合计数与回合编号', () => {
  const r1 = tryApply(INITIAL_FEN, 'g1f3');
  assert.ok(r1.ok);
  assert.equal(r1.fen.split(' ')[4], '1'); // 非兵非吃子 +1
  const r2 = tryApply(r1.fen, 'g8f6');
  assert.ok(r2.ok);
  assert.equal(r2.fen.split(' ')[5], '2'); // 黑方走后回合 +1
  const r3 = tryApply(INITIAL_FEN, 'e2e4');
  assert.ok(r3.ok);
  assert.equal(r3.fen.split(' ')[4], '0'); // 兵移动重置
});



