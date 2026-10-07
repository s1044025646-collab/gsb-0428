import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StoreError } from '../src/store.js';
import { INITIAL_FEN } from '../src/types.js';

function memStore(): Store {
  return new Store(':memory:');
}

test('导入、落子、历史与重放一致', () => {
  const s = memStore();
  const g = s.createGame();
  assert.equal(g.current_fen, INITIAL_FEN);
  assert.equal(g.version, 0);

  const r1 = s.playMove(g.id, 'e2e4', 0);
  assert.equal(r1.game.version, 1);
  assert.equal(r1.game.current_fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');

  const r2 = s.playMove(g.id, 'c7c5', 1);
  assert.equal(r2.game.version, 2);

  const hist = s.history(g.id);
  assert.deepEqual(hist.map((m) => m.uci), ['e2e4', 'c7c5']);

  const replay = s.replay(g.id);
  assert.equal(replay.ok, true);
  assert.equal(replay.plies, 2);
  assert.equal(replay.finalFen, r2.game.current_fen);

  const exp = s.exportGame(g.id);
  assert.deepEqual(exp.moves, ['e2e4', 'c7c5']);
  s.close();
});

test('非法走子不改变局面、不写库', () => {
  const s = memStore();
  const g = s.createGame();
  assert.throws(() => s.playMove(g.id, 'e2e5', 0), (e: unknown) => e instanceof StoreError && (e as StoreError).code === 'ILLEGAL_MOVE');
  const after = s.getGame(g.id);
  assert.equal(after.version, 0);
  assert.equal(after.current_fen, INITIAL_FEN);
  assert.equal(s.history(g.id).length, 0);
  s.close();
});

test('版本冲突拒绝并发落子', () => {
  const s = memStore();
  const g = s.createGame();
  s.playMove(g.id, 'e2e4', 0);
  // 两个请求都拿着 version=1，第二个必须失败
  s.playMove(g.id, 'c7c5', 1);
  assert.throws(() => s.playMove(g.id, 'e7e5', 1), (e: unknown) => e instanceof StoreError && (e as StoreError).code === 'VERSION_CONFLICT');
  assert.equal(s.history(g.id).length, 2);
  s.close();
});

test('导入非法 FEN 与不一致局面被拒绝', () => {
  const s = memStore();
  assert.throws(() => s.createGame('not a fen'), (e: unknown) => e instanceof StoreError && (e as StoreError).code === 'INVALID_FEN');
  assert.throws(() => s.createGame('8/8/8/8/8/4k3/4K3/8 w - - 0 1'), (e: unknown) => e instanceof StoreError && (e as StoreError).code === 'INVALID_POSITION');
  s.close();
});

test('将死后对局关闭，不能再落子', () => {
  const s = memStore();
  const g = s.createGame();
  s.playMove(g.id, 'f2f3', 0);
  s.playMove(g.id, 'e7e5', 1);
  s.playMove(g.id, 'g2g4', 2);
  const m = s.playMove(g.id, 'd8h4', 3);
  assert.equal(m.game.status, 'checkmate');
  assert.throws(() => s.playMove(g.id, 'a2a3', 4), (e: unknown) => e instanceof StoreError && (e as StoreError).code === 'GAME_FINISHED');
  const replay = s.replay(g.id);
  assert.equal(replay.ok, true);
  s.close();
});

test('重启后（新连接）按原链核验', async () => {
  const path = `data/test-restart-${Date.now()}.db`;
  let s = new Store(path);
  const g = s.createGame();
  s.playMove(g.id, 'e2e4', 0);
  s.playMove(g.id, 'e7e5', 1);
  s.close();
  s = new Store(path);
  const replay = s.replay(g.id);
  assert.equal(replay.ok, true);
  assert.equal(replay.plies, 2);
  s.close();
  const { rmSync } = await import('node:fs');
  rmSync(path, { force: true });
  rmSync(path + '-wal', { force: true });
  rmSync(path + '-shm', { force: true });
});


