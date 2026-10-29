#!/usr/bin/env node
// Subagent rows: [status] title · agentType · 🌳worktree · model·effort · tokens ctx% · elapsed · activity
// Metric columns are aligned across rows; the title takes what width is left.
// Input: {cwd, columns, tasks: [{id, name, type, agentType, status, description, label,
// startTime, model, effort, contextWindowSize, tokenCount, tokenSamples, cwd}]}.
// Output: one {"id", "content"} JSON line per row.

const path = require('path');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const DIM_CYAN = '\x1b[2;36m';

const SEP = ` ${DIM}·${RESET} `;
const SEP_WIDTH = 3;
const MIN_TITLE = 12;
const SPARK_TICKS = 8;
const SPARK = '▁▂▃▄▅▆▇█';
const AGENT_MAX = 16;
const TREE_MAX = 16;
// Each agent type hashes to a stable color, so same-type rows read as a group.
const AGENT_COLORS = [
  '\x1b[38;2;189;147;249m', '\x1b[38;2;255;121;198m', '\x1b[38;2;255;184;108m',
  '\x1b[38;2;139;233;253m', '\x1b[38;2;80;250;123m', '\x1b[38;2;241;250;140m',
  '\x1b[38;2;130;170;255m', '\x1b[38;2;255;150;150m',
];

const color = (c, s) => (s ? `${c}${s}${RESET}` : s);

const fmt = (n) => {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
};

