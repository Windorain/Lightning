#!/usr/bin/env node
/**
 * compare-runs.mjs —— 控制面 run 产物的比对器（A3「可重放口径」的可执行形态）
 * ============================================================================
 *
 * 口径来源：`docs/control-plane/case-file.md §10`（产物比较模式 + 豁免字段表）。
 * 本脚本是那条口径的**唯一实现点**——A3 验收（两次 run 产物结构一致）与
 * `test/expected/` 的基准比对都走它，不存在第二套比对逻辑。
 *
 * 设计约束（不可放宽）：
 *
 *   1. **模式逐产物声明**，不是全局放宽。「这次为什么只比在场」必须在
 *      `test/expected/<caseId>/manifest.json` 里有落点，从而可审。
 *   2. **豁免字段表逐条可指契约出处**（case-file.md §10.2）。本脚本里的
 *      `EXEMPT_FIELDS` 与那张表**同源**：新增豁免必须同时改文档与这里，
 *      否则「豁免」会变成「跑不过就放宽」。
 *   3. **证伪必须变红**：`--selftest` 用合成夹具证明「改坏必红、好数据必绿」
 *      （同 `run-anchor-selftest.ps1` / `falsification.mjs` 的定位）。
 *      只证明该绿是不够的——恒绿是比对器最常见的失效模式。
 *   4. **退出码与 core.shutdown 同一约定**：0=全一致 / 2=有差异 / 3=设施错误。
 *      外层无人值守脚本因此可以一条规则处理两件事。
 *
 * 用法：
 *   node compare-runs.mjs --a <runDirA> --b <runDirB> [options]
 *   node compare-runs.mjs --run <runDir> --baseline <manifest.json> [options]
 *   node compare-runs.mjs --selftest
 *
 * 选项：
 *   --json-out <path>   把机读结论另存一份
 *   --quiet             只输出结论行（人读表省略）
 *   --help
 *
 * 零依赖：只用 Node 内置模块（Node 18+ 的全局 fetch 用不到；本仓 Node 22）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const EXIT_OK = 0;
const EXIT_DIFF = 2;
const EXIT_FACILITY = 3;

// --------------------------------------------------------------------------- 比较模式

/** 四种比较模式（case-file.md §10.1）。 */
const MODES = ['byte-equal', 'canonical-hash-equal', 'structural-equal', 'presence-only'];

/**
 * 豁免字段表（case-file.md §10.2）。
 *
 * 键是字段名，值是豁免理由（**必须能指到契约条款或已实测的机理**）。
 * 表与文档同源：改这里必须同时改 §10.2，反之亦然。
 *
 * <h3>为什么分「全局名」与「路径」两类</h3>
 * 全局名豁免的是**位置无关**的机械量（时间戳、进程内计数器）——它们在任何位置出现都不可比。
 * 路径豁免的是**局部**的派生量（如 `artifacts[].sha256`：它随产物变化，而产物本身若已豁免，
 * 它的哈希也豁免）。把后者写成全局名会**过度豁免**：`world/scene-manifest.json` 的 `sha256`
 * 恰恰是要比的那个值。A3 实机复跑当场照出了这个差别（第一版实现把 `sha256` 写成全局名）。
 */
const EXEMPT_FIELDS = {
  // —— 时间：挂钟时间，逐次不同（契约出处 case-file.md §8 第 4 条 / observation-record.md §2）
  createdAt: '挂钟时间（manifest.json / observation.json）',
  generatedAt: '挂钟时间（criteria.json / evidence.json）',
  recordedAt: '挂钟时间（segments/*.json）',
  readAt: '挂钟时间（read/*.json）',
  regeneratedAt: '挂钟时间（按段续跑重新产出的清单）',
  durationMs: '耗时（segments/*.json）',
  // 等待/同步耗时：度量的是「等了多久」，不是「世界是什么样」。
  // 它们是**有界**的（awaitServerSync 上界 500ms）且必然随机器负载浮动，因此不可能逐值复现。
  // 注意这与「耗时」不是同一件事：durationMs 是整段耗时，这两个是同步点耗时——
  // 但它们的豁免理由相同（都是时间度量），因此共用一条口径。
  settleMs: '编排段的步骤间收敛等待毫秒（action 段；上界由 PlayerSession 的 500ms 超时保证）',
  serverSyncWaitedMs: '服务端同步等待毫秒（L1 动作回读前的收尾等待，同一上界）',
  // —— 进程内标识：单调计数器，逐次不同
  runId: 'run 目录名含时间戳（case-file.md §8 第 4 条），天然每次不同',
  jobId: '作业号 j<seq>，JobRegistry 的 ++lastSeq 进程内单调递增；与 jobSeq 同源',
  jobSeq: '作业序号，进程内单调递增（manifest.json）',
  entityId: '实体 id 由服务端实体计数器分配，跨会话必然不同（read.player / read.overview）',
  ping: '网络往返毫秒（read.player），随机器负载浮动',
  // —— 世界实时状态：随 tick 变化的时钟与调度器内部值
  worldTime: '实时状态（世界时钟，World.getWorldTime）',
  totalWorldTime: '实时状态（世界总时钟，随 tick 递增）',
  timeOfDay: '实时状态（当日时刻，由 totalWorldTime 派生）',
  day: '实时状态（第几天，由 totalWorldTime 派生）',
  rainTime: '天气倒计时：1.7.10 天气由倒计时驱动（WeatherTimeAction 的注释），其值是世界的调度器内部状态而非声明输入',
  thunderTime: '同上（雷暴倒计时）',
  playerPos: '实时状态（玩家位置：进图稳定化 + 微调）',
  sinceEnterMs: '实时状态（进图时间）',
  totalTime: '实时状态',
  // —— 绝对路径：含 <mcDataDir> 前缀，跨机器不同
  runDir: '含 <mcDataDir> 绝对前缀',
  runsRoot: '含 <mcDataDir> 绝对前缀',
  markerPath: '含 <mcDataDir> 绝对前缀（read.overview / world 段）',
  root: '快照根绝对路径（world.snapshot 结果）',
};

