import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryApply } from '../src/game.js';

test('吃车与动车后易位权利消失', () => {
  // 黑车 a2 吃 a1 白车：白方长易位权利 Q 消失，K 保留
  const cap = tryApply('4k3/8/8/8/8/8/r7/R3K2R b KQ - 0 1', 'a2a1');
  assert.ok(cap.ok);
  assert.equal(cap.fen.split(' ')[2], 'K');

  // 白车 h1 移动：K 权利消失，Q 保留
  const rookMove = tryApply('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'h1h2');
  assert.ok(rookMove.ok);
  assert.equal(rookMove.fen.split(' ')[2], 'Q');

  // 白王移动：KQ 全部消失（黑方 kq 不受影响）
  const kingMove = tryApply('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1e2');
  assert.ok(kingMove.ok);
  assert.equal(kingMove.fen.split(' ')[2], 'kq');

  // 短易位后白方权利全部消失
  const castle = tryApply('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1');
  assert.ok(castle.ok);
  assert.equal(castle.fen.split(' ')[2], 'kq');
});