const cpWidth = (cp) => {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if (cp >= 0x1f000 || cp === 0x26a1 ||
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)) return 2;
  return 1;
};
const width = (s) => {
  let w = 0;
  for (const ch of s) w += cpWidth(ch.codePointAt(0));
  return w;
};
const truncate = (s, max) => {
  if (width(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = cpWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
};
const padEnd = (s, w) => s + ' '.repeat(Math.max(0, w - width(s)));
const padStart = (s, w) => ' '.repeat(Math.max(0, w - width(s))) + s;

// claude-haiku-4-5-20251001 → haiku4.5, claude-opus-5-5[1m] → opus5.5
function shortModel(id) {
  if (!id) return '';
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (m) return m[1] + m[2] + (m[3] ? '.' + m[3] : '');
  return id.replace(/^claude-/, '').replace(/\[.*\]$/, '');
}

// plugin-dev:agent-creator → agent-creator; the plugin prefix rarely tells rows apart.
const shortAgent = (type) => (type ? type.slice(type.lastIndexOf(':') + 1) : '');

const agentColor = (type) => {
  let h = 0;
  for (const ch of type) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
};

const STATUS_ICONS = {
  completed: [GREEN, '✓'], done: [GREEN, '✓'], success: [GREEN, '✓'],
  failed: [RED, '✗'], error: [RED, '✗'],
  killed: [DIM, '■'], stopped: [DIM, '■'], cancelled: [DIM, '■'], aborted: [DIM, '■'],
  pending: [DIM, '…'], queued: [DIM, '…'], waiting: [DIM, '…'],
};

const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + 'm';
};

const toMs = (t) => {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  if (typeof t === 'string') {
    const n = Number(t);
    if (Number.isFinite(n)) return toMs(n);
    const p = Date.parse(t);
    return Number.isFinite(p) ? p : null;
  }
  return null;
};

// tokenSamples holds tokenCount once per tick; plot per-tick growth on a fixed
// log scale so idle agents read flat and rows are comparable.
function activity(samples) {
  const vals = (Array.isArray(samples) ? samples : []).map(Number).filter(Number.isFinite);
  if (vals.length < 2) return '';
  const deltas = [];
  for (let i = 1; i < vals.length; i++) deltas.push(Math.max(0, vals[i] - vals[i - 1]));
  return deltas.slice(-SPARK_TICKS).map((d) => {
    if (d <= 0) return SPARK[0];
    if (d < 100) return SPARK[1];
    const f = Math.min(1, (Math.log10(d) - 2) / (Math.log10(50000) - 2));
    return SPARK[1 + Math.round(f * 6)];
  }).join('');
}

// A subagent gets its own cwd only when it runs in its own directory, such as an
// isolated worktree; otherwise it shares the session's.
const ownDir = (cwd, sessionCwd) =>
  cwd && sessionCwd && path.resolve(cwd) !== path.resolve(sessionCwd) ? path.basename(cwd) : '';

function cells(t, now, sessionCwd) {
  const [iconColor, icon] = STATUS_ICONS[t.status] || [];
  const tree = ownDir(t.cwd, sessionCwd);
  // description is the task as spawned; label follows the agent's current step.
  // type is always local_agent; agentType (v2.1.293+) names the actual subagent.
  const title = t.name || t.description || t.label || t.agentType || 'agent';
  const step = t.label && t.label !== title && t.label !== t.description ? t.label : '';
  const agent = t.agentType && t.agentType !== title ? truncate(shortAgent(t.agentType), AGENT_MAX) : '';
  const effort = typeof t.effort === 'number' ? 'b' + fmt(t.effort) : t.effort || '';
  const tokens = Number(t.tokenCount);
  const size = Number(t.contextWindowSize);
  const pct = tokens >= 0 && size > 0 ? Math.round(tokens / size * 100) : null;
  const start = toMs(t.startTime);
  return {
    icon: icon ? `${iconColor}${icon}${RESET} ` : '',
    iconWidth: icon ? 2 : 0,
    title: step ? `${title} › ${step}` : title,
    titleHead: title,
    agent,
    agentColor: agent ? agentColor(t.agentType) : '',
    tree: tree ? '🌳' + truncate(tree, TREE_MAX) : '',
    model: [shortModel(t.model), effort].filter(Boolean).join('·'),
    tokens: Number.isFinite(tokens) && tokens > 0 ? fmt(tokens) : '',
    pct: pct == null ? '' : pct + '%',
    pctColor: pct >= 80 ? RED : pct >= 60 ? YELLOW : GREEN,
    elapsed: t.status === 'running' && start ? fmtElapsed(now - start) : '',
    spark: t.status === 'running' ? activity(t.tokenSamples) : '',
  };
}

// Metric columns, in display order; `drop` is the degrade order when narrow.
const COLUMNS = [
  { key: 'agent', align: 'left', render: (c, s) => color(c.agentColor, s) },
  { key: 'tree', align: 'left', render: (c, s) => s },
  { key: 'model', align: 'left', render: (c, s) => color(DIM_CYAN, s) },
  { key: 'usage', align: 'right', text: (c) => [c.tokens, c.pct].filter(Boolean).join(' '),
    render: (c) => [color(DIM, c.tokens), color(c.pctColor, c.pct)].filter(Boolean).join(' ') },
  { key: 'elapsed', align: 'right', render: (c, s) => color(DIM, s) },
  { key: 'spark', align: 'left', render: (c, s) => color(CYAN, s) },
];
const DROP_ORDER = ['spark', 'elapsed', 'model', 'tree', 'agent'];

function render(data) {
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const maxWidth = Number(data.columns) || (Number(process.env.COLUMNS) - 6) || 100;
  const now = Date.now();
  const rows = tasks.map((t) => ({ id: t.id, c: cells(t, now, data.cwd) }));
  const text = (col, c) => (col.text ? col.text(c) : c[col.key]);

  let cols = COLUMNS.slice();
  let layout;
  for (let drop = 0; ; drop++) {
    const widths = cols.map((col) => Math.max(0, ...rows.map((r) => width(text(col, r.c)))));
    const active = cols.filter((col, i) => widths[i] > 0);
    const activeWidths = widths.filter((w) => w > 0);
    const metricsWidth = activeWidths.reduce((a, w) => a + w + SEP_WIDTH, 0);
    const titleMax = Math.max(0, ...rows.map((r) => r.c.iconWidth + width(r.c.title)));
    const titleWidth = Math.min(titleMax, maxWidth - metricsWidth);
    layout = { active, activeWidths, titleWidth };
    if (titleWidth >= Math.min(MIN_TITLE, titleMax) || drop >= DROP_ORDER.length) break;
    cols = cols.filter((col) => col.key !== DROP_ORDER[drop]);
  }

  const { active, activeWidths, titleWidth } = layout;
  const tw = Math.max(1, titleWidth);
  return rows.map(({ id, c }) => {
    const titleWidth = tw - c.iconWidth;
    const shown = truncate(c.title, Math.max(1, titleWidth));
    // Dim the "› step" tail when it survived truncation.
    const title = shown.length > c.titleHead.length
      ? c.titleHead + color(DIM, shown.slice(c.titleHead.length))
      : shown;
    let out = c.icon + title + ' '.repeat(Math.max(0, titleWidth - width(shown)));
    const metrics = active.map((col, i) => ({ col, s: text(col, c), w: activeWidths[i] }));
    let last = metrics.length - 1;
    while (last >= 0 && !metrics[last].s) last--;
    for (const { col, s, w } of metrics.slice(0, last + 1)) {
      const padded = col.align === 'right' ? padStart(s, w) : padEnd(s, w);
      out += s ? SEP + padded.replace(s, col.render(c, s)) : ' '.repeat(SEP_WIDTH) + padded;
    }
    return JSON.stringify({ id, content: out.replace(/\s+$/, '') });
  }).join('\n');
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const out = render(JSON.parse(input));
    if (out) process.stdout.write(out + '\n');
  } catch (e) {}
});