// ─────────────────────────────────────────────────────────────────────────────
// **刻意不豁免**（早期豁免方案曾列入，A3 实机复跑证明它们可复现 ⇒ 不豁免）
//
//   mismatches  早期理由「是留痕不是期望值」——那是**语义**说明，不是非确定性证明。
//               A3 两轮实测：两次 run 的 mismatches 逐字相同。豁免它会让 A3 对
//               「同一程序两轮产出不同数量的 mismatch」这类真实漂移失明。
//   teReads     早期理由「契约明写不进清单哈希」——那是**哈希口径**，不是值不可比。
//               若将来某个 TE 描述器输出里含非确定运行期值，再**按路径**豁免并附该证据。
//   sha256      早期方案把 sha256/bytes 列为全局豁免字段——过度豁免：
//               world/scene-manifest.json 的 sha256 恰恰是 `hash-equal` 要比的核心值。
//               现改为**按路径**豁免（见 EXEMPT_PATHS：只豁免 artifacts[]/runtimeReads[] 里的）。
//
// 这条记录本身是资产的一部分：豁免表的最小化过程可被复核（见 test/criteria/README.md §6）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 路径作用域豁免（glob 形态，`*` 匹配一段、`**` 匹配任意段）。
 *
 * 每条都必须能指到「为什么这个位置的这个量不可比」——与 §10.2 的表同源。
 */
const EXEMPT_PATHS = [
  {
    glob: '**/artifacts/*/sha256',
    reason: '产物哈希随产物变化；产物本身若已豁免（如 manifest.json 的 bytes），其哈希也随之豁免（case-file.md §10.2）',
  },
  {
    glob: '**/artifacts/*/bytes',
    reason: '同上（字节数随豁免内容变化）',
  },
  {
    glob: '**/steps/*/artifact/sha256',
    reason:
      'read/action 段的逐步记录里嵌的「该步产物哈希」——与 artifacts[] 同一性质：'
      + '它指向的产物本身由**它自己的比较模式**判（如 read/*.json 走 canonical-hash-equal），'
      + '在段记录里再比一次等于把同一个量比两遍，而其中一遍带的是「本 run 的字节形态」',
  },
  {
    glob: '**/steps/*/artifact/bytes',
    reason: '同上（字节数随豁免内容变化）',
  },
  {
    glob: '**/runtimeReads/*/sha256',
    reason: 'runtimeReads 的哈希对摘要对象的规范化 JSON 计算（observation-record.md §2 第 1 条）；被摘要的 run 元数据含 runId/jobSeq',
  },
  {
    glob: '**/chunks/loaded',
    reason:
      '已加载区块计数（read.overview）：它随世界加载进度与玩家位置浮动（实测两轮 1349 vs 1373），'
      + '是实时状态而不是本 run 的声明输入。**按路径豁免**而不是按字段名 `loaded`——'
      + '同名字段在 `world.loaded` 里是布尔「世界加载了没」，那个必须比。',
  },
  {
    glob: '**/chunks/chunks',
    reason: '同上：chunk 明细列表（默认 `listed:0` 时不输出内容，输出时其条目数同样随加载进度浮动）',
  },
];

/**
 * 人读解释文字字段：**内容不参与值比较，但仍参与结构比较**（键在不在、是不是字符串）。
 *
 * <h3>为什么这是一条通则而不是逐个补丁</h3>
 * 这些字段按设计会**引用 runId / 字节数 / 路径**（观测记录的 `summary` 就是给离线解释用的，
 * 判据结论的 `detail` 会写「产物存在: read/run.json (3554 字节)」）。它们的作用是解释，
 * 不是断言：真正的断言是与之并列的 `verdict` / `status` / `sha256`。
 * 把它们纳入值比较，等于要求「人读文字也必须逐字相同」——那与它们的存在目的直接冲突。
 *
 * <p>
 * 之所以仍保留**结构**比较：`detail` 从对象变成字符串、或消失，都是形态变化，必须红。
 */
const PROSE_FIELDS = new Set([
  'summary',
  'detail',
  'note',
  'pathNote',
  'layerNote',
  'hashScope',
  'scope',
  'ordering',
  'message',
  'reason',
  'notObservedReason',
]);

/**
 * 逐产物的**比较投影**：先投影、再归一。
 *
 * 投影的目的不是「放宽」，而是**把口径写清**：例如 `criteria.json` 要回答的是
 * 「判据结论集是否逐条一致」——那就只比 `{id,type,verdict}`，而不是比人读 detail。
 */
const PROJECTIONS = [
  {
    glob: 'criteria.json',
    reason: 'case-file.md §10.3：只比 {overall, counts, criteria[].{id,type,verdict}}，detail 是人读文字',
    project(doc) {
      if (!doc || typeof doc !== 'object' || !Array.isArray(doc.criteria)) return doc;
      return {
        schema: doc.schema,
        overall: doc.overall,
        counts: doc.counts,
        criteria: doc.criteria.map((c) => ({
          id: c && c.id,
          type: c && c.type,
          verdict: c && c.verdict,
        })),
      };
    },
  },
  {
    glob: 'evidence.json',
    reason: 'case-file.md §10.3：只比 {overall, verdict}——期望证据清单本身逐条比在场由判据集判',
    project(doc) {
      if (!doc || typeof doc !== 'object') return doc;
      return {
        schema: doc.schema,
        overall: doc.overall,
        verdict: doc.verdict,
      };
    },
  },
];

/**
 * 产物 → 比较模式的默认表（case-file.md §10.3）。
 *
 * 未列出的产物按 `structural-equal`（最保守的「结构一致」），因为那正是 A3 的字面要求。
 */
