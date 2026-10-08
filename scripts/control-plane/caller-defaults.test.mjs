#!/usr/bin/env node
/**
 * caller.mjs 的「缺省不物化」回归（Gitea #126）。
 * ============================================================================
 *
 * 零依赖：只用 Node 内置的 `node:test` + `node:assert`（本仓 Node 22）。
 *   node scripts/control-plane/caller-defaults.test.mjs
 *
 * 为什么这批断言是「三态可区分」的判据：
 *
 *   1. **缺省**：未提供的选填参数**不得**出现在请求体里 ⇒ 服务端缺省逻辑生效。
 *      旧实现会在这里补上自述的 default，于是服务端永远看到「显式传了」；
 *   2. **显式值**：`false` / `0` 必须原样留在请求体里（旧实现的 bug 形态是任何 falsy 判断
 *      把 `false` 吞掉，等价于「没给」）；
 *   3. **显式 null / 空串**：同样必须原样保留。
 *
 * 形态取自 `capture.diag` 的真实自述（`dump` 有 default:false，`arm`/`reset` **没有** default，
 * 因为它们的缺省取决于调用形态）——旧调用器正是靠「物化 default」把这条语义架空的。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildBody } from './caller.mjs';

/** `capture.diag` 自述的参数形状（照实抄；`arm`/`reset` 无 default 是 #114 的落地结果）。 */
const CAPTURE_DIAG = {
  name: 'capture.diag',
  params: [
    { name: 'dump', type: 'boolean', required: false, default: false },
    { name: 'drainDump', type: 'boolean', required: false, default: false },
    { name: 'latestWindowOnly', type: 'boolean', required: false, default: false },
    { name: 'margin', type: 'int', required: false, default: 1 },
    { name: 'arm', type: 'boolean', required: false },
    { name: 'reset', type: 'boolean', required: false },
    { name: 'channel', type: 'string', required: false },
    { name: 'at', type: 'array', required: false },
  ],
};

/** 一个「default 声明齐全」的假动作，用来锁死「default 一律不代填」这条通用规则。 */
const ALL_DEFAULTS = {
  name: 'fake.defaults',
  params: [
    { name: 'flag', type: 'boolean', required: false, default: true },
    { name: 'count', type: 'int', required: false, default: 7 },
    { name: 'note', type: 'string', required: false, default: 'hello' },
    { name: 'must', type: 'string', required: true },
  ],
};

const OPTS = { allowUnknownParams: false };

// --------------------------------------------------------------------------- ① 缺省

test('缺省参数不写入请求体（服务端缺省逻辑生效，调用器不代填）', () => {
  // 三态里的第一态：调用方只给 dump —— arm/reset 必须**不在**请求体里
  const body = buildBody(CAPTURE_DIAG, { dump: true }, OPTS);
  assert.deepEqual(Object.keys(body), ['dump']);
  assert.equal('arm' in body, false, 'arm 缺省 ⇒ 不得写进请求体（否则「不动」被架空成「布防」）');
  assert.equal('reset' in body, false, 'reset 缺省 ⇒ 不得写进请求体');
  assert.equal('margin' in body, false, 'margin 有 default:1 ⇒ 也不得代填');
  assert.equal('drainDump' in body, false);
});

test('自述里带 default 的选填参数同样不代填（通用规则，不是逐动作特例）', () => {
  const body = buildBody(ALL_DEFAULTS, { must: 'x' }, OPTS);
  assert.deepEqual(Object.keys(body), ['must']);
  for (const p of ALL_DEFAULTS.params) {
    if (p.name === 'must') continue;
    assert.equal(p.name in body, false, `${p.name} 不得被代填 default=${JSON.stringify(p.default)}`);
  }
});

// --------------------------------------------------------------------------- ② 显式值

test('显式 false / 0 原样保留（不得被 falsy 判断吞掉）', () => {
  const body = buildBody(CAPTURE_DIAG, { dump: true, arm: false, reset: false, margin: 0 }, OPTS);
  assert.equal(body.arm, false, '显式 arm:false 必须保留且必须是布尔 false');
  assert.equal(body.reset, false);
  assert.equal(body.margin, 0, '显式 0 必须保留');
  assert.equal(body.dump, true);
  // 逐个键值比对整份请求体（防止「值对了但多了别的键」这种半对）
  assert.deepEqual(body, { dump: true, arm: false, reset: false, margin: 0 });
});

test('显式 true 与显式值优先于 default', () => {
  const body = buildBody(CAPTURE_DIAG, { dump: true, arm: true, margin: 3 }, OPTS);
  assert.equal(body.arm, true);
  assert.equal(body.margin, 3);
});

// --------------------------------------------------------------------------- ③ 显式 null / 空串

test('显式 null 与空串原样保留（不替换成 default、也不删除该键）', () => {
  const body = buildBody(CAPTURE_DIAG, { dump: true, arm: null, channel: '' }, OPTS);
  assert.equal('arm' in body, true, '显式 null 是「调用方给了一个 null」，键必须留在请求体里');
  assert.equal(body.arm, null);
  assert.equal('channel' in body, true);
  assert.equal(body.channel, '');
  // JSON 序列化后 null 必须真的是 null（服务端据此判定「键在、值为 null」）
  const wire = JSON.stringify(body);
  assert.equal(wire, '{"dump":true,"arm":null,"channel":""}');
});

test('JSON 往返不改变三态（请求体字节层面可复核）', () => {
  const body = buildBody(CAPTURE_DIAG, { dump: true, arm: false, reset: null }, OPTS);
  const round = JSON.parse(JSON.stringify(body));
  assert.deepEqual(round, { dump: true, arm: false, reset: null });
  assert.equal('margin' in round, false, '往返后仍不得凭空出现 default');
});

// --------------------------------------------------------------------------- 其它既有行为不得回退

test('缺必填参数仍报错（不因「不代填」而静默放行）', () => {
  assert.throws(() => buildBody(ALL_DEFAULTS, {}, OPTS), /缺少必填参数 must/);
});

test('自描述未声明的参数仍报错（除非显式放行）', () => {
  assert.throws(() => buildBody(CAPTURE_DIAG, { dump: true, nope: 1 }, OPTS), /参数未在自描述中声明: nope/);
  const allowed = buildBody(CAPTURE_DIAG, { dump: true, nope: 1 }, { allowUnknownParams: true });
  assert.equal(allowed.nope, 1, '显式放行时直传');
});

test('confirm 不是动作参数，不参与未声明判定', () => {
  const body = buildBody(CAPTURE_DIAG, { dump: true, confirm: true }, OPTS);
  assert.equal(body.confirm, true);
});
