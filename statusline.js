#!/usr/bin/env node
// Statusline: ▓░ bar | model | ⚡effort·fast | 🌳worktree | prompt cache | rate limits
// Fits into $COLUMNS by dropping low-priority details first (see DEGRADE).

const path = require('path');

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const BOLD_RED = '\x1b[1;31m';
const GREEN = '\x1b[32m';
const BOLD_GREEN = '\x1b[1;32m';
const YELLOW = '\x1b[33m';
const ORANGE = '\x1b[38;2;255;140;0m';
const PINK = '\x1b[38;2;255;125;218m';
const DIM_CYAN = '\x1b[2;36m';

// Columns kept free at the right edge (Claude Code's own padding around the row).
const EDGE_MARGIN = 4;
// A miss younger than this is highlighted.
const RECENT_MISS_SEC = 300;

const color = (c, s) => `${c}${s}${RESET}`;

const fmt = (n) => {
  if (n < 0) return '-' + fmt(-n);
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1000000) return Math.round(n / 1000) + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
};

const fmtCountdown = (sec) => {
  if (sec <= 0) return '0m';
  if (sec < 60) return Math.ceil(sec) + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h + 'h' + (m > 0 ? m + 'm' : '');
};

// --- Display width (ANSI/OSC 8 stripped, wide glyphs count as 2) ---
const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const cpWidth = (cp) => {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0;
  if (cp >= 0x1f000 || cp === 0x26a1 ||
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)) return 2;
  return 1;
};
const visibleWidth = (s) => {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, '')) w += cpWidth(ch.codePointAt(0));
  return w;
};

const safe = (fn) => { try { return fn(); } catch (e) { return null; } };

// --- Segments ---

function contextSeg(data, o) {
  const raw = data.context_window?.used_percentage;
  const pct = Math.max(0, Math.min(100, Math.floor(Number(raw) || 0)));
  const c = pct >= 80 ? RED : pct >= 60 ? YELLOW : GREEN;
  if (!o.barWidth) return color(c, `${pct}%`);
  const filled = Math.floor(pct * o.barWidth / 100);
  return color(c, '▓'.repeat(filled) + '░'.repeat(o.barWidth - filled) + ` ${pct}%`);
}

function modelSeg(data, o) {
  const name = data.model?.display_name || '?';
  return o.modelFull ? name : name.replace(/\s*\([^)]*\)/g, '').trim();
}

const CAUSE_LABELS = { system_prompt_changed: 'sys', likely_server_side: 'srv' };

function missCauseLabel(lc) {
  const causes = lc && Array.isArray(lc.causes) ? lc.causes : [];
  if (!causes.length) return null;
  return causes.map((k) => {
    if (k === 'tools_changed') {
      const a = Number(lc.tools_added) || 0;
      const r = Number(lc.tools_removed) || 0;
      return 'tools' + (a ? '+' + a : '') + (r ? '-' + r : '');
    }
    if (k === 'system_prompt_changed') {
      const d = Number(lc.system_char_delta);
      return Number.isFinite(d) && d !== 0 ? `sys${d > 0 ? '+' : ''}${fmt(d)}` : 'sys';
    }
    const ttl = /^ttl_expired_(\w+)$/.exec(k);
    if (ttl) return 'ttl' + ttl[1];
    return CAUSE_LABELS[k] || k.replace(/_changed$/, '').replace(/_/g, '-').slice(0, 10);
  }).join(',');
}

// Prompt cache state from the `prompt_cache` payload field (Claude Code ≥ 2.1.251).
function cacheSeg(data, o) {
  const pc = data.prompt_cache;
  if (!pc || !pc.caching_observed) return null;
  const usage = data.context_window?.current_usage;
  // /compact just dropped current_usage: the next request rebuilds the cache.
  if (usage == null) return `${color(DIM, 'cache:')}${color(YELLOW, 'reset')}`;

  const now = Date.now() / 1000;
  const parts = [color(DIM, 'cache')];

  if (pc.hit_ratio != null) {
    const ratio = Math.round(Number(pc.hit_ratio) * 100);
    const c = ratio === 0 ? BOLD_RED : ratio >= 90 ? BOLD_GREEN : ratio >= 75 ? GREEN : ratio >= 50 ? YELLOW : ORANGE;
    parts.push(color(c, `${ratio}%`));
  }

  // Last request: tokens read from / written to the cache.
  if (o.cacheCounters) {
    const read = Number(usage.cache_read_input_tokens) || 0;
    const write = Number(usage.cache_creation_input_tokens) || 0;
    if (read > 0) parts.push(color(BOLD_GREEN, `↓${fmt(read)}`));
    if (write > 0) parts.push(color(YELLOW, `${read > 0 ? '+' : '↑'}${fmt(write)}`));
  }

  // TTL countdown.
  const ttlSec = pc.ttl === '5m' ? 300 : pc.ttl === '1h' ? 3600 : null;
  const remaining = pc.expires_at != null ? Number(pc.expires_at) - now : null;
  const cold = pc.warm === false || remaining == null || !(remaining > 0);
  let countColor = RED;
  if (cold) {
    parts.push(color(RED, 'cold'));
  } else {
    const frac = ttlSec ? remaining / ttlSec : 1;
    countColor = frac < 0.1 ? ORANGE : frac < 0.25 ? YELLOW : DIM;
    const label = pc.ttl ? color(pc.ttl === '5m' ? YELLOW : DIM_CYAN, pc.ttl) : '';
    parts.push(`${label}${color(countColor, ':' + fmtCountdown(remaining))}`);
  }

  // Tokens the next request re-caches if the cache goes cold — shown when it is
  // cold or about to be.
  const recache = Number(pc.recache_tokens_if_cold) || 0;
  if (o.recache && recache > 0 && (cold || countColor !== DIM)) {
    parts.push(color(countColor, `❄${fmt(recache)}`));
  }

  // Misses: count plus the likely cause of the last one.
  const misses = Number(pc.misses) || 0;
  if (misses > 0) {
    const recent = pc.last_miss_at != null && now - Number(pc.last_miss_at) < RECENT_MISS_SEC;
    const cause = o.missCause ? missCauseLabel(pc.last_miss_cause) : null;
    parts.push(color(recent ? BOLD_RED : DIM, `✗${misses}` + (cause ? ':' + cause : '')));
  }

  return parts.join(' ');
}