const DEFAULT_MODES = [
  [/^world\/scene-manifest\.json$/, 'canonical-hash-equal'],
  [/^criteria\.json$/, 'canonical-hash-equal'],
  [/^evidence\.json$/, 'canonical-hash-equal'],
  [/^observation\.json$/, 'structural-equal'],
  [/^segments\/.*\.json$/, 'structural-equal'],
  // 自引用产物：read.run 枚举**整个 runs/ 目录**，因此必然包含本 run 自己，
  // 且条目数随 run 数增长——它不是「同参同产物」，不能参与值比较（见 case-file.md §10.5）。
  // **必须排在 `^(read|action)/.*\.json$` 之前**（本表先匹配先胜；自检当场照出的次序缺陷）。
  [/^read\/run\.json$/, 'presence-only'],
  [/^(read|action)\/.*\.json$/, 'canonical-hash-equal'],
  [/^shots\/.*\.png$/, 'presence-only'],
  [/^shots\/.*\.tiles\/.*\.png$/, 'presence-only'],
  [/^logs\//, 'presence-only'],
  [/\.png$/, 'presence-only'],
];

/** 取一个产物的默认比较模式。 */
function defaultMode(relPath) {
  const p = relPath.replace(/\\/g, '/');
  for (const [re, mode] of DEFAULT_MODES) {
    if (re.test(p)) return mode;
  }
  return 'structural-equal';
}

/** 取一个产物的投影函数（未声明则恒等）。 */
function projectionFor(relPath) {
  const p = relPath.replace(/\\/g, '/');
  for (const proj of PROJECTIONS) {
    if (globMatch(proj.glob, p)) return proj;
  }
  return null;
}

/**
 * 极简 glob：`**` 匹配任意段（含**零**段）、`*` 匹配一段内的任意字符。
 *
 * 手写而不是用库：本脚本零依赖（同 `caller.mjs`）。**零段**这一条是必须的——
 * `**\/artifacts\/*\/bytes` 要能匹配根层的 `artifacts/0/bytes`（自检当场照出的缺陷：
 * 第一版要求 `**` 至少吃一段，于是根层的豁免路径全部不生效）。
 */
function globMatch(glob, path) {
  const g = glob.replace(/\\/g, '/');
  const parts = g.split('/');
  const segs = path.split('/');
  return matchSegments(parts, 0, segs, 0);
}

function matchSegments(parts, pi, segs, si) {
  while (pi < parts.length) {
    const part = parts[pi];
    if (part === '**') {
      // `**` 吃掉 0..n 段
      for (let k = si; k <= segs.length; k++) {
        if (matchSegments(parts, pi + 1, segs, k)) return true;
      }
      return false;
    }
    if (si >= segs.length) return false;
    if (!segmentMatch(part, segs[si])) return false;
    pi++;
    si++;
  }
  return si === segs.length;
}

function segmentMatch(pattern, seg) {
  const re = new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`,
  );
  return re.test(seg);
}

// --------------------------------------------------------------------------- 工具

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 规范化 JSON 文本：键排序、无空白（口径同 core 的 Json.canonical）。 */
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 按豁免表把一棵 JSON 归一：**删除**豁免字段、把豁免路径的值置为占位、
 * 把人读文字字段换成类型标记。
 *
 * 为什么删而不是置空：置空会让「字段在不在」参与比较，而「在不在」本身可能因豁免逻辑而不同
 * （例如 runId 在 A 里有、在 B 里没有）。删除是幂等的。
 *
 * 为什么人读文字换成类型标记而不是删除：它们要**参与结构比较**（`detail` 从对象变成字符串
 * 必须红），只是内容不参与值比较（见 `PROSE_FIELDS`）。
 */
function normalize(value, path = '') {
  if (Array.isArray(value)) {
    return value.map((v, i) => normalize(v, `${path}/${i}`));
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      const childPath = `${path}/${k}`;
      if (Object.prototype.hasOwnProperty.call(EXEMPT_FIELDS, k)) continue;
      if (EXEMPT_PATHS.some((e) => globMatch(e.glob, childPath.replace(/^\//, '')))) continue;
      const child = value[k];
      // 人读文字字段：**只对叶子值**豁免内容（换成类型标记），容器照常下钻。
      // 这一条是必须的：`detail` 在 criteria.json 里是字符串（人读），
      // 在 segments/*.json 里却是对象（段详情容器）——同名不同角色，
      // 一律替换会把段详情的整棵子树折叠成一个 "object"（自检当场照出的缺陷）。
      if (PROSE_FIELDS.has(k) && (child === null || typeof child !== 'object')) {
        out[k] = kindOf(child);
        continue;
      }
      out[k] = normalize(child, childPath);
    }
    return out;
  }
  return value;
}

/** 递归列出目录下的全部文件（相对路径，'/' 分隔，字典序）。 */
function listFiles(root, sub = '') {
  const dir = sub ? join(root, sub) : root;
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = sub ? `${sub}/${name}` : name;
    const full = join(root, rel);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(root, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// --------------------------------------------------------------------------- 单产物比较

/**
 * 比较一个产物（两个文件路径），返回 `{ok, mode, detail}`。
 *
 * `mode` 为 null 时用默认表。
 */
function compareArtifact(pathA, pathB, relPath, mode) {
  const m = mode || defaultMode(relPath);
  const existsA = existsSync(pathA);
  const existsB = existsSync(pathB);
  if (!existsA || !existsB) {
    return {
      ok: false,
      mode: m,
      detail: `产物缺失：A=${existsA ? '在' : '缺'} B=${existsB ? '在' : '缺'}`,
    };
  }
  const bufA = readFileSync(pathA);
  const bufB = readFileSync(pathB);

  if (m === 'presence-only') {
    if (bufA.length === 0 || bufB.length === 0) {
      return { ok: false, mode: m, detail: `空文件（presence-only 要求非空）：A=${bufA.length}B B=${bufB.length}B` };
    }
    return { ok: true, mode: m, detail: `在场且非空（A=${bufA.length}B B=${bufB.length}B）` };
  }

  if (m === 'byte-equal') {
    const ha = sha256(bufA);
    const hb = sha256(bufB);
    return {
      ok: ha === hb,
      mode: m,
      detail: ha === hb ? `逐字节相同 sha256=${ha}` : `字节不同：A=${ha} B=${hb}（A=${bufA.length}B B=${bufB.length}B）`,
    };
  }

  // canonical-hash-equal / structural-equal 都要解析 JSON
  let ja;
  let jb;
  try {
    ja = readJson(pathA);
  } catch (e) {
    return { ok: false, mode: m, detail: `A 不是合法 JSON：${e.message}` };
  }
  try {
    jb = readJson(pathB);
  } catch (e) {
    return { ok: false, mode: m, detail: `B 不是合法 JSON：${e.message}` };
  }

  if (m === 'canonical-hash-equal') {
    const proj = projectionFor(relPath);
    const ta = proj ? proj.project(ja) : ja;
    const tb = proj ? proj.project(jb) : jb;
    const ca = canonical(normalize(ta));
    const cb = canonical(normalize(tb));
    const ha = sha256(Buffer.from(ca, 'utf8'));
    const hb = sha256(Buffer.from(cb, 'utf8'));
    const note = proj ? `（投影：${proj.reason}）` : '';
    return {
      ok: ha === hb,
      mode: m,
      detail: ha === hb ? `规范化哈希相同 sha256=${ha}${note}` : `规范化哈希不同：A=${ha} B=${hb}${note}`,
    };
  }

  // structural-equal：键集合 + 类型 + 数组长度 + 豁免归一后的值（投影同样先应用）
  const proj = projectionFor(relPath);
  const ta = proj ? proj.project(ja) : ja;
  const tb = proj ? proj.project(jb) : jb;
  const diffs = [];
  structuralDiff(normalize(ta), normalize(tb), '', diffs, MAX_DIFFS);
  const note = proj ? `（投影：${proj.reason}）` : '';
  return {
    ok: diffs.length === 0,
    mode: m,
    detail: diffs.length === 0 ? `结构一致${note}` : `${diffs.length} 处结构差异${note}：${diffs.join('；')}`,
  };
}

const MAX_DIFFS = 12;

/** 结构比较：键集合/类型/数组长度/值。差异写进 `out`（上限 `max`）。 */
function structuralDiff(a, b, path, out, max) {
  if (out.length >= max) return;
  const ta = kindOf(a);
  const tb = kindOf(b);
  if (ta !== tb) {
    out.push(`${path || '/'} 类型不同：${ta} vs ${tb}`);
    return;
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      out.push(`${path || '/'} 数组长度不同：${a.length} vs ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      structuralDiff(a[i], b[i], `${path}/${i}`, out, max);
      if (out.length >= max) return;
    }
    return;
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    const onlyA = ka.filter((k) => !kb.includes(k));
    const onlyB = kb.filter((k) => !ka.includes(k));
    if (onlyA.length) out.push(`${path || '/'} 仅 A 有键：${onlyA.join(',')}`);
    if (onlyB.length) out.push(`${path || '/'} 仅 B 有键：${onlyB.join(',')}`);
    for (const k of ka) {
      if (!kb.includes(k)) continue;
      structuralDiff(a[k], b[k], `${path}/${k}`, out, max);
      if (out.length >= max) return;
    }
    return;
  }
  if (a !== b) {
    out.push(`${path || '/'} 值不同：${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// --------------------------------------------------------------------------- 整 run 比较

/**
 * 比较 run 目录与一份基准清单（**单 run 模式**）。
 *
 * <h3>与「两个 run 互比」的差别</h3>
 * 两 run 互比回答「这两次跑出来的一样吗」（A3 的标准形态，比的是两侧文件）。
 * 本模式回答「这一次跑出来的东西**符合基准声明的期望**吗」——基准侧没有第二份 run，
 * 期望写在基准清单的 `expect` 字段里（逐字段子集断言）。
 *
 * <p>
 * 两种模式都把「比较模式」当第一等公民：本模式同样逐产物核 `mode`
 * （`presence-only` 只查在场、`canonical-hash-equal` 核 `expect` 子集的规范化哈希）。
 */
function compareRunToBaseline(dirA, baseline) {
  const results = [];
  const filesA = new Set(listFiles(dirA));
  const declared = Array.isArray(baseline.artifacts) ? baseline.artifacts : [];

  if (declared.length === 0) {
    return {
      results: [
        {
          path: '(baseline)',
          mode: '-',
          ok: false,
          detail: '基准清单没有声明任何产物（artifacts[] 为空）——空基准是恒绿假断言',
        },
      ],
      extra: [...filesA],
      declared: baseline,
    };
  }

  for (const t of declared) {
    const rel = String(t.path).replace(/\\/g, '/');
    const mode = t.mode || defaultMode(rel);
    if (!MODES.includes(mode)) {
      results.push({ path: rel, mode, ok: false, detail: `未知比较模式：${mode}` });
      continue;
    }
    if (!filesA.has(rel)) {
      results.push({ path: rel, mode, ok: false, detail: 'run 里缺该产物（基准声明了它）' });
      continue;
    }
    const path = join(dirA, rel);

    if (mode === 'presence-only') {
      const bytes = statSync(path).size;
      results.push({
        path: rel,
        mode,
        ok: bytes > 0,
        detail: bytes > 0 ? `在场且非空（${bytes}B）` : '空文件（presence-only 要求非空）',
      });
      continue;
    }

    if (mode === 'byte-equal') {
      results.push({
        path: rel,
        mode,
        ok: false,
        detail: 'byte-equal 需要两侧字节（基准清单只有声明值）——请用 `--a <runA> --b <runB>` 的互比形态',
      });
      continue;
    }

    let doc;
    try {
      doc = readJson(path);
    } catch (e) {
      results.push({ path: rel, mode, ok: false, detail: `不是合法 JSON：${e.message}` });
      continue;
    }

    if (!t.expect || Object.keys(t.expect).length === 0) {
      // 未声明 expect 的产物：只核「在且是合法 JSON」（结构可用性），并在 detail 里如实说明
      results.push({
        path: rel,
        mode,
        ok: true,
        detail: '在且是合法 JSON（基准未声明 expect：只核可用性，不核对值）',
      });
      continue;
    }

    // 逐条按 RFC 6901 指针核 expect 子集（与用例 action 段的逐步断言同一口径）
    const proj = projectionFor(rel);
    const subject = proj ? proj.project(doc) : doc;
    const diffs = [];
    for (const [pointer, want] of Object.entries(t.expect)) {
      const got = resolvePointer(subject, pointer);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        diffs.push(`${pointer || '/'}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
      }
    }
    results.push({
      path: rel,
      mode,
      ok: diffs.length === 0,
      detail: diffs.length === 0
        ? `期望子集命中（${Object.keys(t.expect).length} 条）`
        : `期望不符：${diffs.join('；')}`,
    });
  }

  const declaredPaths = new Set(declared.map((t) => String(t.path).replace(/\\/g, '/')));
  return { results, extra: [...filesA].filter((p) => !declaredPaths.has(p)), declared: baseline };
}

/**
 * RFC 6901 指针取值（`""` = 整棵文档）。
 *
 * <p>
 * 接受两种写法：带前导 `/` 的标准形态（`/counts/green`）与不带前导 `/` 的简写
 * （`overall` ≡ `/overall`）。简写是给基准清单的可读性留的口子——基准是人写给人审的，
 * 顶层字段名再写一个 `/` 只是噪声。**语义完全相同**（都走同一段解析），不存在第二套口径。
 */
function resolvePointer(doc, pointer) {
  if (pointer === undefined || pointer === null || pointer === '') return doc;
  const p = pointer.startsWith('/') ? pointer : `/${pointer}`;
  let cur = doc;
  for (const raw of p.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : cur[key];
  }
  return cur;
}

/**
 * 比较两个 run 目录。
 *
 * @param dirA 基准 run（`--a` 或 `--run`）
 * @param dirB 待比 run（`--b`）；为 null 时按 `baseline` 声明比较
 * @param baseline `expected/<caseId>/manifest.json` 的内容（可空）
 */
function compareRuns(dirA, dirB, baseline) {
  if (!dirB) {
    return compareRunToBaseline(dirA, baseline || {});
  }
  const filesA = listFiles(dirA);
  const setA = new Set(filesA);
  const setB = new Set(listFiles(dirB));

  // 待比产物清单：baseline 声明优先（那是「这份基准要守哪些产物」的权威），否则取 A 的全集
  let targets;
  let declared = null;
  if (baseline && Array.isArray(baseline.artifacts) && baseline.artifacts.length > 0) {
    targets = baseline.artifacts.map((a) => ({ path: a.path, mode: a.mode }));
    declared = baseline;
  } else {
    targets = filesA.map((p) => ({ path: p, mode: null }));
  }

  const results = [];
  for (const t of targets) {
    const rel = String(t.path).replace(/\\/g, '/');
    const mode = t.mode || defaultMode(rel);
    if (!MODES.includes(mode)) {
      results.push({ path: rel, mode, ok: false, detail: `未知比较模式：${mode}（可用 ${MODES.join('/')}）` });
      continue;
    }
    if (!setA.has(rel)) {
      results.push({ path: rel, mode, ok: false, detail: '基准侧缺该产物（A 里没有）' });
      continue;
    }
    if (!setB.has(rel)) {
      results.push({ path: rel, mode, ok: false, detail: '待比侧缺该产物（B 里没有）' });
      continue;
    }
    const r = compareArtifact(join(dirA, rel), join(dirB, rel), rel, mode);
    results.push({ path: rel, ...r });
  }

  // 待比侧多出来的产物：默认不算差异（多产物可能是新能力面），但如实列出
  const extra = [...setB].filter((p) => !setA.has(p));

  return { results, extra, declared };
}