function formatReset(resetTs, coarse) {
  if (!Number.isFinite(resetTs)) return null;
  const resetMin = Math.max(0, Math.ceil((resetTs * 1000 - Date.now()) / 60000));
  if (resetMin >= 1440) {
    const d = Math.floor(resetMin / 1440);
    const h = Math.floor((resetMin % 1440) / 60);
    if (coarse && d >= 2) return `${d}d`;
    if (d === 1 && h === 0) return '24h';
    return `${d}d${h}h`;
  }
  if (resetMin >= 60) {
    const h = Math.floor(resetMin / 60);
    const m = resetMin % 60;
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  return `${resetMin}m`;
}

function rateLimitSeg(label, bucket, coarse, showReset) {
  if (!bucket) return null;
  const raw = bucket.used_percentage;
  const usedPct = (raw == null || raw === '') ? NaN : Number(raw);
  if (!Number.isFinite(usedPct)) return null;
  const p = Math.round(usedPct);
  const c = p < 50 ? PINK : p < 65 ? YELLOW : p < 80 ? ORANGE : RED;
  const main = `${label}:${color(c, p + '%')}`;
  const reset = showReset ? formatReset(bucket.resets_at, coarse) : null;
  return reset ? `${main}${color(DIM, `(${reset})`)}` : main;
}

// --- Layout ---

const DEFAULTS = {
  barWidth: 20,
  modelFull: true,
  effort: true,
  worktree: true,
  cacheCounters: true,
  missCause: true,
  recache: true,
  reset5h: true,
  reset7d: true,
  show7d: true,
  sep: ` ${DIM}|${RESET} `,
};

// Applied one by one until the line fits.
const DEGRADE = [
  (o) => { o.cacheCounters = false; },
  (o) => { o.modelFull = false; },
  (o) => { o.barWidth = 10; },
  (o) => { o.reset7d = false; },
  (o) => { o.missCause = false; },
  (o) => { o.reset5h = false; },
  (o) => { o.barWidth = 0; },
  (o) => { o.show7d = false; },
  (o) => { o.recache = false; },
  (o) => { o.sep = ' '; },
  (o) => { o.effort = false; },
  (o) => { o.worktree = false; },
];

function build(data, o) {
  const rl = data.rate_limits || {};
  const effort = o.effort ? data.effort?.level : null;
  // Fast mode outlives the effort level when narrowing: it changes what a request costs.
  const fast = data.fast_mode === true ? color(ORANGE, 'fast') : null;
  const worktree = data.workspace?.git_worktree;
  return [
    safe(() => contextSeg(data, o)),
    safe(() => modelSeg(data, o)),
    effort || fast ? '⚡' + [effort, fast].filter(Boolean).join('·') : null,
    o.worktree && worktree ? `🌳${path.basename(worktree)}` : null,
    safe(() => cacheSeg(data, o)),
    safe(() => rateLimitSeg('5h', rl.five_hour, false, o.reset5h)),
    o.show7d ? safe(() => rateLimitSeg('7d', rl.seven_day, true, o.reset7d)) : null,
  ].filter(Boolean).join(o.sep);
}

function render(data) {
  const cols = Number(process.env.COLUMNS);
  const maxWidth = cols > 0 ? cols - EDGE_MARGIN : Infinity;
  const o = { ...DEFAULTS };
  let line = build(data, o);
  for (const step of DEGRADE) {
    if (visibleWidth(line) <= maxWidth) break;
    step(o);
    line = build(data, o);
  }
  return line;
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    process.stdout.write(render(JSON.parse(input)));
  } catch (e) {}
});