// --------------------------------------------------------------------------- selftest

/**
 * 自检（证伪）：合成夹具证明「好数据必绿、坏数据必红」。
 *
 * 这是比对器唯一的「不恒绿」保障——只证明该绿是不够的。
 */
function selftest(tmpRoot) {
  const mk = (p) => {
    const full = join(tmpRoot, p);
    mkdirSync(join(full, '..'), { recursive: true });
    return full;
  };
  const write = (p, obj) => {
    const full = mk(p);
    writeFileSync(full, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  };

  // 一份「好」run：含豁免字段（runId/jobId/createdAt/durationMs/时钟）、人读文字与投影字段
  const goodA = {
    'manifest.json': { schema: 'lightning.cp-manifest/1', runId: 'AAA', jobSeq: 1, createdAt: 'T1', artifacts: [] },
    'criteria.json': {
      schema: 'lightning.criteria/1',
      runId: 'AAA',
      generatedAt: 'T1',
      overall: 'green',
      counts: { green: 2, red: 0, error: 0 },
      criteria: [
        { id: 'a', type: 'json-field', verdict: 'green', detail: '产物存在: read/run.json (3554 字节)' },
        { id: 'b', type: 'world-hash-equals', verdict: 'green', detail: '场景哈希一致（幂等）: abc' },
      ],
    },
    'evidence.json': {
      schema: 'lightning.cp-evidence/1',
      runId: 'AAA',
      generatedAt: 'T1',
      overall: 'green',
      verdict: { id: 'evidence-complete', verdict: 'green', detail: '期望证据 10 项齐全' },
      expect: [{ path: 'criteria.json' }],
    },
    'observation.json': {
      schema: 'lightning.observation/1',
      runId: 'AAA',
      createdAt: 'T1',
      observation: { worldTime: 1, totalWorldTime: 1, note: 'x' },
      runtimeReads: [
        { key: 'a', summary: 'run=AAA artifacts=15', sha256: 'skip1' },
        { key: 'b', summary: 'stable text', sha256: 'skip2' },
      ],
      artifacts: [{ path: 'criteria.json', role: 'criteria', bytes: 1234, sha256: 'aa' }],
    },
    'segments/build.json': {
      segment: 'build',
      status: 'ok',
      runId: 'AAA',
      jobId: 'j1',
      recordedAt: 'T1',
      durationMs: 5,
      detail: { stepCount: 3, note: 'build 段' },
    },
    'world/scene-manifest.json': {
      schema: 'lightning.cp-scene/1',
      sha256: 'abc',
      mismatches: [{ pos: [65, 12, 65], kind: 'block' }],
      teReads: [{ pos: [65, 12, 65], completer: 'vanilla' }],
      blocks: [{ pos: [1, 2, 3], blockId: 1, meta: 0 }],
    },
    'read/blocks.json': { schema: 'lightning.cp-read-blocks/1', volume: 96, sha256: 'dd' },
    'read/run.json': { schema: 'lightning.cp-read-run/1', count: 1, runs: [{ runId: 'AAA' }] },
    'shots/a.png': 'PNGDATA',
  };
  // 第二份 run：**只有**可证明非确定的东西变化 ⇒ 必须全绿
  const goodB = JSON.parse(JSON.stringify(goodA));
  goodB['manifest.json'].runId = 'BBB';
  goodB['manifest.json'].jobSeq = 2;
  goodB['manifest.json'].createdAt = 'T2';
  goodB['criteria.json'].runId = 'BBB';
  goodB['criteria.json'].generatedAt = 'T2';
  // 人读 detail 变化（内含字节数）——投影后不比内容
  goodB['criteria.json'].criteria[0].detail = '产物存在: read/run.json (9206 字节)';
  goodB['evidence.json'].runId = 'BBB';
  goodB['evidence.json'].generatedAt = 'T2';
  goodB['evidence.json'].verdict.detail = '期望证据 10 项齐全';
  goodB['observation.json'].runId = 'BBB';
  goodB['observation.json'].createdAt = 'T2';
  goodB['observation.json'].observation.worldTime = 999;
  goodB['observation.json'].observation.totalWorldTime = 999;
  // 人读 summary 内含 runId
  goodB['observation.json'].runtimeReads[0].summary = 'run=BBB artifacts=15';
  goodB['observation.json'].runtimeReads[0].sha256 = 'skip9';
  goodB['observation.json'].artifacts[0].sha256 = 'zz';
  goodB['observation.json'].artifacts[0].bytes = 9999;
  goodB['segments/build.json'].runId = 'BBB';
  goodB['segments/build.json'].jobId = 'j2';
  goodB['segments/build.json'].recordedAt = 'T2';
  goodB['segments/build.json'].durationMs = 77;
  goodB['segments/build.json'].detail.note = '另一段人读文字';
  // read.run 是自引用产物：条目数必然增长（presence-only 覆盖）
  goodB['read/run.json'] = { schema: 'lightning.cp-read-run/1', count: 2, runs: [{ runId: 'AAA' }, { runId: 'BBB' }] };

  for (const [p, v] of Object.entries(goodA)) write(join('a', p), v);
  for (const [p, v] of Object.entries(goodB)) write(join('b', p), v);

  const checks = [];
  const expect = (name, ok, detail) => checks.push({ name, ok, detail });
  /** 复制 goodB 到子目录并施加一处改动。 */
  const variant = (name, fn) => {
    const dir = join(tmpRoot, name);
    for (const [p, v] of Object.entries(goodB)) write(join(name, p), v);
    fn(dir);
    return dir;
  };

  // ① 好数据必须全绿
  const good = compareRuns(join(tmpRoot, 'a'), join(tmpRoot, 'b'), null);
  expect(
    '好数据全绿（豁免字段与投影字段变化不判差异）',
    good.results.every((r) => r.ok),
    good.results.filter((r) => !r.ok).map((r) => `${r.path}: ${r.detail}`).join('；') || '全部一致',
  );

  // ② 改判据**结论** ⇒ criteria.json 必红（投影保留 verdict）
  const rCrit = compareRuns(join(tmpRoot, 'a'), variant('c', (d) => {
    const doc = readJson(join(d, 'criteria.json'));
    doc.criteria[0].verdict = 'red';
    write('c/criteria.json', doc);
  }), null);
  const critRes = rCrit.results.find((r) => r.path === 'criteria.json');
  expect('改判据结论必红（投影保留 verdict）', critRes && !critRes.ok, critRes ? critRes.detail : '缺该产物');

  // ③ 改世界清单 ⇒ world/scene-manifest.json 必红
  const rScene = compareRuns(join(tmpRoot, 'a'), variant('d', (d) => {
    const doc = readJson(join(d, 'world/scene-manifest.json'));
    doc.blocks[0].blockId = 54;
    write('d/world/scene-manifest.json', doc);
  }), null);
  const sceneRes = rScene.results.find((r) => r.path === 'world/scene-manifest.json');
  expect('改世界清单必红', sceneRes && !sceneRes.ok, sceneRes ? sceneRes.detail : '缺该产物');

  // ③b **场景清单的 sha256 必须参与比较**（它不在全局豁免里——过度豁免的反例）
  const rSceneSha = compareRuns(join(tmpRoot, 'a'), variant('d2', (d) => {
    const doc = readJson(join(d, 'world/scene-manifest.json'));
    doc.sha256 = 'tampered';
    write('d2/world/scene-manifest.json', doc);
  }), null);
  const sceneShaRes = rSceneSha.results.find((r) => r.path === 'world/scene-manifest.json');
  expect(
    '场景清单的 sha256 参与比较（按路径豁免而非全局名豁免）',
    sceneShaRes && !sceneShaRes.ok,
    sceneShaRes ? sceneShaRes.detail : '缺该产物',
  );

  // ③c **mismatches / teReads 参与比较**（刻意不豁免——它们是可复现的，豁免会致盲）
  const rMismatch = compareRuns(join(tmpRoot, 'a'), variant('d3', (d) => {
    const doc = readJson(join(d, 'world/scene-manifest.json'));
    doc.mismatches[0].kind = 'meta';
    write('d3/world/scene-manifest.json', doc);
  }), null);
  const mismatchRes = rMismatch.results.find((r) => r.path === 'world/scene-manifest.json');
  expect('mismatches 参与比较（刻意不豁免）', mismatchRes && !mismatchRes.ok, mismatchRes ? mismatchRes.detail : '缺该产物');

  const rTeReads = compareRuns(join(tmpRoot, 'a'), variant('d4', (d) => {
    const doc = readJson(join(d, 'world/scene-manifest.json'));
    doc.teReads[0].completer = 'lp-pipe';
    write('d4/world/scene-manifest.json', doc);
  }), null);
  const teReadsRes = rTeReads.results.find((r) => r.path === 'world/scene-manifest.json');
  expect('teReads 参与比较（刻意不豁免）', teReadsRes && !teReadsRes.ok, teReadsRes ? teReadsRes.detail : '缺该产物');

  // ④ 改结构（删一个键）⇒ observation.json 必红（structural-equal）
  const rObs = compareRuns(join(tmpRoot, 'a'), variant('e', (d) => {
    const doc = readJson(join(d, 'observation.json'));
    delete doc.observation;
    write('e/observation.json', doc);
  }), null);
  const obsRes = rObs.results.find((r) => r.path === 'observation.json');
  expect('改结构必红（structural-equal 缺键）', obsRes && !obsRes.ok, obsRes ? obsRes.detail : '缺该产物');

  // ④b 人读文字字段的**类型**变了 ⇒ 必红（内容不比，结构仍比）
  const rProse = compareRuns(join(tmpRoot, 'a'), variant('e2', (d) => {
    const doc = readJson(join(d, 'segments/build.json'));
    doc.detail.note = { nested: 'object' };
    write('e2/segments/build.json', doc);
  }), null);
  const proseRes = rProse.results.find((r) => r.path === 'segments/build.json');
  expect('人读文字字段的类型变化必红（只豁免内容、不豁免结构）', proseRes && !proseRes.ok, proseRes ? proseRes.detail : '缺该产物');

  // ⑤ 缺产物 ⇒ 必红
  const missDir = join(tmpRoot, 'f');
  for (const [p, v] of Object.entries(goodB)) {
    if (p === 'evidence.json') continue;
    write(join('f', p), v);
  }
  const rMiss = compareRuns(join(tmpRoot, 'a'), missDir, null);
  const missRes = rMiss.results.find((r) => r.path === 'evidence.json');
  expect('缺产物必红', missRes && !missRes.ok, missRes ? missRes.detail : '缺该产物');

  // ⑥ 图像内容变了但仍在场 ⇒ presence-only 必须仍绿
  const rPng = compareRuns(join(tmpRoot, 'a'), variant('g', () => write('g/shots/a.png', 'DIFFERENTPNGDATA')), null);
  const pngRes = rPng.results.find((r) => r.path === 'shots/a.png');
  expect('图像内容变化仍绿（presence-only 口径）', pngRes && pngRes.ok, pngRes ? pngRes.detail : '缺该产物');

  // ⑦ 空文件 ⇒ presence-only 必红
  const rEmpty = compareRuns(join(tmpRoot, 'a'), variant('h', () => write('h/shots/a.png', '')), null);
  const emptyRes = rEmpty.results.find((r) => r.path === 'shots/a.png');
  expect('空文件必红（presence-only 要求非空）', emptyRes && !emptyRes.ok, emptyRes ? emptyRes.detail : '缺该产物');

  // ⑧ read/run.json 的默认模式是 presence-only（自引用产物条目数必然增长）
  const rRun = compareRuns(join(tmpRoot, 'a'), join(tmpRoot, 'b'), null);
  const runRes = rRun.results.find((r) => r.path === 'read/run.json');
  expect(
    'read/run.json 默认 presence-only（自引用产物：条目数随 run 数增长）',
    runRes && runRes.ok && runRes.mode === 'presence-only',
    runRes ? `mode=${runRes.mode} ${runRes.detail}` : '缺该产物',
  );

  // ⑨ baseline 声明的产物清单被尊重（不是「A 里有什么就比什么」）
  const baseDoc = { caseId: 'x', artifacts: [{ path: 'criteria.json', mode: 'canonical-hash-equal' }] };
  const rBase = compareRuns(join(tmpRoot, 'a'), join(tmpRoot, 'b'), baseDoc);
  expect(
    'baseline 声明的产物清单被尊重（只比声明的那些）',
    rBase.results.length === 1 && rBase.results[0].path === 'criteria.json',
    `比了 ${rBase.results.length} 个产物`,
  );

  // ⑩ baseline 可逐产物覆盖模式（read/run.json 声明 presence-only 的落点）
  const baseOverride = {
    caseId: 'x',
    artifacts: [{ path: 'read/run.json', mode: 'presence-only' }],
  };
  const rOverride = compareRuns(join(tmpRoot, 'a'), join(tmpRoot, 'b'), baseOverride);
  expect(
    'baseline 可逐产物覆盖比较模式',
    rOverride.results.length === 1 && rOverride.results[0].ok,
    rOverride.results.map((r) => `${r.path}:${r.mode}:${r.ok}`).join('；'),
  );

  // ⑪ **单 run + 基准**模式：逐字段 expect 子集核（--run X --baseline M）
  const singleBase = {
    caseId: 'read-surface',
    artifacts: [
      { path: 'criteria.json', mode: 'canonical-hash-equal', expect: { overall: 'green', 'counts/green': 2 } },
      { path: 'world/scene-manifest.json', mode: 'canonical-hash-equal', expect: { 'blocks/0/blockId': 1 } },
      { path: 'read/run.json', mode: 'presence-only' },
    ],
  };
  const rSingle = compareRuns(join(tmpRoot, 'a'), null, singleBase);
  expect(
    '单 run + 基准：expect 子集命中即绿（presence-only 查在场）',
    rSingle.results.every((r) => r.ok),
    rSingle.results.filter((r) => !r.ok).map((r) => `${r.path}: ${r.detail}`).join('；') || '全部命中',
  );

  // ⑪b 单 run + 基准：expect 值不符 ⇒ 必红，且指名该字段
  const singleBad = {
    caseId: 'x',
    artifacts: [{ path: 'criteria.json', mode: 'canonical-hash-equal', expect: { overall: 'red' } }],
  };
  const rSingleBad = compareRuns(join(tmpRoot, 'a'), null, singleBad);
  expect(
    '单 run + 基准：expect 不符必红且指名字段',
    !rSingleBad.results[0].ok && rSingleBad.results[0].detail.includes('overall'),
    rSingleBad.results[0].detail,
  );

  // ⑪c 单 run + 基准：基准侧缺产物 ⇒ 必红（基准声明了它）
  const singleMissing = {
    caseId: 'x',
    artifacts: [{ path: 'action/absent.json', mode: 'structural-equal' }],
  };
  const rSingleMissing = compareRuns(join(tmpRoot, 'a'), null, singleMissing);
  expect(
    '单 run + 基准：run 里缺基准声明的产物必红',
    !rSingleMissing.results[0].ok && rSingleMissing.results[0].detail.includes('缺该产物'),
    rSingleMissing.results[0].detail,
  );

  // ⑪d 空基准是恒绿假断言 ⇒ 必须红
  const rEmptyBase = compareRuns(join(tmpRoot, 'a'), null, { caseId: 'x', artifacts: [] });
  expect('空基准（artifacts 为空）必红', !rEmptyBase.results[0].ok, rEmptyBase.results[0].detail);

  return checks;
}

// --------------------------------------------------------------------------- CLI

function usage() {
  return `用法:
  # 两次 run 互比（A3 的标准形态）
  node compare-runs.mjs --a <runDirA> --b <runDirB> [--json-out <path>] [--quiet]

  # 单 run 对基准（核基准声明的 expect 子集）
  node compare-runs.mjs --run <runDir> --baseline <manifest.json> [--json-out <path>] [--quiet]

  # 自检（证伪：确认比对器不是恒绿）
  node compare-runs.mjs --selftest

比较模式与豁免字段表见 docs/control-plane/case-file.md §10。
退出码：0=全一致 / 2=有差异 / 3=设施错误（与 core.shutdown 同一约定）。`;
}

function parseArgs(argv) {
  const out = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--a') out.a = argv[++i];
    else if (a === '--b') out.b = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--json-out') out.jsonOut = argv[++i];
    else {
      process.stderr.write(`未知参数: ${a}\n${usage()}\n`);
      process.exit(EXIT_FACILITY);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.selftest && !args.a && !args.run)) {
    process.stdout.write(`${usage()}\n`);
    process.exit(args.help ? EXIT_OK : EXIT_FACILITY);
  }

  if (args.selftest) {
    const tmpRoot = join(tmpdir(), `cp-compare-selftest-${process.pid}`);
    mkdirSync(tmpRoot, { recursive: true });
    const checks = selftest(tmpRoot);
    let ok = true;
    for (const c of checks) {
      process.stdout.write(`  [${c.ok ? 'GREEN' : ' RED '}] ${c.name} — ${c.detail}\n`);
      if (!c.ok) ok = false;
    }
    process.stdout.write(`\nselftest: ${checks.filter((c) => c.ok).length}/${checks.length} 通过\n`);
    process.exit(ok ? EXIT_OK : EXIT_DIFF);
  }

  const dirA = resolve(args.a || args.run);
  const dirB = args.a && args.b ? resolve(args.b) : null;
  if (!existsSync(dirA)) {
    process.stderr.write(`设施错误：基准 run 目录不存在: ${dirA}\n`);
    process.exit(EXIT_FACILITY);
  }
  if (dirB && !existsSync(dirB)) {
    process.stderr.write(`设施错误：待比 run 目录不存在: ${dirB}\n`);
    process.exit(EXIT_FACILITY);
  }

  let baseline = null;
  if (args.baseline) {
    if (!existsSync(args.baseline)) {
      process.stderr.write(`设施错误：基准清单不存在: ${args.baseline}\n`);
      process.exit(EXIT_FACILITY);
    }
    try {
      baseline = readJson(args.baseline);
    } catch (e) {
      process.stderr.write(`设施错误：基准清单不是合法 JSON: ${e.message}\n`);
      process.exit(EXIT_FACILITY);
    }
  }

  const { results, extra, declared } = compareRuns(dirA, dirB, baseline);
  const failed = results.filter((r) => !r.ok);

  const doc = {
    schema: 'lightning.cp-compare/1',
    comparedAt: new Date().toISOString(),
    a: dirA,
    b: dirB,
    baseline: args.baseline || null,
    baselineCaseId: declared ? declared.caseId || null : null,
    artifactCount: results.length,
    same: results.length - failed.length,
    different: failed.length,
    extraArtifacts: extra,
    overall: failed.length === 0 ? 'green' : 'red',
    results,
  };

  if (!args.quiet) {
    process.stdout.write(`run 比对：A=${basename(dirA)}${dirB ? ` B=${basename(dirB)}` : ''}\n`);
    for (const r of results) {
      process.stdout.write(`  [${r.ok ? 'GREEN' : ' RED '}] ${r.path} (${r.mode}) — ${r.detail}\n`);
    }
    if (extra.length) {
      process.stdout.write(`  多出（不判差异，如实列出）：${extra.join(', ')}\n`);
    }
  }
  process.stdout.write(`${doc.overall}：${doc.same}/${doc.artifactCount} 一致，${doc.different} 处差异\n`);

  if (args.jsonOut) {
    writeFileSync(args.jsonOut, JSON.stringify(doc, null, 2));
    process.stdout.write(`机读结论：${resolve(args.jsonOut)}\n`);
  }

  process.exit(failed.length === 0 ? EXIT_OK : EXIT_DIFF);
}

main();
