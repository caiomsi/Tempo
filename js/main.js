/* Tempo: say what you need to do, see if it fits the time you have.
   Plain DOM. Parsing lives in js/parse.js (TempoParse), accounts + sync in js/sync.js (TempoSync).
   Data is kept in localStorage and, when signed in, synced to the account. */
(function () {
  'use strict';

  var TP = window.TempoParse;
  var KEY = 'tempo:v1';
  var DAY = 86400000;
  var PRI_RANK = { high: 0, med: 1, low: 2 };
  var PRI_LABEL = { high: 'High', med: 'Med', low: 'Low' };
  var CATS = TP.CATS;
  var RING = 2 * Math.PI * 52;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var pad = TP.pad, iso = TP.iso, parseISO = TP.parseISO, today = TP.today, addDays = TP.addDays;
  var capFirst = TP.capFirst, catName = TP.catName, fmt = TP.fmt, parseDuration = TP.parseDuration;

  // ---------- State ----------
  function blank() {
    return { periods: [], activePeriodId: null, tasks: [], running: null, runningAt: 0, learn: {}, deleted: {}, settings: { theme: 'system', pomodoro: false } };
  }

  function normalizePeriod(p) {
    var session = p.kind === 'session';
    return {
      id: String(p.id), kind: session ? 'session' : 'week', name: String(p.name || (session ? 'Study session' : 'Untitled period')),
      start: p.start, end: p.end,
      budgetMin: session && (p.budgetMin == null || p.budgetMin === '') ? null : Math.max(0, Number(p.budgetMin) || 0),
      closed: !!p.closed, startedAt: p.startedAt || null, endedAt: p.endedAt || null, breaks: p.breaks !== false,
      parentId: p.parentId || null, linkIds: Array.isArray(p.linkIds) ? p.linkIds.map(String) : [],
      updatedAt: p.updatedAt || 0
    };
  }
  function normalizeTask(t) {
    var out = {
      id: String(t.id), periodId: String(t.periodId), title: String(t.title || 'Untitled'),
      estMin: Math.max(0, Number(t.estMin) || 0), estGuess: !!t.estGuess, priority: PRI_RANK[t.priority] != null ? t.priority : 'med',
      due: t.due || '', category: catName(t.category || t.tag || '') || 'Other', notes: t.notes || '',
      done: !!t.done, carried: !!t.carried, doneAt: t.doneAt || null, order: Number(t.order) || 0,
      logs: Array.isArray(t.logs) ? t.logs.filter(function (l) { return l && l.end > l.start; }) : [],
      updatedAt: t.updatedAt || 0
    };
    if (t.logsResetAt) out.logsResetAt = t.logsResetAt;
    return out;
  }
  function normalize(s) {
    var b = blank();
    if (!s || typeof s !== 'object') return b;
    var periods = Array.isArray(s.periods) ? s.periods.filter(function (p) { return p && p.id && p.start && p.end; }).map(normalizePeriod) : [];
    var tasks = Array.isArray(s.tasks) ? s.tasks.filter(function (t) { return t && t.id && t.periodId; }).map(normalizeTask) : [];
    var active = periods.some(function (p) { return p.id === s.activePeriodId; }) ? s.activePeriodId : null;
    if (!active && periods.length) active = (latestOpen(periods) || periods[periods.length - 1]).id;
    var running = s.running && tasks.some(function (t) { return t.id === s.running.taskId; }) ? s.running : null;
    return {
      periods: periods, activePeriodId: active, tasks: tasks, running: running, runningAt: s.runningAt || 0,
      learn: s.learn && typeof s.learn === 'object' ? s.learn : {},
      deleted: s.deleted && typeof s.deleted === 'object' ? s.deleted : {},
      settings: Object.assign(b.settings, s.settings || {})
    };
  }
  function latestOpen(periods) {
    var open = periods.filter(function (p) { return !p.closed; });
    return open.length ? open[open.length - 1] : null;
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? normalize(JSON.parse(raw)) : blank();
    } catch (e) { return blank(); }
  }

  // Every change stamps the items it touched (updatedAt) and records deletions, so the
  // account copy can merge edits made on different devices item by item.
  var snap = {}, snapRunning = 'null';
  function itemJSON(o) { return JSON.stringify(o, function (k, v) { return k === 'updatedAt' ? undefined : v; }); }
  function resetSnap() {
    snap = {};
    state.tasks.concat(state.periods).forEach(function (o) { snap[o.id] = itemJSON(o); });
    snapRunning = JSON.stringify(state.running);
  }
  function stampChanges() {
    var now = Date.now(), seen = {};
    state.tasks.concat(state.periods).forEach(function (o) {
      var j = itemJSON(o);
      seen[o.id] = true;
      if (snap[o.id] !== j) { o.updatedAt = now; snap[o.id] = j; }
    });
    Object.keys(snap).forEach(function (id) { if (!seen[id]) { state.deleted[id] = now; delete snap[id]; } });
    var rj = JSON.stringify(state.running);
    if (rj !== snapRunning) { state.runningAt = now; snapRunning = rj; }
    // Forget deletion markers after 60 days.
    Object.keys(state.deleted).forEach(function (id) { if (now - state.deleted[id] > 60 * DAY) delete state.deleted[id]; });
  }

  var storageWarned = false;
  function save(opts) {
    if (!(opts && opts.quiet)) stampChanges();
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) {
      if (!storageWarned) { toast('Can’t save in this browser. Sign in or export a backup so you don’t lose your work.'); storageWarned = true; }
    }
    if (!(opts && opts.quiet) && window.TempoSync && TempoSync.user) TempoSync.schedule();
  }

  var state = load();
  resetSnap();
  var ui = {
    filter: 'open', search: '', editingTaskId: null, editingPeriodId: null, focusId: null, pomo: null,
    preview: [], edits: {}, warned: {}, flash: {}, estEditing: null
  };

  // ---------- Utils ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function daysBetween(a, b) { return Math.round((b - a) / DAY); }
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }
  function fmtShortDate(s) { return parseISO(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }
  function fmtRange(p) {
    var o = { month: 'short', day: 'numeric' };
    return parseISO(p.start).toLocaleDateString(undefined, o) + ' – ' + parseISO(p.end).toLocaleDateString(undefined, o);
  }
  function fmtTime(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function fmtEst(t) { return (t.estGuess ? '~' : '') + fmt(t.estMin); }

  // ---------- Categories ----------
  function usedCategories() {
    var seen = {};
    state.tasks.forEach(function (t) { seen[t.category] = true; });
    return Object.keys(seen);
  }
  function catOrder(a, b) {
    var ia = CATS.indexOf(a), ib = CATS.indexOf(b);
    if (a === 'Other') return 1;
    if (b === 'Other') return -1;
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  }
  function catColor(cat) {
    if (CATS.indexOf(cat) >= 0) return 'var(--c-' + cat.toLowerCase() + ')';
    var h = 0;
    for (var i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
    return 'var(--c-' + CATS[h % (CATS.length - 1)].toLowerCase() + ')';
  }
  function allCategories() { return CATS.concat(usedCategories().filter(function (c) { return CATS.indexOf(c) < 0; })); }
  function learn(title, cat) { TP.learn(state.learn, title, cat); }

  // ---------- Derived data ----------
  function activePeriod() { return periodById(state.activePeriodId); }
  function periodById(id) { for (var i = 0; i < state.periods.length; i++) if (state.periods[i].id === id) return state.periods[i]; return null; }
  function isSession(p) { return !!p && p.kind === 'session'; }
  // A session's tasks: its own, plus the week tasks it pulled in (they stay on the week).
  function periodTasks(p) {
    if (typeof p === 'string') p = periodById(p);
    if (!p) return [];
    var links = {};
    if (isSession(p)) p.linkIds.forEach(function (id) { links[id] = true; });
    return state.tasks.filter(function (t) { return t.periodId === p.id || links[t.id]; });
  }
  function taskById(id) { for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].id === id) return state.tasks[i]; return null; }
  function isRunning(t) { return !!(state.running && state.running.taskId === t.id); }

  function loggedMs(t, since) {
    var ms = 0;
    t.logs.forEach(function (l) {
      if (since) { if (l.end > since) ms += l.end - Math.max(l.start, since); }
      else ms += l.end - l.start;
    });
    if (isRunning(t)) ms += Date.now() - Math.max(state.running.start, since || 0);
    return ms;
  }
  function loggedMin(t, since) { return loggedMs(t, since) / 60000; }
  function remainingMin(t) { return Math.max(t.estMin - loggedMin(t), 0); }

  function sortTasks(list) {
    return list.slice().sort(function (a, b) { return (PRI_RANK[a.priority] - PRI_RANK[b.priority]) || (a.order - b.order); });
  }
  function openTasks(p) { return sortTasks(periodTasks(p).filter(function (t) { return !t.done && !t.carried; })); }

  // Personal estimate accuracy across every finished task that has logged time.
  function accuracy() {
    var est = 0, act = 0, n = 0;
    state.tasks.forEach(function (t) {
      if (!t.done || t.estMin <= 0) return;
      var lg = loggedMin(t);
      if (lg < 1) return;
      est += t.estMin; act += lg; n++;
    });
    return { n: n, factor: n >= 3 && est > 0 ? act / est : null };
  }

  // Context the parser uses: what you've learned, your history, your open tasks.
  function parseCtx() {
    var p = activePeriod(), acc = accuracy();
    return {
      learn: state.learn,
      customCats: usedCategories().filter(function (c) { return CATS.indexOf(c) < 0; }),
      history: state.tasks.filter(function (t) { return t.done; }).map(function (t) { return { title: t.title, actualMin: loggedMin(t) }; }),
      factor: acc.factor,
      openTitles: p ? openTasks(p).map(function (t) { return t.title; }) : []
    };
  }

  function cutoff(p, avail) {
    var cum = 0, cutIds = {}, cutCount = 0, cutMin = 0, cutting = false;
    openTasks(p).forEach(function (t) {
      var r = remainingMin(t);
      cum += r;
      if (!cutting && cum > avail + 0.01) cutting = true;
      if (cutting) { cutIds[t.id] = true; cutCount++; cutMin += r; }
    });
    return { cutIds: cutIds, cutCount: cutCount, cutMin: cutMin };
  }

  function metrics(p) { return isSession(p) ? sessionMetrics(p) : weekMetrics(p); }

  function weekMetrics(p) {
    var tasks = periodTasks(p);
    var used = 0, remaining = 0, open = 0, done = 0;
    tasks.forEach(function (t) {
      var lg = loggedMin(t);
      if (t.done) { used += lg > 0 ? lg : t.estMin; done++; }
      else if (t.carried) { used += lg; }
      else { used += lg; remaining += remainingMin(t); open++; }
    });
    var budget = p.budgetMin, total = used + remaining;
    var ratio = budget > 0 ? total / budget : (total > 0 ? Infinity : 0);
    var status = !tasks.length ? 'idle' : ratio > 1 ? 'over' : ratio > 0.85 ? 'tight' : 'fits';
    var c = cutoff(p, budget - used);
    var start = parseISO(p.start), endEx = addDays(parseISO(p.end), 1), now = Date.now(), len = endEx - start;
    return {
      session: false, tasks: tasks, used: used, remaining: remaining, total: total, budget: budget, ratio: ratio,
      status: status, open: open, done: done, cutIds: c.cutIds, cutCount: c.cutCount, cutMin: c.cutMin,
      free: budget - total, left: budget - used, need: remaining,
      elapsed: len > 0 ? Math.min(Math.max((now - start) / len, 0), 1) : 1,
      daysLeft: Math.max(Math.ceil((endEx - now) / DAY), 0),
      notStarted: now < start, ended: now >= endEx
    };
  }

  // A session counts only time worked since it started. With a set length it counts down
  // in real time; without one, Tempo estimates how long the work (plus breaks) will take.
  function sessionMetrics(p) {
    var tasks = periodTasks(p), since = p.startedAt || 0, now = Date.now();
    var used = 0, remaining = 0, open = 0, done = 0;
    tasks.forEach(function (t) {
      used += loggedMin(t, since);
      if (t.done) done++;
      else if (!t.carried) { remaining += remainingMin(t); open++; }
    });
    var breaksLeft = p.breaks ? Math.max(0, TP.breaksFor(used + remaining) - TP.breaksFor(used)) : 0;
    var need = remaining + breaksLeft;
    var auto = p.budgetMin == null;
    var endAt = p.closed && p.endedAt ? p.endedAt : now;
    var budget, left;
    if (auto) { budget = Math.max(used + need, 1); left = need; }
    else { budget = p.budgetMin; left = budget - (endAt - since) / 60000; }
    var status = !tasks.length ? 'idle' : auto ? 'fits' : need > left ? 'over' : need > left * 0.85 ? 'tight' : 'fits';
    var c = auto ? { cutIds: {}, cutCount: 0, cutMin: 0 } : cutoff(p, Math.max(left, 0) - breaksLeft);
    return {
      session: true, auto: auto, tasks: tasks, used: used, remaining: remaining, breaksLeft: breaksLeft, need: need,
      budget: budget, left: left, total: used + need, free: left - need, status: status, open: open, done: done,
      cutIds: c.cutIds, cutCount: c.cutCount, cutMin: c.cutMin,
      finishBy: now + need * 60000, endsAt: auto ? null : since + p.budgetMin * 60000,
      ended: !auto && left <= 0
    };
  }

  // ---------- Icons ----------
  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
    focus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4v2H6v3zm11-5h4a1 1 0 0 1 1 1v4h-2V6h-3zM4 15h2v3h3v2H5a1 1 0 0 1-1-1zm14 0h2v4a1 1 0 0 1-1 1h-4v-2h3z"/></svg>',
    grip: '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>',
    note: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style="vertical-align:-1px;fill:currentColor"><path d="M3 2h10v8l-4 4H3zm1.5 1.5v9H8V9h3.5V3.5z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg>',
    moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>'
  };

  function setText(sel, txt) { var el = $(sel); if (el) el.textContent = txt; }

  // ---------- Render ----------
  function render() {
    applyTheme();
    var p = activePeriod();
    var onboard = $('#onboard'), dash = $('#dashboard');
    if (onboard) onboard.hidden = !!p;
    if (dash) dash.hidden = !p;
    document.body.classList.toggle('is-session', isSession(p));
    renderPeriodSelect();
    if (!p) return;
    var m = metrics(p);
    renderHead(p, m);
    renderClock(p, m);
    renderNow(p, m);
    renderFit(p, m);
    renderBanner(p, m);
    renderGroups(p, m);
  }

  function renderPeriodSelect() {
    var sel = $('#period-select');
    if (!sel) return;
    sel.hidden = state.periods.length < 2;
    var opt = function (x) {
      var label = x.name + (x.closed ? (isSession(x) ? ' (ended)' : ' (closed)') : '');
      return '<option value="' + esc(x.id) + '"' + (x.id === state.activePeriodId ? ' selected' : '') + '>' + esc(label) + '</option>';
    };
    var weeks = state.periods.filter(function (x) { return !isSession(x); }).slice().reverse();
    var sessions = state.periods.filter(isSession).slice().reverse().slice(0, 12);
    sel.innerHTML = (weeks.length ? '<optgroup label="Weeks">' + weeks.map(opt).join('') + '</optgroup>' : '') +
      (sessions.length ? '<optgroup label="Study sessions">' + sessions.map(opt).join('') + '</optgroup>' : '');
  }

  function renderHead(p, m) {
    var line;
    if (isSession(p)) {
      line = 'Study session · ' + (p.closed ? 'ended ' + fmtTime(p.endedAt || Date.now()) : fmtTime(p.startedAt) + (p.budgetMin != null ? ' → ' + fmtTime(p.startedAt + p.budgetMin * 60000) : ' · started'));
      var parent = periodById(p.parentId);
      if (parent) line += ' · from ' + parent.name;
    } else {
      line = fmtRange(p);
      if (p.closed) line += ' · closed';
      else if (m.notStarted) line += ' · starts in ' + daysBetween(today(), parseISO(p.start)) + 'd';
      else if (m.ended) line += ' · ended';
      else line += ' · ' + m.daysLeft + (m.daysLeft === 1 ? ' day' : ' days') + ' left';
    }
    setText('#period-dates', line);
    setText('#period-name', p.name);
    var edit = $('#edit-period-btn');
    if (edit) edit.textContent = isSession(p) && !p.closed ? 'End' : 'Edit';
    var ses = $('#session-btn');
    if (ses) ses.hidden = isSession(p);
  }

  // ---------- The chronograph ----------
  // Big dial: time left (hour hand on the budget scale; minutes scale for short sessions),
  // minute hand, ticking second hand, exact readout window. Left sub-dial: stopwatch for the
  // current task. Right sub-dial: how complete that task is against its estimate.
  // Built with the target document's own createElementNS so the pop-out window can reuse it.
  var SVGNS = 'http://www.w3.org/2000/svg';
  // Colours come from CSS tokens (--ch-*) so the watch has a light and a dark face.
  var CH = { face: 'var(--ch-face)', bezel: 'var(--ch-bezel)', sub: 'var(--ch-sub)', subLine: 'var(--ch-subline)', ink: 'var(--ch-ink)', dim: 'var(--ch-dim)', accent: 'var(--ch-accent)' };
  var F_MONO = 'Geist Mono, ui-monospace, monospace';
  var F_UI = 'Geist, -apple-system, system-ui, sans-serif';

  function sv(parent, tag, attrs, text) {
    var n = (parent.ownerDocument || document).createElementNS(SVGNS, tag), style = '';
    for (var k in attrs) {
      // Presentation attributes can't take var(), so token colours go through style.
      if (/^(fill|stroke)$/.test(k) && String(attrs[k]).indexOf('var(') === 0) style += k + ':' + attrs[k] + ';';
      else n.setAttribute(k, attrs[k]);
    }
    if (style) n.setAttribute('style', style);
    if (text != null) n.textContent = text;
    parent.appendChild(n);
    return n;
  }
  function svHand(parent, cx, cy, draw) {
    var g = sv(parent, 'g', { class: 'ch-hand' });
    draw(g);
    var last = null;
    return function (turn) {
      var deg = (turn * 360).toFixed(2);
      if (deg === last) return;
      last = deg;
      g.setAttribute('transform', 'rotate(' + deg + ' ' + cx + ' ' + cy + ')');
    };
  }

  // Rounded-square face with ONE pointer. It starts at the top and turns clockwise as time
  // is used; a line along the square's edge grows with it and ends where the pointer points.
  // The only number is the total length, in minutes, at the top.
  var SQ = { half: 104, radius: 46 };          // face: square from 6 to 214 in a 220 viewBox
  var TRACK = { half: 99, radius: 41 };        // progress line, just inside the face edge

  // Point at fraction f (0..1) of the way round a rounded square, clockwise from top centre.
  function perimeterPoint(f, cx, cy, half, r) {
    var k = half - r, q = Math.PI * r / 2;
    var segs = [k, q, 2 * k, q, 2 * k, q, 2 * k, q, k];
    var total = 8 * k + 4 * q, d = ((f % 1) + 1) % 1 * total;
    var corners = [[k, -k, -Math.PI / 2], [k, k, 0], [-k, k, Math.PI / 2], [-k, -k, Math.PI]];
    for (var i = 0; i < segs.length; i++) {
      if (d > segs[i] && i < segs.length - 1) { d -= segs[i]; continue; }
      var t = segs[i] ? d / segs[i] : 0;
      switch (i) {
        case 0: return [cx + k * t, cy - half];
        case 2: return [cx + half, cy - k + 2 * k * t];
        case 4: return [cx + k - 2 * k * t, cy + half];
        case 6: return [cx - half, cy + k - 2 * k * t];
        case 8: return [cx - k + k * t, cy - half];
        default:
          var c = corners[(i - 1) / 2], a = c[2] + t * Math.PI / 2;
          return [cx + c[0] + r * Math.cos(a), cy + c[1] + r * Math.sin(a)];
      }
    }
    return [cx, cy - half];
  }
  function roundedSquarePath(cx, cy, half, r) {
    var L = cx - half, T = cy - half, R = cx + half, B = cy + half;
    return 'M' + cx + ' ' + T + ' H' + (R - r) + ' A' + r + ' ' + r + ' 0 0 1 ' + R + ' ' + (T + r) +
      ' V' + (B - r) + ' A' + r + ' ' + r + ' 0 0 1 ' + (R - r) + ' ' + B +
      ' H' + (L + r) + ' A' + r + ' ' + r + ' 0 0 1 ' + L + ' ' + (B - r) +
      ' V' + (T + r) + ' A' + r + ' ' + r + ' 0 0 1 ' + (L + r) + ' ' + T + ' Z';
  }
  // Clock turn (0 = 12 o'clock, clockwise) of the point at fraction f round the track.
  function trackTurn(f, cx, cy) {
    var p = perimeterPoint(f, cx, cy, TRACK.half, TRACK.radius);
    var t = Math.atan2(p[0] - cx, -(p[1] - cy)) / (2 * Math.PI);
    return t < 0 ? t + 1 : t;
  }
  // Kept for the Safari canvas fallback: where a ray at `turn` meets the face edge.
  function edgePoint(cx, cy, turn) {
    var a = turn * 2 * Math.PI, dx = Math.sin(a), dy = -Math.cos(a);
    var H = SQ.half, R = SQ.radius, k = H - R;
    var t = H / Math.max(Math.abs(dx), Math.abs(dy));
    var px = dx * t, py = dy * t;
    if (Math.abs(px) > k && Math.abs(py) > k) {
      var ccx = px > 0 ? k : -k, ccy = py > 0 ? k : -k;
      var b = -2 * (dx * ccx + dy * ccy), c = ccx * ccx + ccy * ccy - R * R;
      t = (-b + Math.sqrt(Math.max(b * b - 4 * c, 0))) / 2;
    }
    return { x: cx + dx * t, y: cy + dy * t, dx: dx, dy: dy };
  }

  function buildChrono(svg) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    var cx = 110, cy = 110;
    sv(svg, 'rect', { x: 6, y: 6, width: 208, height: 208, rx: SQ.radius, fill: CH.face, stroke: CH.subLine, 'stroke-width': .6 });
    // 60 ticks spaced evenly along the edge (so they line up with the progress line).
    var ticks = sv(svg, 'g', {});
    for (var i = 0; i < 60; i++) {
      var p = perimeterPoint(i / 60, cx, cy, 92, 34), dx = p[0] - cx, dy = p[1] - cy, n = Math.sqrt(dx * dx + dy * dy);
      var major = i % 5 === 0, len = major ? 9 : 6;
      sv(ticks, 'line', { x1: (p[0] - dx / n * len).toFixed(2), y1: (p[1] - dy / n * len).toFixed(2), x2: p[0].toFixed(2), y2: p[1].toFixed(2),
        stroke: major ? CH.ink : CH.dim, 'stroke-width': major ? 2 : 1, 'stroke-linecap': 'round' });
    }
    // Progress line: faint full track, then the used part from the top round to the pointer.
    var d = roundedSquarePath(cx, cy, TRACK.half, TRACK.radius);
    sv(svg, 'path', { d: d, fill: 'none', stroke: CH.sub, 'stroke-width': 5 });
    var progress = sv(svg, 'path', { d: d, fill: 'none', stroke: CH.accent, 'stroke-width': 5, 'stroke-linecap': 'round', pathLength: 100, 'stroke-dasharray': '0 100' });
    var total = sv(svg, 'text', { x: cx, y: cy - 62, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': F_UI, 'font-size': 24, 'font-weight': 700, fill: CH.ink }, '');
    sv(svg, 'text', { x: cx, y: cy - 45, 'text-anchor': 'middle', 'font-family': F_MONO, 'font-size': 5.2, 'letter-spacing': 1.4, fill: CH.dim }, 'MIN');
    var pointer = svHand(svg, cx, cy, function (g) {
      sv(g, 'line', { x1: cx, y1: cy + 12, x2: cx, y2: cy - 84, stroke: CH.ink, 'stroke-width': 4.4, 'stroke-linecap': 'round' });
      sv(g, 'circle', { cx: cx, cy: cy - 84, r: 3.4, fill: CH.accent });
    });
    sv(svg, 'circle', { cx: cx, cy: cy, r: 6, fill: CH.ink });
    sv(svg, 'circle', { cx: cx, cy: cy, r: 2.2, fill: CH.face });

    // s: { left (sec, may be negative), budget (sec) }
    return function update(s) {
      var budget = Math.max(s.budget, 1), left = Math.max(s.left, 0);
      total.textContent = String(Math.round(budget / 60));
      var used = Math.min(Math.max(1 - left / budget, 0), 1);       // grows clockwise from 0
      progress.setAttribute('stroke-dasharray', (used * 100).toFixed(3) + ' 100');
      progress.setAttribute('style', 'stroke:' + (s.left < 0 ? 'var(--bad)' : CH.accent));
      pointer(used >= 1 ? 1 : trackTurn(used, cx, cy));
    };
  }

  function chronoState(p, m, cur) {
    var label = null;
    if (m.session) label = (m.auto ? 'TO FINISH' : 'SESSION LEFT') + (m.budget <= 360 ? ' · MIN' : ' · HRS');
    return {
      left: m.left * 60, budget: m.budget * 60, label: label,
      task: cur ? { spent: loggedMs(cur.task) / 1000, est: cur.task.estMin * 60 } : null
    };
  }
  function currentTask(p) {
    var running = state.running && taskById(state.running.taskId);
    if (running && periodTasks(p).indexOf(running) >= 0) return { task: running, running: true };
    var next = openTasks(p)[0];
    return next ? { task: next, running: false } : null;
  }

  var mainChrono = null;
  function renderClock(p, m) {
    var svg = $('#chrono');
    if (!svg) return;
    if (!mainChrono) mainChrono = buildChrono(svg);
    var cur = currentTask(p), cs = chronoState(p, m, cur);
    mainChrono(cs);
    var wrap = $('#clock');
    if (wrap) wrap.classList.toggle('is-running', !!(cur && cur.running));
    var over = m.left < 0;
    svg.setAttribute('aria-label', (over ? fmt(-m.left) + ' over' : fmt(m.left) + (m.session && m.auto ? ' to finish' : ' left')) +
      (cur ? '. ' + (cur.running ? 'Working on ' : 'Up next: ') + cur.task.title : ''));
    if (m.session) {
      setText('#clock-sub', m.auto ? fmt(m.remaining) + ' work' + (m.breaksLeft ? ' + ' + fmt(m.breaksLeft) + ' breaks' : '') : 'of ' + fmt(m.budget) + ' · ' + fmt(m.used) + ' worked');
      setText('#lg-left-label', m.auto ? 'Work left' : 'Session ends');
      setText('#lg-left', m.auto ? fmt(m.remaining) : fmtTime(m.endsAt));
      setText('#lg-work-label', 'Worked');
      setText('#lg-work', fmt(m.used));
    } else {
      setText('#clock-sub', 'of ' + fmt(m.budget) + ' · ' + fmt(m.used) + ' worked');
      setText('#lg-left-label', 'Time left');
      setText('#lg-left', m.left >= 0 ? fmt(m.left) : '−' + fmt(-m.left));
      setText('#lg-work-label', 'Work planned');
      setText('#lg-work', fmt(m.remaining));
    }
    renderMini(p, m, cs, cur);
    renderClockMode(p, m, cs, cur);
  }

  function renderNow(p, m) {
    var box = $('#now');
    if (!box) return;
    var cur = currentTask(p);
    if (cur && cur.running) {
      var t = cur.task;
      box.className = 'now is-running';
      box.innerHTML = '<div class="now-text"><span class="now-label">Working on · <span data-live="' + esc(t.id) + '">' + fmt(loggedMin(t)) + '</span> of ' + fmtEst(t) + '</span>' +
        '<span class="now-title">' + esc(t.title) + '</span></div>' +
        '<button type="button" class="icon-btn" data-now="focus" data-id="' + esc(t.id) + '" aria-label="Focus mode" title="Focus mode">' + ICON.focus + '</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-now="toggle" data-id="' + esc(t.id) + '">Pause</button>';
      return;
    }
    box.className = 'now';
    if (!cur) {
      box.innerHTML = '<div class="now-text"><span class="now-label">Up next</span><span class="now-title">Nothing left. Add tasks on the right.</span></div>';
      return;
    }
    var n = cur.task;
    box.innerHTML = '<div class="now-text"><span class="now-label">Up next · ' + esc(n.category) + ' · ' + fmtEst(n) + '</span>' +
      '<span class="now-title">' + esc(n.title) + '</span></div>' +
      '<button type="button" class="icon-btn" data-now="focus" data-id="' + esc(n.id) + '" aria-label="Focus mode" title="Focus mode">' + ICON.focus + '</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-now="toggle" data-id="' + esc(n.id) + '">Start</button>';
  }

  function renderFit(p, m) {
    var acc = accuracy();
    var pill = $('#sum-status');
    if (pill) {
      pill.className = 'status-pill is-' + m.status;
      var text;
      if (m.session && m.auto) text = m.open ? 'Done by ' + fmtTime(m.finishBy) : (m.tasks.length ? 'All done' : 'No tasks yet');
      else if (m.session) text = { idle: 'No tasks yet', fits: 'You’ll finish in time', tight: 'Tight fit', over: fmt(m.need - Math.max(m.left, 0)) + ' short' }[m.status];
      else text = { idle: 'No tasks yet', fits: 'Everything fits', tight: 'Tight fit', over: 'Plan is ' + fmt(m.total - m.budget) + ' over' }[m.status];
      pill.textContent = text;
    }

    var pace = $('#st-pace'), paceSub = '', word = '–', tone = '';
    setText('#st-pace-label', m.session ? (m.auto ? 'Tasks' : 'Finish by') : 'Pace');
    if (m.session) {
      if (!m.tasks.length) { word = '–'; paceSub = 'add or pick tasks'; }
      else if (!m.open) { word = 'All done'; tone = 'tone-ok'; paceSub = fmt(m.used) + ' worked'; }
      else if (m.auto) {
        word = m.open + ' left';
        paceSub = m.done + ' done' + (m.breaksLeft ? ' · ' + fmt(m.breaksLeft) + ' of breaks planned' : '');
      } else {
        word = fmtTime(m.finishBy);
        paceSub = fmt(m.remaining) + ' work' + (m.breaksLeft ? ' + ' + fmt(m.breaksLeft) + ' breaks' : '');
        if (m.need > Math.max(m.left, 0)) { tone = 'tone-bad'; paceSub += ' · needs ' + fmt(m.need - Math.max(m.left, 0)) + ' more'; }
      }
    } else if (m.tasks.length) {
      if (m.notStarted) { word = 'Not started'; paceSub = 'period hasn’t begun'; }
      else if (m.open === 0) { word = 'All done'; tone = 'tone-ok'; paceSub = 'nothing left to do'; }
      else if (m.ended || p.closed) { word = 'Ended'; tone = 'tone-warn'; paceSub = fmt(m.remaining) + ' unfinished'; }
      else {
        var diff = (m.total > 0 ? m.used / m.total : 0) - m.elapsed;
        word = diff > 0.1 ? 'Ahead' : diff < -0.1 ? 'Behind' : 'On track';
        tone = diff > 0.1 ? 'tone-ok' : diff < -0.1 ? 'tone-bad' : '';
        paceSub = '~' + fmt(m.daysLeft > 0 ? m.remaining / m.daysLeft : m.remaining) + '/day for ' + m.daysLeft + 'd';
      }
    }
    if (pace) { pace.textContent = word; pace.className = tone; }
    setText('#st-pace-sub', paceSub);

    var accEl = $('#st-acc'), accSub = '';
    if (accEl) {
      var realistic = acc.factor ? m.used + m.remaining * acc.factor : null;
      if (!acc.factor) {
        accEl.textContent = '–'; accEl.className = '';
        accSub = 'time ' + (3 - acc.n) + ' more finished task' + (3 - acc.n === 1 ? '' : 's') + ' to learn this';
      } else {
        var d = Math.round((acc.factor - 1) * 100);
        if (Math.abs(d) <= 10) { accEl.textContent = 'Spot on'; accEl.className = 'tone-ok'; accSub = 'within 10% of your estimates'; }
        else if (d > 0) { accEl.textContent = '+' + d + '% longer'; accEl.className = 'tone-warn'; accSub = 'new guesses include this'; }
        else { accEl.textContent = Math.abs(d) + '% faster'; accEl.className = 'tone-ok'; accSub = 'new guesses include this'; }
        if (realistic && !m.session) accSub = 'realistic total: ' + fmt(realistic);
      }
    }
    setText('#st-acc-sub', accSub);
  }

  // A week that has run out, or a session past its time, gets a nudge to wrap up.
  function renderBanner(p, m) {
    var b = $('#banner');
    if (!b) return;
    var html = '';
    if (!p.closed && !isSession(p) && m.ended) {
      html = '<span><b>' + esc(p.name) + ' ended ' + parseISO(p.end).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '.</b> Close it to see how it went and carry unfinished tasks into the next one.</span>' +
        '<button type="button" class="btn btn-primary btn-sm" data-action="close-period">Close &amp; plan next</button>';
    } else if (!p.closed && isSession(p) && !m.auto && m.ended) {
      html = '<span><b>Session time is up.</b> Keep going or wrap it up.</span><button type="button" class="btn btn-primary btn-sm" data-action="close-period">End session</button>';
    } else if (!p.closed && isSession(p) && m.tasks.length && !m.open) {
      html = '<span><b>Everything in this session is done.</b> ' + fmt(m.used) + ' worked.</span><button type="button" class="btn btn-primary btn-sm" data-action="close-period">End session</button>';
    }
    b.innerHTML = html;
    b.hidden = !html;
  }

  function dueInfo(t, p) {
    if (!t.due) return null;
    var d = daysBetween(today(), parseISO(t.due));
    var cls = !t.done && d < 0 ? 'is-late' : !t.done && d <= 1 ? 'is-soon' : '';
    var label = d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : d === -1 ? 'Due yesterday' : 'Due ' + fmtShortDate(t.due);
    if (p && !isSession(p) && !t.done && t.due > p.end) { cls = 'is-after'; label += ' · after this week'; }
    return { cls: cls, label: label };
  }

  function taskHTML(t, m, p) {
    var lg = loggedMin(t), running = isRunning(t);
    var cls = ['task'];
    if (t.done) cls.push('is-done');
    if (t.carried) cls.push('is-carried');
    if (running) cls.push('is-running');
    if (m.cutIds[t.id]) cls.push('no-fit');
    if (ui.flash[t.id]) cls.push('is-new');
    var due = dueInfo(t, p);
    var meta = ['<span class="pri pri-' + t.priority + '">' + PRI_LABEL[t.priority] + '</span>'];
    if (m.cutIds[t.id]) meta.push('<span class="nofit-tag">won’t fit</span>');
    if (due) meta.push('<span class="due ' + due.cls + '">' + esc(due.label) + '</span>');
    if (t.carried) meta.push('<span>moved to next period</span>');
    if (isSession(p) && t.periodId !== p.id && periodById(t.periodId)) meta.push('<span>from ' + esc(periodById(t.periodId).name) + '</span>');
    if (t.notes) meta.push('<span title="Has notes">' + ICON.note + ' note</span>');
    var progress = t.estMin > 0 ? Math.min(lg / t.estMin, 1) : (lg > 0 ? 1 : 0);
    var canDrag = !t.done && !t.carried;
    var est = ui.estEditing === t.id
      ? '<input class="est-input" data-est-input="' + esc(t.id) + '" value="' + esc(fmt(t.estMin)) + '" aria-label="Estimate for ' + esc(t.title) + '">'
      : '<button type="button" class="est' + (t.estGuess ? ' is-guess' : '') + '" data-est="' + esc(t.id) + '" title="' + (t.estGuess ? 'Tempo’s guess. Click to change.' : 'Click to change the estimate') + '">' + fmtEst(t) + '</button>';
    return '<li class="' + cls.join(' ') + '" data-id="' + esc(t.id) + '"' + (canDrag ? ' draggable="true"' : '') + '>' +
      '<span class="grip" aria-hidden="true">' + (canDrag ? ICON.grip : '') + '</span>' +
      '<input type="checkbox" class="check" aria-label="Mark “' + esc(t.title) + '” done"' + (t.done ? ' checked' : '') + (t.carried ? ' disabled' : '') + '>' +
      '<div class="task-main"><button type="button" class="task-title">' + esc(t.title) + '</button>' +
      '<div class="task-meta">' + meta.join('') + '</div></div>' +
      '<div class="task-time"><span class="logged" data-live="' + esc(t.id) + '">' + (lg >= 0.5 || running ? fmt(lg) : '–') + '</span> / ' + est +
      '<span class="task-bar' + (t.estMin > 0 && lg > t.estMin ? ' is-overrun' : '') + '"><i style="width:' + (progress * 100).toFixed(1) + '%"></i></span></div>' +
      '<div class="task-btns">' +
      (canDrag ?
        '<button type="button" class="icon-btn play" aria-label="' + (running ? 'Pause timer' : 'Start timer') + '" title="' + (running ? 'Pause' : 'Start timer') + '">' + (running ? ICON.pause : ICON.play) + '</button>' +
        '<button type="button" class="icon-btn focus-btn" aria-label="Focus mode" title="Focus mode">' + ICON.focus + '</button>' : '') +
      '</div></li>';
  }

  function renderGroups(p, m) {
    var box = $('#groups'), empty = $('#empty'), note = $('#nofit-note'), more = $('#show-done');
    if (!box) return;
    var q = ui.search.trim().toLowerCase();
    var match = function (t) { return !q || (t.title + ' ' + t.category + ' ' + t.notes).toLowerCase().indexOf(q) >= 0; };
    var closedCount = 0;
    var visible = m.tasks.filter(function (t) {
      var closed = t.done || t.carried;
      if (closed && match(t)) closedCount++;
      if (ui.filter === 'open' && closed) return false;
      if (ui.filter === 'done' && !closed) return false;
      return match(t);
    });

    var groups = {};
    visible.forEach(function (t) { (groups[t.category] || (groups[t.category] = [])).push(t); });
    var cats = Object.keys(groups).sort(catOrder);
    box.innerHTML = cats.map(function (cat) {
      var list = groups[cat];
      var open = sortTasks(list.filter(function (t) { return !t.done && !t.carried; }));
      var closed = list.filter(function (t) { return t.done || t.carried; }).sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
      var left = open.reduce(function (s, t) { return s + remainingMin(t); }, 0);
      var count = open.length ? open.length + ' to do' : closed.length + ' done';
      return '<section class="cat-group" data-cat="' + esc(cat) + '" style="--cat:' + catColor(cat) + '">' +
        '<header class="cat-head"><h2 class="cat-name">' + esc(cat) + '</h2><span class="cat-count">' + count + '</span>' +
        (open.length ? '<span class="cat-time">' + fmt(left) + '</span>' : '') + '</header>' +
        '<ol class="tasks">' + open.concat(closed).map(function (t) { return taskHTML(t, m, p); }).join('') + '</ol></section>';
    }).join('');

    if (more) {
      more.hidden = !(ui.filter === 'open' && closedCount);
      more.textContent = 'Show ' + closedCount + ' done';
    }
    if (note) {
      note.hidden = !m.cutCount || ui.filter === 'done';
      note.textContent = m.cutCount + (m.cutCount === 1 ? ' task' : ' tasks') + ' (' + fmt(m.cutMin) + ') won’t fit in the time left';
    }
    if (empty) {
      empty.hidden = visible.length > 0;
      if (!visible.length) {
        if (q) empty.innerHTML = '<b>No matches</b>Try a different search.';
        else if (ui.filter === 'done') empty.innerHTML = '<b>Nothing finished yet</b>Check off a task and it shows up here.';
        else if (m.tasks.length) empty.innerHTML = '<b>All clear</b>Everything here is done. Nice work.';
        else if (isSession(p)) empty.innerHTML = '<b>An empty session</b>Tell Tempo what you’re going to work on, and it’ll estimate how long it takes.';
        else empty.innerHTML = '<b>Nothing here yet</b>Tell Tempo what you need to do above, the way you’d say it.';
      }
    }
    // Newly added tasks: bring the first one into view, then let the highlight fade.
    var fresh = $('.task.is-new', box);
    if (fresh && ui.scrollToNew) {
      ui.scrollToNew = false;
      try { fresh.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { fresh.scrollIntoView(); }
    }
  }

  // Once a second while a timer runs: update the numbers, not the whole page.
  function tick() {
    if (!state.running) return;
    var t = taskById(state.running.taskId);
    if (!t) { state.running = null; save(); return; }
    $$('[data-live="' + CSS.escape(t.id) + '"]').forEach(function (el) { el.textContent = fmt(loggedMin(t)); });
    var p = activePeriod();
    if (p) renderClock(p, metrics(p));
    document.title = '▶ ' + fmtClock(loggedMs(t)) + ' · ' + t.title;
    if (ui.focusId) renderFocus();
    // Say so once when a task runs past its estimate.
    if (t.estMin > 0 && loggedMin(t) >= t.estMin && !ui.warned[t.id]) {
      ui.warned[t.id] = true;
      notify('Estimate reached', '“' + t.title + '” has hit its ' + fmt(t.estMin) + ' estimate.');
    }
  }

  // ---------- Theme ----------
  function effectiveTheme() {
    var mode = state.settings.theme;
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function applyTheme() {
    var mode = state.settings.theme;
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
    syncMiniTheme();
    var btn = $('#theme-btn'), dark = effectiveTheme() === 'dark';
    if (btn) {
      btn.innerHTML = dark ? ICON.sun : ICON.moon;
      btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      btn.title = (dark ? 'Light mode' : 'Dark mode') + ' (t)';
    }
    var meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#131311' : '#f4f1ea');
    var sys = $('[data-action="system-theme"]');
    if (sys) sys.hidden = mode !== 'light' && mode !== 'dark';
  }
  function cycleTheme() {
    state.settings.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
    save({ quiet: true }); applyTheme();
    if (mini.canvas) render();
    toast(state.settings.theme === 'dark' ? 'Dark mode' : 'Light mode');
  }

  // ---------- Toast ----------
  var toastTimer = null;
  function toast(msg, actionLabel, action) {
    var el = $('#toast');
    if (!el) return;
    el.innerHTML = '<span>' + esc(msg) + '</span>' + (actionLabel ? '<button type="button">' + esc(actionLabel) + '</button>' : '');
    el.classList.add('is-on');
    var b = $('button', el);
    if (b && action) b.addEventListener('click', function () { action(); el.classList.remove('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, actionLabel ? 6000 : 3200);
  }

  // ---------- Timer ----------
  var TITLE = document.title;
  function stopTimer() {
    if (!state.running) return;
    var t = taskById(state.running.taskId), now = Date.now();
    if (t && now - state.running.start >= 1000) t.logs.push({ start: state.running.start, end: now });
    state.running = null;
    document.title = TITLE;
  }
  function startTimer(id) {
    if (state.running && state.running.taskId === id) return;
    stopTimer();
    state.running = { taskId: id, start: Date.now() };
  }
  function toggleTimer(id) {
    if (state.running && state.running.taskId === id) stopTimer(); else startTimer(id);
    save(); render();
  }

  // ---------- Adding tasks (editable preview) ----------
  // The preview is re-parsed as you type; your edits to a row (title, estimate, category,
  // skip/keep) are remembered by that row's original wording, so typing more doesn't undo them.
  function previewKey(t, i) { return (t.title || '').toLowerCase() + '|' + i; }

  function buildPreview() {
    var input = $('#dump-input');
    var text = input ? input.value : '';
    var items = text.trim() ? TP.parseDump(text, parseCtx()) : [];
    var keys = {};
    ui.preview = items.map(function (t, i) {
      var key = previewKey(t, i);
      keys[key] = true;
      var e = ui.edits[key] || {};
      var row = Object.assign({}, t, { key: key });
      if (e.title != null) row.title = e.title;
      if (e.estMin != null) { row.estMin = e.estMin; row.estGuess = false; }
      if (e.category) { row.category = e.category; row.catAuto = false; row.catEdited = true; }
      row.include = e.include != null ? e.include : !(t.skip || t.dup);
      return row;
    });
    Object.keys(ui.edits).forEach(function (k) { if (!keys[k]) delete ui.edits[k]; });
  }

  function renderPreview() {
    var box = $('#dump-preview');
    if (!box) return;
    buildPreview();
    var cats = allCategories();
    box.innerHTML = ui.preview.map(function (t) {
      var meta = [];
      if (t.priority !== 'med') meta.push(PRI_LABEL[t.priority]);
      if (t.due) meta.push('due ' + fmtShortDate(t.due));
      var skipped = !t.include;
      var why = t.reason ? '<span class="pv-why">' + esc(t.reason) + '</span>' : '';
      return '<li class="pv-row' + (skipped ? ' is-skip' : '') + '" data-key="' + esc(t.key) + '" style="--cat:' + catColor(t.category) + '">' +
        '<label class="pv-cat"><span class="sr-only">Category</span><select data-pv="cat">' +
        cats.map(function (c) { return '<option' + (c === t.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
        '<option value="__new">New category…</option></select></label>' +
        '<input class="pv-title" data-pv="title" value="' + esc(t.title) + '" aria-label="Task name">' +
        '<input class="pv-est' + (t.estGuess ? ' is-guess' : '') + '" data-pv="est" value="' + esc((t.estGuess ? '~' : '') + fmt(t.estMin)) + '" aria-label="Estimate" title="' + (t.estGuess ? (t.estSource === 'history' ? 'Based on how long similar tasks took you' : 'Tempo’s guess') : 'You said') + '">' +
        (meta.length ? '<span class="pv-meta">' + esc(meta.join(' · ')) + '</span>' : '') +
        (skipped ? why + '<button type="button" class="pv-btn" data-pv="keep">Add anyway</button>'
                 : '<button type="button" class="pv-x" data-pv="drop" aria-label="Don’t add this">×</button>') +
        '</li>';
    }).join('');
    updateAddButton();
  }

  function updateAddButton() {
    var n = ui.preview.filter(function (t) { return t.include; }).length;
    var total = ui.preview.filter(function (t) { return t.include; }).reduce(function (s, t) { return s + t.estMin; }, 0);
    var btn = $('#dump-submit');
    if (btn) btn.textContent = n > 1 ? 'Add ' + n : n === 1 ? 'Add' : 'Sort it';
    var sum = $('#dump-sum');
    if (sum) {
      sum.hidden = n < 2;
      var p = activePeriod();
      var breaks = p && isSession(p) && p.breaks ? TP.breaksFor(total) : 0;
      sum.textContent = n + ' tasks · ' + fmt(total) + (breaks ? ' + ' + fmt(breaks) + ' breaks' : '') + ' in all';
    }
  }

  function editPreview(key, patch) {
    ui.edits[key] = Object.assign(ui.edits[key] || {}, patch);
  }

  function addTasks(items) {
    var p = activePeriod();
    if (!p || !items.length) return [];
    // In a session tied to a week, new tasks live on the week and are linked to the session.
    var home = isSession(p) && p.parentId && periodById(p.parentId) ? p.parentId : p.id;
    var order = state.tasks.reduce(function (mx, t) { return Math.max(mx, t.order); }, 0);
    var added = items.map(function (q) {
      var t = normalizeTask({
        id: uid(), periodId: home, title: q.title, estMin: q.estMin, estGuess: q.estGuess,
        priority: q.priority, due: q.due, category: q.category, order: ++order
      });
      state.tasks.push(t);
      if (home !== p.id) p.linkIds.push(t.id);
      if (!q.catAuto || q.catEdited) learn(t.title, t.category);
      return t;
    });
    ui.flash = {};
    added.forEach(function (t) { ui.flash[t.id] = true; });
    ui.scrollToNew = true;
    setTimeout(function () { ui.flash = {}; }, 2400);
    save(); render();
    return added;
  }

  function submitDump() {
    var input = $('#dump-input');
    if (!input) return;
    buildPreview();
    var items = ui.preview.filter(function (t) { return t.include && t.title.trim(); });
    if (!items.length) { toast(ui.preview.length ? 'Nothing to add. Use “Add anyway” on a row to keep it.' : 'Type a task or two first'); return; }
    var added = addTasks(items);
    input.value = '';
    ui.edits = {};
    autoGrow(input);
    renderPreview();
    var cats = {};
    added.forEach(function (t) { cats[t.category] = true; });
    var n = added.length, nc = Object.keys(cats).length;
    var p = activePeriod(), m = p && metrics(p);
    var nofit = m ? added.filter(function (t) { return m.cutIds[t.id]; }).length : 0;
    toast('Added ' + n + (n === 1 ? ' task' : ' tasks') + ' to ' + nc + (nc === 1 ? ' category' : ' categories') +
      (nofit ? ' · ' + nofit + ' won’t fit' : ''), 'Undo', function () {
      var ids = {};
      added.forEach(function (t) { ids[t.id] = true; });
      state.tasks = state.tasks.filter(function (t) { return !ids[t.id]; });
      state.periods.forEach(function (x) { x.linkIds = x.linkIds.filter(function (id) { return !ids[id]; }); });
      save(); render();
    });
  }

  function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 260) + 'px'; }

  function setDone(id, done) {
    var t = taskById(id);
    if (!t) return;
    if (done && isRunning(t)) stopTimer();
    t.done = done;
    t.doneAt = done ? Date.now() : null;
    save(); render();
    if (done) toast('Done: ' + t.title, 'Undo', function () { setDone(id, false); });
  }

  function deleteTask(id) {
    var idx = state.tasks.findIndex(function (t) { return t.id === id; });
    if (idx < 0) return;
    var removed = state.tasks[idx];
    var linkedIn = state.periods.filter(function (x) { return x.linkIds.indexOf(id) >= 0; });
    if (isRunning(removed)) state.running = null;
    state.tasks.splice(idx, 1);
    linkedIn.forEach(function (x) { x.linkIds = x.linkIds.filter(function (l) { return l !== id; }); });
    save(); render();
    toast('Deleted: ' + removed.title, 'Undo', function () {
      delete state.deleted[id];
      state.tasks.splice(Math.min(idx, state.tasks.length), 0, removed);
      linkedIn.forEach(function (x) { x.linkIds.push(id); });
      save(); render();
    });
  }

  function setEstimate(id, value) {
    var t = taskById(id), v = parseDuration(value);
    ui.estEditing = null;
    if (t && v != null && v > 0) { t.estMin = v; t.estGuess = false; save(); }
    render();
  }

  function openTaskDialog(id) {
    var t = taskById(id), dlg = $('#task-dialog'), f = $('#task-form');
    if (!t || !dlg || !f) return;
    ui.editingTaskId = id;
    f.title.value = t.title;
    f.est.value = fmt(t.estMin);
    f.est.dataset.orig = f.est.value;
    f.logged.value = fmt(loggedMin(t));
    f.logged.dataset.orig = f.logged.value;
    f.priority.value = t.priority;
    f.due.value = t.due || '';
    f.category.value = t.category;
    f.notes.value = t.notes || '';
    setText('#task-est-hint', t.estGuess ? 'This is Tempo’s guess. Change it if you know better.' : '');
    var dl = $('#cat-list');
    if (dl) dl.innerHTML = allCategories().map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
    dlg.showModal();
  }

  function saveTaskDialog() {
    var t = taskById(ui.editingTaskId), f = $('#task-form');
    if (!t || !f) return;
    var est = parseDuration(f.est.value);
    t.title = f.title.value.trim() || t.title;
    if (est != null && f.est.value.trim() !== f.est.dataset.orig) { t.estMin = est; t.estGuess = false; }
    t.priority = f.priority.value;
    t.due = f.due.value;
    t.notes = f.notes.value.trim();
    var cat = catName(f.category.value) || 'Other';
    if (cat !== t.category) { t.category = cat; learn(t.title, cat); }
    // A hand-edited logged time replaces the log with one entry of that length.
    if (f.logged.value.trim() !== f.logged.dataset.orig) {
      var lg = parseDuration(f.logged.value);
      if (lg != null) {
        if (isRunning(t)) state.running = null;
        var end = Date.now();
        t.logs = lg > 0 ? [{ start: end - lg * 60000, end: end }] : [];
        t.logsResetAt = lg > 0 ? end - lg * 60000 : end;
      }
    }
    save(); render();
  }

  // ---------- Drag between and within categories ----------
  var dragId = null;
  function clearDropMarks() {
    $$('.drop-above, .drop-below, .drop-into').forEach(function (el) { el.classList.remove('drop-above', 'drop-below', 'drop-into'); });
  }
  function onDragStart(e) {
    var li = e.target.closest && e.target.closest('.task[draggable]');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('is-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); }
  }
  function onDragOver(e) {
    if (!dragId) return;
    var li = e.target.closest('.task[draggable]'), group = e.target.closest('.cat-group');
    if (!group) return;
    e.preventDefault();
    clearDropMarks();
    if (li && li.dataset.id !== dragId) {
      var r = li.getBoundingClientRect();
      li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-above' : 'drop-below');
    } else if (!li) group.classList.add('drop-into');
  }
  function onDrop(e) {
    if (!dragId) return;
    e.preventDefault();
    var p = activePeriod(), moved = taskById(dragId);
    var li = e.target.closest('.task[draggable]'), group = e.target.closest('.cat-group');
    if (p && moved && group) {
      var ordered = openTasks(p).filter(function (t) { return t.id !== dragId; });
      var newCat = group.dataset.cat;
      if (li && li.dataset.id !== dragId) {
        var target = taskById(li.dataset.id);
        ordered.splice(ordered.indexOf(target) + (li.classList.contains('drop-above') ? 0 : 1), 0, moved);
        if (moved.priority !== target.priority) moved.priority = target.priority;
      } else ordered.push(moved);
      ordered.forEach(function (t, i) { t.order = i + 1; });
      if (newCat && newCat !== moved.category) {
        moved.category = newCat;
        learn(moved.title, newCat);
        toast('Moved to ' + newCat + '. Tempo will remember that.');
      }
      save();
    }
    onDragEnd();
    render();
  }
  function onDragEnd() {
    dragId = null;
    clearDropMarks();
    $$('.is-dragging').forEach(function (el) { el.classList.remove('is-dragging'); });
  }

  // ---------- Weeks ----------
  function currentWeek() {
    var p = activePeriod();
    if (p && !isSession(p) && !p.closed) return p;
    if (p && isSession(p) && p.parentId) { var w = periodById(p.parentId); if (w && !w.closed) return w; }
    var weeks = state.periods.filter(function (x) { return !isSession(x) && !x.closed; });
    return weeks.length ? weeks[weeks.length - 1] : null;
  }

  function openPeriodDialog(mode) {
    var dlg = $('#period-dialog'), f = $('#period-form');
    if (!dlg || !f) return;
    var p = mode === 'edit' ? activePeriod() : null;
    if (p && isSession(p)) { openSessionDialog(p); return; }
    ui.editingPeriodId = p ? p.id : null;
    setText('#period-dialog-title', p ? 'Edit week' : 'Plan a week');
    if (p) {
      f.name.value = p.name; f.start.value = p.start; f.end.value = p.end; f.budget.value = fmt(p.budgetMin);
    } else {
      var t = today();
      f.name.value = state.periods.some(function (x) { return !isSession(x); }) ? '' : 'This week';
      f.start.value = iso(t);
      f.end.value = iso(addDays(t, 6));
      f.budget.value = '20h';
    }
    dlg.showModal();
  }

  function readPeriodForm(f) {
    var budget = parseDuration(f.budget.value);
    if (budget == null || budget <= 0) { toast('Enter the budget as hours, e.g. 20h or 12.5'); return null; }
    if (f.end.value < f.start.value) { toast('The week has to end on or after its start'); return null; }
    return { name: f.name.value.trim() || 'Untitled week', start: f.start.value, end: f.end.value, budgetMin: budget };
  }

  function savePeriodDialog() {
    var f = $('#period-form');
    var data = f && readPeriodForm(f);
    if (!data) return false;
    var p = ui.editingPeriodId && periodById(ui.editingPeriodId);
    if (p) Object.assign(p, data);
    else {
      p = normalizePeriod(Object.assign({ id: uid(), kind: 'week', closed: false }, data));
      state.periods.push(p);
      state.activePeriodId = p.id;
    }
    save(); render();
    if (!ui.editingPeriodId) setTimeout(function () { var i = $('#dump-input'); if (i) i.focus(); }, 50);
    return true;
  }

  function openCloseDialog() {
    var p = activePeriod();
    if (!p) return;
    if (isSession(p)) { openEndSessionDialog(p); return; }
    var dlg = $('#close-dialog'), f = $('#close-form');
    if (!dlg || !f) return;
    stopTimer();
    var m = metrics(p);
    var estDone = 0, actDone = 0;
    m.tasks.forEach(function (t) { if (t.done) { estDone += t.estMin; actDone += loggedMin(t); } });
    var logged = m.tasks.reduce(function (s, t) { return s + loggedMin(t); }, 0);
    setText('#close-name', p.name);
    var recap = $('#recap');
    if (recap) recap.innerHTML =
      '<div><dt>Finished</dt><dd>' + m.done + ' / ' + (m.done + m.open) + '</dd></div>' +
      '<div><dt>Time logged</dt><dd>' + fmt(logged) + ' / ' + fmt(m.budget) + '</dd></div>' +
      '<div><dt>Still open</dt><dd>' + m.open + ' · ' + fmt(m.remaining) + '</dd></div>' +
      '<div><dt>Estimated → actual</dt><dd>' + (actDone >= 1 ? fmt(estDone) + ' → ' + fmt(actDone) : '–') + '</dd></div>';
    setText('#recap-note', accuracyNote(estDone, actDone, 'next week’s'));
    var len = daysBetween(parseISO(p.start), parseISO(p.end));
    var ns = addDays(parseISO(p.end), 1);
    f.name.value = /week/i.test(p.name) ? 'Week of ' + ns.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    f.start.value = iso(ns);
    f.end.value = iso(addDays(ns, len));
    f.budget.value = fmt(p.budgetMin);
    f.carry.checked = m.open > 0;
    f.carry.disabled = m.open === 0;
    setText('#carry-label', m.open ? 'Carry over ' + m.open + ' unfinished task' + (m.open === 1 ? '' : 's') + ' (' + fmt(m.remaining) + ' left)' : 'No unfinished tasks to carry over');
    save(); render();
    dlg.showModal();
  }

  function accuracyNote(est, act, whose) {
    if (!(act >= 1 && est > 0)) return '';
    var d = Math.round((act / est - 1) * 100);
    return Math.abs(d) <= 10 ? 'Your estimates were within 10%.' :
      d > 0 ? 'Finished tasks took ' + d + '% longer than estimated. Tempo will pad ' + whose + ' guesses to match.' :
      'Finished tasks took ' + Math.abs(d) + '% less time than estimated.';
  }

  function saveCloseDialog() {
    var p = activePeriod(), f = $('#close-form');
    var data = p && f && readPeriodForm(f);
    if (!data) return false;
    var np = normalizePeriod(Object.assign({ id: uid(), kind: 'week', closed: false }, data));
    p.closed = true;
    state.periods.push(np);
    if (f.carry.checked) {
      var i = 0;
      openTasks(p).forEach(function (t) {
        t.carried = true;
        state.tasks.push(normalizeTask({
          id: uid(), periodId: np.id, title: t.title, estMin: Math.max(Math.round(remainingMin(t)), 15),
          priority: t.priority, due: t.due, category: t.category, notes: t.notes, order: ++i
        }));
      });
    }
    state.activePeriodId = np.id;
    save(); render();
    toast('Started ' + np.name);
    return true;
  }

  // ---------- Study sessions ----------
  function openSessionDialog(editing) {
    var dlg = $('#session-dialog'), f = $('#session-form');
    if (!dlg || !f) return;
    ui.editingPeriodId = editing ? editing.id : null;
    setText('#session-dialog-title', editing ? 'Edit session' : 'Start a study session');
    f.name.value = editing ? editing.name : 'Study session';
    f.length.value = '';
    f.until.value = '';
    if (editing && editing.budgetMin != null) {
      var endAt = new Date(editing.startedAt + editing.budgetMin * 60000);
      f.until.value = pad(endAt.getHours()) + ':' + pad(endAt.getMinutes());
    }
    setText('#session-now', editing ? ' · started ' + fmtTime(editing.startedAt) : ' · ' + fmtTime(Date.now()));
    f.breaks.checked = editing ? editing.breaks : true;
    var week = editing ? null : currentWeek();
    var pickBox = $('#session-pick'), srcBox = $('#session-source');
    if (srcBox) srcBox.hidden = !week;
    if (week) {
      setText('#session-week-name', week.name);
      f.source.value = 'week';
      var soon = iso(addDays(today(), 2)), budget = 0;
      // Pre-tick what matters most: high priority or due within two days, up to about 4 hours.
      var list = openTasks(week);
      pickBox.innerHTML = list.length ? list.map(function (t) {
        var pick = (t.priority === 'high' || (t.due && t.due <= soon)) && budget + remainingMin(t) <= 240;
        if (pick) budget += remainingMin(t);
        return '<label class="pick"><input type="checkbox" name="pick" value="' + esc(t.id) + '"' + (pick ? ' checked' : '') + '>' +
          '<span class="pick-title">' + esc(t.title) + '</span><span class="pick-meta">' + esc(t.category) + ' · ' + fmt(remainingMin(t)) + (t.due ? ' · due ' + esc(fmtShortDate(t.due)) : '') + '</span></label>';
      }).join('') : '<p class="hint">No open tasks in ' + esc(week.name) + '.</p>';
    } else if (pickBox) pickBox.innerHTML = '';
    ui.sessionWeek = week ? week.id : null;
    updateSessionSummary();
    dlg.showModal();
  }

  // The session's planned length in minutes from `from`: an "ends at" time wins, then a
  // length ("2h", or "until 6pm" typed there), else null (Tempo estimates). Returns
  // { min, endAt } or { error } for something unreadable.
  function sessionEnd(f, from) {
    var until = f.until.value, len = f.length.value.trim();
    if (until) {
      var at = TP.parseEndTime(until, from, true);
      return at ? { min: (at - from) / 60000, endAt: at } : { error: 'Pick the time the session ends' };
    }
    if (!len) return { min: null };
    var end = /[ap]\.?m\.?$|^(until|till|til|to|by)\b/i.test(len) ? TP.parseEndTime(len, from) : null;
    if (end) return { min: (end - from) / 60000, endAt: end };
    var d = parseDuration(len);
    if (d == null || d <= 0) return { error: 'Enter an end time, or how long you have (e.g. 2h or 90m). Or leave both blank.' };
    return { min: d, endAt: from + d * 60000 };
  }

  function sessionPicks() {
    var f = $('#session-form');
    if (!f || !ui.sessionWeek || f.source.value !== 'week') return [];
    return $$('input[name="pick"]:checked', f).map(function (i) { return taskById(i.value); }).filter(Boolean);
  }

  function updateSessionSummary() {
    var f = $('#session-form');
    if (!f) return;
    var weekMode = ui.sessionWeek && f.source.value === 'week';
    var pickBox = $('#session-pick');
    if (pickBox) pickBox.hidden = !weekMode;
    var picks = sessionPicks();
    var work = picks.reduce(function (s, t) { return s + remainingMin(t); }, 0);
    var breaks = f.breaks.checked ? TP.breaksFor(work) : 0;
    var editing = ui.editingPeriodId && periodById(ui.editingPeriodId);
    var from = editing ? editing.startedAt : Date.now();
    var end = sessionEnd(f, from), len = end.min;
    var span = end.endAt ? 'Now → ' + fmtTime(end.endAt) + (new Date(end.endAt).getDate() !== new Date(from).getDate() ? ' tomorrow' : '') + ' · ' + fmt(len) + '. ' : '';
    if (editing) span = end.endAt ? 'Ends ' + fmtTime(end.endAt) + ' · ' + fmt(len) + ' in all. ' : '';
    var out;
    if (end.error) out = end.error;
    else if (editing) out = span;
    else if (!picks.length) out = span + (len ? 'Add tasks after you start and Tempo shows if they fit.' : 'Add tasks after you start. Tempo estimates how long the session will take.');
    else {
      out = span + picks.length + (picks.length === 1 ? ' task' : ' tasks') + ' · ' + fmt(work) + ' work' + (breaks ? ' + ' + fmt(breaks) + ' breaks' : '');
      if (!len) out += ' ≈ done by ' + fmtTime(Date.now() + (work + breaks) * 60000);
      else if (work + breaks > len) out += ' · that’s ' + fmt(work + breaks - len) + ' more than you have';
      else out += ' · fits, with ' + fmt(len - work - breaks) + ' to spare';
    }
    setText('#session-sum', out);
  }

  function saveSessionDialog() {
    var f = $('#session-form');
    if (!f) return false;
    var editing = ui.editingPeriodId && periodById(ui.editingPeriodId);
    var end = sessionEnd(f, editing ? editing.startedAt : Date.now());
    if (end.error) { toast(end.error); return false; }
    var len = end.min;
    if (editing) {
      editing.name = f.name.value.trim() || 'Study session';
      editing.budgetMin = len;
      editing.breaks = f.breaks.checked;
      save(); render();
      return true;
    }
    stopTimer();
    var picks = sessionPicks(), now = Date.now();
    if (end.endAt) len = (end.endAt - now) / 60000;   // count from the moment it actually starts
    var s = normalizePeriod({
      id: uid(), kind: 'session', name: f.name.value.trim() || 'Study session', start: iso(today()), end: iso(today()),
      budgetMin: len, breaks: f.breaks.checked, startedAt: now, closed: false,
      parentId: ui.sessionWeek && f.source.value === 'week' ? ui.sessionWeek : null,
      linkIds: picks.map(function (t) { return t.id; })
    });
    state.periods.push(s);
    state.activePeriodId = s.id;
    save(); render();
    toast((picks.length ? 'Session started with ' + picks.length + (picks.length === 1 ? ' task' : ' tasks') : 'Session started') + (end.endAt ? ' · until ' + fmtTime(end.endAt) : '') + (picks.length ? '' : '. Tell Tempo what you’ll work on.'));
    setTimeout(function () { var i = $('#dump-input'); if (i && !picks.length) i.focus(); }, 50);
    return true;
  }

  function openEndSessionDialog(p) {
    var dlg = $('#end-dialog');
    if (!dlg) return;
    stopTimer(); save();
    var m = metrics(p), since = p.startedAt || 0;
    var estDone = 0, actDone = 0;
    m.tasks.forEach(function (t) { if (t.done && (t.doneAt || 0) >= since) { estDone += t.estMin; actDone += loggedMin(t); } });
    setText('#end-name', p.name);
    var recap = $('#end-recap');
    if (recap) recap.innerHTML =
      '<div><dt>Worked</dt><dd>' + fmt(m.used) + '</dd></div>' +
      '<div><dt>Session length</dt><dd>' + fmt((Date.now() - since) / 60000) + '</dd></div>' +
      '<div><dt>Finished</dt><dd>' + m.done + ' / ' + (m.done + m.open) + '</dd></div>' +
      '<div><dt>Estimated → actual</dt><dd>' + (actDone >= 1 ? fmt(estDone) + ' → ' + fmt(actDone) : '–') + '</dd></div>';
    setText('#end-note', accuracyNote(estDone, actDone, 'your next'));
    var parent = periodById(p.parentId);
    var own = openTasks(p).filter(function (t) { return t.periodId === p.id; });
    var carry = $('#end-carry'), carryLabel = $('#end-carry-label');
    if (carry) {
      carry.closest('label').hidden = !own.length;
      carry.checked = !!own.length;
      if (carryLabel) carryLabel.textContent = parent
        ? 'Move ' + own.length + ' unfinished task' + (own.length === 1 ? '' : 's') + ' to ' + parent.name
        : 'Start another session later with ' + own.length + ' unfinished task' + (own.length === 1 ? '' : 's');
    }
    setText('#end-linked', parent && m.open - own.length > 0 ? (m.open - own.length) + ' unfinished task' + (m.open - own.length === 1 ? ' stays' : 's stay') + ' on ' + parent.name + '.' : '');
    dlg.showModal();
  }

  function endSession() {
    var p = activePeriod();
    if (!p || !isSession(p)) return;
    var parent = periodById(p.parentId);
    var carry = $('#end-carry');
    var own = openTasks(p).filter(function (t) { return t.periodId === p.id; });
    p.closed = true;
    p.endedAt = Date.now();
    if (carry && carry.checked && own.length) {
      if (parent) own.forEach(function (t) { t.periodId = parent.id; });
      else {
        // Standalone: park them in a fresh session that starts when you open it.
        var next = normalizePeriod({ id: uid(), kind: 'session', name: 'Next session', start: iso(today()), end: iso(today()),
          budgetMin: null, breaks: p.breaks, startedAt: Date.now(), closed: false });
        state.periods.push(next);
        own.forEach(function (t) { t.periodId = next.id; });
      }
    }
    var back = parent && !parent.closed ? parent : currentWeek();
    state.activePeriodId = back ? back.id : p.id;
    save(); render();
    toast('Session ended · ' + fmt(metrics(p).used) + ' worked');
  }

  // ---------- Pop-out mini timer ----------
  var mini = { win: null, video: null, canvas: null };
  var MINI_HTML =
    '<div class="mini" id="mini">' +
      '<svg class="mini-chrono" id="mini-chrono" viewBox="0 0 220 220" aria-hidden="true"></svg>' +
      '<div class="mini-side">' +
        '<span class="now-label" data-m="state"></span>' +
        '<span class="mini-title" data-m="title"></span>' +
        '<span class="mini-meta" data-m="meta"></span>' +
        '<div class="mini-btns">' +
          '<button type="button" class="btn btn-primary btn-sm" data-mini="toggle"></button>' +
          '<button type="button" class="btn btn-sm" data-mini="done">Done</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  function miniCanPop() {
    return !!(window.documentPictureInPicture || (document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream));
  }
  function togglePopout() {
    if (mini.win) { mini.win.close(); return; }
    if (mini.video && document.pictureInPictureElement) { document.exitPictureInPicture(); return; }
    if (window.documentPictureInPicture) openDocPip();
    else if (document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream) openVideoPip();
    else toast('This browser can’t pop out a floating timer. Try Chrome or Edge.');
  }
  function openDocPip() {
    window.documentPictureInPicture.requestWindow({ width: 380, height: 190 }).then(function (win) {
      setupMiniWindow(win);
      win.addEventListener('pagehide', function () { mini.win = null; mini.chrono = null; updatePopBtn(); });
    }).catch(function () { toast('Couldn’t open the floating timer'); });
  }
  function setupMiniWindow(win) {
    mini.win = win;
    var doc = win.document;
    $$('link[rel="stylesheet"], style').forEach(function (el) { doc.head.appendChild(el.cloneNode(true)); });
    doc.title = 'Tempo';
    doc.body.className = 'mini-body';
    doc.body.innerHTML = MINI_HTML;
    mini.chrono = buildChrono(doc.getElementById('mini-chrono'));
    syncMiniTheme();
    doc.addEventListener('click', function (e) { var b = e.target.closest('[data-mini]'); if (b) miniAction(b.dataset.mini); });
    doc.addEventListener('keydown', function (e) { if (e.key === ' ') { e.preventDefault(); miniAction('toggle'); } });
    updatePopBtn();
    render();
  }
  function openVideoPip() {
    if (!mini.canvas) {
      mini.canvas = document.createElement('canvas');
      mini.canvas.width = 640; mini.canvas.height = 300;
      mini.video = document.createElement('video');
      mini.video.muted = true; mini.video.playsInline = true;
      mini.video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;left:0';
      document.body.appendChild(mini.video);
      mini.video.srcObject = mini.canvas.captureStream(4);
      mini.video.addEventListener('leavepictureinpicture', function () { updatePopBtn(); });
      var viaSession = false;
      try {
        navigator.mediaSession.setActionHandler('play', function () { miniAction('toggle'); });
        navigator.mediaSession.setActionHandler('pause', function () { miniAction('toggle'); });
        viaSession = true;
      } catch (e) { /* fall back to the video's own pause event */ }
      if (!viaSession) mini.video.addEventListener('pause', function () {
        if (document.pictureInPictureElement === mini.video) { miniAction('toggle'); mini.video.play(); }
      });
    }
    render();
    mini.video.play().then(function () { return mini.video.requestPictureInPicture(); })
      .then(function () { updatePopBtn(); })
      .catch(function () { toast('Couldn’t open the floating timer'); });
  }
  function miniAction(action) {
    var p = activePeriod(), cur = p && currentTask(p);
    if (!cur) { toast('No open tasks'); return; }
    if (action === 'toggle') toggleTimer(cur.task.id);
    else if (action === 'done') setDone(cur.task.id, true);
  }
  function syncMiniTheme() {
    if (!mini.win) return;
    var root = mini.win.document.documentElement, t = document.documentElement.getAttribute('data-theme');
    if (t) root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
  }
  function updatePopBtn() {
    var btn = $('#pop-btn');
    if (!btn) return;
    var open = !!mini.win || !!(mini.video && document.pictureInPictureElement === mini.video);
    btn.classList.toggle('is-on', open);
    btn.setAttribute('aria-label', open ? 'Close floating timer' : 'Pop out floating timer');
    btn.title = (open ? 'Close floating timer' : 'Pop out timer') + ' (p)';
  }
  function renderMini(p, m, cs, cur) {
    if (mini.win && mini.chrono) {
      var doc = mini.win.document;
      var q = function (k) { return doc.querySelector('[data-m="' + k + '"]'); };
      mini.chrono(cs);
      doc.getElementById('mini').classList.toggle('is-running', !!(cur && cur.running));
      q('state').textContent = cur ? (cur.running ? 'Working on' : 'Up next') : 'All clear';
      q('title').textContent = cur ? cur.task.title : 'Nothing left to do';
      q('meta').textContent = cur ? fmt(loggedMin(cur.task)) + ' of ' + fmtEst(cur.task) + ' · ' + cur.task.category : '';
      var tb = doc.querySelector('[data-mini="toggle"]'), db = doc.querySelector('[data-mini="done"]');
      tb.textContent = cur && cur.running ? 'Pause' : 'Start';
      tb.disabled = db.disabled = !cur;
    }
    if (mini.canvas) drawMiniCanvas(cs, cur);
  }
  // Safari fallback: the same chronograph, painted onto a canvas that floats as a video.
  function drawMiniCanvas(cs, cur) {
    var c = mini.canvas, x = c.getContext('2d'), st = getComputedStyle(document.documentElement);
    var tok = function (n) { return st.getPropertyValue(n).trim(); };
    var C = { face: tok('--ch-face'), ink: tok('--ch-ink'), dim: tok('--ch-dim'), accent: tok('--ch-accent'), sub: tok('--ch-sub'), bg: tok('--surface'), bad: tok('--bad') };
    var W = c.width, H = c.height, cx = 150, cy = H / 2, k = 136 / 104;
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    x.beginPath(); x.roundRect(cx - 104 * k, cy - 104 * k, 208 * k, 208 * k, SQ.radius * k); x.fillStyle = C.face; x.fill();
    var budget = Math.max(cs.budget, 1), used = Math.min(Math.max(1 - Math.max(cs.left, 0) / budget, 0), 1);
    var trace = function (upTo, color) {
      x.beginPath(); x.lineWidth = 6; x.lineCap = 'round'; x.strokeStyle = color;
      for (var i = 0; i <= 200 * upTo; i++) {
        var p = perimeterPoint(i / 200, 0, 0, TRACK.half, TRACK.radius);
        if (i === 0) x.moveTo(cx + p[0] * k, cy + p[1] * k); else x.lineTo(cx + p[0] * k, cy + p[1] * k);
      }
      x.stroke();
    };
    trace(1, C.sub);
    if (used > 0) trace(used, cs.left < 0 ? C.bad : C.accent);
    var a = (used >= 1 ? 1 : trackTurn(used, 0, 0)) * 2 * Math.PI;
    x.beginPath(); x.lineWidth = 6; x.lineCap = 'round'; x.strokeStyle = C.ink;
    x.moveTo(cx - 12 * k * Math.sin(a), cy + 12 * k * Math.cos(a)); x.lineTo(cx + 84 * k * Math.sin(a), cy - 84 * k * Math.cos(a)); x.stroke();
    x.beginPath(); x.arc(cx, cy, 7, 0, 2 * Math.PI); x.fillStyle = C.ink; x.fill();
    x.fillStyle = C.ink; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '700 30px Geist, system-ui, sans-serif';
    x.fillText(String(Math.round(budget / 60)), cx, cy - 62 * k);
    var L = Math.max(cs.left, 0), whole = Math.floor(L), ov = Math.ceil(-cs.left);
    x.textAlign = 'left'; x.fillStyle = C.ink; x.font = '500 44px "Geist Mono", monospace';
    x.fillText(cs.left < 0 ? '+' + Math.floor(ov / 3600) + ':' + pad(Math.floor(ov / 60) % 60) : Math.floor(whole / 3600) + ':' + pad(Math.floor(whole / 60) % 60) + ':' + pad(whole % 60), 310, 78);
    x.fillStyle = C.dim; x.font = '500 15px "Geist Mono", monospace';
    x.fillText(cs.left < 0 ? 'OVER BUDGET' : (cs.label || 'LEFT TO WORK'), 312, 114);
    x.fillText(cur ? (cur.running ? 'WORKING ON' : 'UP NEXT') : 'ALL CLEAR', 312, 162);
    x.fillStyle = C.ink; x.font = '500 27px Geist, system-ui, sans-serif';
    var title = cur ? cur.task.title : 'Nothing left to do';
    while (title.length > 3 && x.measureText(title).width > 310) title = title.slice(0, -2);
    if (cur && title !== cur.task.title) title = title.trim() + '…';
    x.fillText(title, 312, 196);
  }

  // ---------- Clock-only mode ----------
  // Full screen, nothing but the chronograph and the time left. Controls fade when idle,
  // and the screen is kept awake where the browser allows it.
  var cm = { chrono: null, wake: null, idle: null };
  function openClockMode() {
    var box = $('#clockmode'), p = activePeriod();
    if (!box || !p) return;
    if (!cm.chrono) cm.chrono = buildChrono($('#cm-chrono'));
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    try { if (document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().then(function () { cm.fs = true; }).catch(function () {}); } catch (e) { /* optional */ }
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { cm.wake = l; }).catch(function () {}); } catch (e) { /* optional */ }
    clockModeActivity();
    render();
  }
  function closeClockMode() {
    var box = $('#clockmode');
    if (!box || box.hidden) return;
    box.hidden = true;
    document.body.style.overflow = '';
    cm.fs = false;
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) { /* ignore */ }
    if (cm.wake) { cm.wake.release().catch(function () {}); cm.wake = null; }
    clearTimeout(cm.idle);
  }
  function clockModeOpen() { var b = $('#clockmode'); return !!b && !b.hidden; }
  function clockModeActivity() {
    var box = $('#clockmode');
    if (!box) return;
    box.classList.remove('is-idle');
    clearTimeout(cm.idle);
    cm.idle = setTimeout(function () { box.classList.add('is-idle'); }, 2500);
  }
  function renderClockMode(p, m, cs, cur) {
    if (!cm.chrono || !clockModeOpen()) return;
    cm.chrono(cs);
    var over = m.left < 0;
    var text = m.session && m.auto ? (m.open ? fmt(m.need) + ' to finish' : 'All done')
      : over ? fmt(-m.left) + ' over' : fmt(m.left) + ' left';
    setText('#cm-left', text);
    setText('#cm-now', cur ? (cur.running ? 'Working on ' : 'Up next: ') + cur.task.title : '');
    var btn = $('#cm-toggle');
    if (btn) { btn.textContent = cur && cur.running ? 'Pause' : 'Start'; btn.disabled = !cur; }
    var svg = $('#cm-chrono');
    if (svg) svg.setAttribute('aria-label', text);
  }

  // ---------- Focus mode ----------
  function openFocus(id) {
    var t = id ? taskById(id) : null;
    if (!t) { var p = activePeriod(); if (!p) return; var cur = currentTask(p); t = cur && cur.task; }
    if (!t) { toast('No open tasks to focus on'); return; }
    ui.focusId = t.id;
    var box = $('#focus');
    if (box) box.hidden = false;
    document.body.style.overflow = 'hidden';
    var pt = $('#pomo-toggle');
    if (pt) pt.checked = !!state.settings.pomodoro;
    renderFocus();
    var btn = $('#focus-toggle');
    if (btn) btn.focus();
  }
  function closeFocus() {
    ui.focusId = null;
    ui.pomo = null;
    var box = $('#focus');
    if (box) box.hidden = true;
    document.body.style.overflow = '';
    render();
  }
  function renderFocus() {
    var t = taskById(ui.focusId);
    if (!t) { closeFocus(); return; }
    var running = isRunning(t);
    var ms = loggedMs(t), min = ms / 60000;
    setText('#focus-title', t.title);
    setText('#focus-clock', fmtClock(ms));
    setText('#focus-of', t.estMin ? (min > t.estMin ? fmt(min - t.estMin) + ' over the ' + fmtEst(t) + ' estimate' : 'of ' + fmtEst(t) + ' estimated') : 'no estimate');
    var ring = $('#ring-fg');
    if (ring) {
      var frac = t.estMin ? Math.min(min / t.estMin, 1) : 0;
      ring.style.strokeDashoffset = (RING * (1 - frac)).toFixed(2);
      ring.classList.toggle('is-over', t.estMin > 0 && min > t.estMin);
    }
    var btn = $('#focus-toggle');
    if (btn) btn.textContent = running ? 'Pause' : (ui.pomo && ui.pomo.phase === 'break' ? 'Skip break' : (ms > 0 ? 'Resume' : 'Start'));
    var line = $('#pomo-line');
    if (ui.pomo && state.settings.pomodoro) {
      var left = ui.pomo.endsAt - Date.now();
      if (left <= 0) {
        chime();
        if (ui.pomo.phase === 'work') {
          stopTimer(); save();
          ui.pomo = { phase: 'break', endsAt: Date.now() + 5 * 60000 };
          notify('Break time', 'Step away for 5 minutes.');
        } else {
          ui.pomo = null;
          notify('Break’s over', 'Ready for the next round on “' + t.title + '”.');
        }
        renderFocus();
        return;
      }
      if (line) { line.hidden = false; line.textContent = (ui.pomo.phase === 'work' ? 'Focus round · ' : 'Break · ') + fmtClock(left).replace(/^0:/, '') + ' left'; }
    } else if (line) {
      line.hidden = !state.settings.pomodoro;
      line.textContent = 'Pomodoro on · press Start for a 25-minute round';
    }
  }
  function focusToggle() {
    var t = taskById(ui.focusId);
    if (!t) return;
    if (isRunning(t)) { stopTimer(); ui.pomo = null; }
    else {
      startTimer(t.id);
      if (state.settings.pomodoro) ui.pomo = { phase: 'work', endsAt: Date.now() + 25 * 60000 };
    }
    save();
    renderFocus();
  }

  var audioCtx = null;
  function chime() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [660, 880].forEach(function (f, i) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain(), t0 = audioCtx.currentTime + i * 0.18;
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0); o.stop(t0 + 0.65);
      });
    } catch (e) { /* no audio, no problem */ }
  }
  function notify(title, body) {
    toast(title + '. ' + body);
    try { if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification(title, { body: body }); } catch (e) { /* ignore */ }
  }

  // ---------- Dictation ----------
  var recog = null, listening = false, dictBase = '';
  function setupMic() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var btn = $('#mic'), input = $('#dump-input');
    if (!SR || !btn || !input) return;
    btn.hidden = false;
    btn.addEventListener('click', function () {
      if (listening) { recog.stop(); return; }
      recog = new SR();
      recog.lang = navigator.language || 'en-US';
      recog.continuous = true;
      recog.interimResults = true;
      dictBase = input.value.trim() ? input.value.trim() + '\n' : '';
      recog.onresult = function (e) {
        var text = '';
        for (var i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
        input.value = dictBase + text.trim();
        autoGrow(input);
        renderPreview();
      };
      recog.onend = function () { listening = false; btn.classList.remove('is-listening'); btn.setAttribute('aria-label', 'Dictate'); };
      recog.onerror = function (e) { if (e.error === 'not-allowed') toast('Microphone access was blocked'); };
      try {
        recog.start();
        listening = true;
        btn.classList.add('is-listening');
        btn.setAttribute('aria-label', 'Stop dictating');
        input.focus();
      } catch (err) { toast('Dictation isn’t available here'); }
    });
  }

  // ---------- Accounts & sync ----------
  function syncDoc() {
    return { periods: state.periods, tasks: state.tasks, running: state.running, runningAt: state.runningAt, learn: state.learn, deleted: state.deleted };
  }
  function applySyncedDoc(doc, info) {
    var keep = { activePeriodId: state.activePeriodId, settings: state.settings };
    var hadLocal = state.tasks.length;
    state = normalize(Object.assign({}, doc, keep));
    if (!periodById(state.activePeriodId)) {
      var o = latestOpen(state.periods);
      state.activePeriodId = o ? o.id : (state.periods.length ? state.periods[state.periods.length - 1].id : null);
    }
    resetSnap();
    save({ quiet: true });
    render();
    if (info && info.first && hadLocal) toast('Signed in. Your tasks on this device are now saved to your account.');
  }
  var SYNC_LABEL = { saving: 'Saving…', synced: 'Saved to your account', offline: 'Offline · will save when you’re back', error: 'Couldn’t save · will retry', 'signed-out': '', unavailable: '' };
  function onSyncStatus(status, user) {
    var btn = $('#account-btn'), dot = $('#sync-dot'), label = $('#account-label');
    if (btn) btn.classList.toggle('is-signed-in', !!user);
    if (label) label.textContent = user ? (user.email || 'Account').charAt(0).toUpperCase() : 'Sign in';
    if (btn) btn.setAttribute('aria-label', user ? 'Account: ' + user.email + '. ' + (SYNC_LABEL[status] || '') : 'Sign in to sync your tasks');
    if (dot) { dot.className = 'sync-dot is-' + status; dot.hidden = !user; }
    setText('#acct-email', user ? user.email : '');
    setText('#acct-status', SYNC_LABEL[status] || '');
    if (status === 'error' || status === 'offline') { clearTimeout(ui.retry); ui.retry = setTimeout(function () { if (TempoSync.user) TempoSync.pull(); }, 30000); }
  }

  function openAuth(mode) {
    var dlg = $('#auth-dialog');
    if (!dlg) return;
    if (!window.TempoSync || !TempoSync.ready) { toast('Accounts need an internet connection. Try again once you’re online.'); return; }
    setAuthMode(mode || 'signin');
    setText('#auth-msg', '');
    dlg.showModal();
  }
  function setAuthMode(mode) {
    ui.authMode = mode;
    var f = $('#auth-form');
    setText('#auth-title', mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : mode === 'newpass' ? 'Choose a new password' : 'Sign in');
    setText('#auth-lede', mode === 'signup' ? 'Your tasks will be saved to your account, so they show up on your phone and computer.' :
      mode === 'reset' ? 'We’ll email you a link to choose a new password.' : mode === 'newpass' ? 'Enter a new password for your account.' :
      'Sign in to see your tasks on every device.');
    if (f) {
      f.email.closest('.field').hidden = mode === 'newpass';
      f.password.closest('.field').hidden = mode === 'reset';
      f.password.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
      f.email.required = mode !== 'newpass';
      f.password.required = mode !== 'reset';
    }
    setText('#auth-submit', mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : mode === 'newpass' ? 'Save password' : 'Sign in');
    var sw = $('#auth-switch');
    if (sw) sw.innerHTML = mode === 'signup' ? 'Already have an account? <button type="button" data-auth="signin">Sign in</button>' :
      mode === 'signin' ? 'New here? <button type="button" data-auth="signup">Create an account</button> · <button type="button" data-auth="reset">Forgot password?</button>' :
      mode === 'reset' ? '<button type="button" data-auth="signin">Back to sign in</button>' : '';
  }
  function submitAuth() {
    var f = $('#auth-form'), msg = $('#auth-msg'), btn = $('#auth-submit');
    if (!f) return;
    var email = f.email.value.trim(), pw = f.password.value, mode = ui.authMode;
    if ((mode === 'signup' || mode === 'newpass') && pw.length < 8) { msg.textContent = 'Use at least 8 characters for your password.'; return; }
    btn.disabled = true;
    msg.textContent = '';
    var job = mode === 'signup' ? TempoSync.signUp(email, pw) : mode === 'reset' ? TempoSync.resetPassword(email) :
      mode === 'newpass' ? TempoSync.updatePassword(pw) : TempoSync.signIn(email, pw);
    job.then(function (res) {
      btn.disabled = false;
      if (res.error) { msg.textContent = friendlyAuthError(res.error); return; }
      if (mode === 'signup' && !(res.data && res.data.session)) { msg.textContent = 'Check your email to confirm your account, then sign in here.'; setAuthMode('signin'); f.password.value = ''; return; }
      if (mode === 'reset') { msg.textContent = 'If that email has an account, a reset link is on its way.'; return; }
      $('#auth-dialog').close();
      f.password.value = '';
      toast(mode === 'newpass' ? 'Password updated' : 'Signed in');
    }).catch(function () { btn.disabled = false; msg.textContent = 'Couldn’t reach the server. Check your connection and try again.'; });
  }
  function friendlyAuthError(err) {
    var m = String(err && err.message || '');
    if (/invalid login/i.test(m)) return 'That email and password don’t match. Try again or reset your password.';
    if (/already registered|already exists/i.test(m)) return 'There’s already an account with that email. Sign in instead.';
    if (/email not confirmed/i.test(m)) return 'Confirm your email first. The link is in your inbox.';
    if (/rate limit/i.test(m)) return 'Too many tries. Wait a minute and try again.';
    return m || 'Something went wrong. Try again.';
  }
  function signOut() {
    if (!confirm('Sign out? Your tasks stay in your account. This device will be cleared.')) return;
    TempoSync.signOut().then(function () {
      var theme = state.settings;
      state = blank();
      state.settings = theme;
      resetSnap();
      save({ quiet: true });
      render();
      toast('Signed out');
    });
  }

  // ---------- Backup ----------
  function exportJSON() {
    stopTimer(); save(); render();
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tempo-backup-' + iso(today()) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('Backup downloaded');
  }
  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.periods) || !Array.isArray(data.tasks)) throw new Error('shape');
        var next = normalize(data);
        if (!confirm('Replace everything here with this backup (' + next.periods.length + ' periods, ' + next.tasks.length + ' tasks)?')) return;
        var old = state;
        state = next;
        // Mark the replaced items as deleted so the account copy drops them too.
        old.tasks.concat(old.periods).forEach(function (o) { if (!next.tasks.concat(next.periods).some(function (n) { return n.id === o.id; })) state.deleted[o.id] = Date.now(); });
        save(); render();
        toast('Backup restored');
      } catch (e) { toast('That file isn’t a Tempo backup'); }
    };
    reader.readAsText(file);
  }

  function loadSample() {
    if ((state.periods.length || state.tasks.length) && !confirm('Replace your current data with sample data?')) return;
    var t = today(), now = Date.now();
    var pid = uid(), prev = uid();
    var log = function (min, daysAgo) { var end = now - daysAgo * DAY; return [{ start: end - min * 60000, end: end }]; };
    var mk = function (o, i) { return normalizeTask(Object.assign({ id: uid(), order: i + 1 }, o)); };
    var keep = { learn: state.learn, settings: state.settings, deleted: state.deleted };
    var oldIds = state.tasks.concat(state.periods).map(function (o) { return o.id; });
    state = blank();
    state.learn = keep.learn || {}; state.settings = keep.settings; state.deleted = keep.deleted || {};
    oldIds.forEach(function (id) { state.deleted[id] = now; });
    state.periods = [
      normalizePeriod({ id: prev, kind: 'week', name: 'Last week', start: iso(addDays(t, -9)), end: iso(addDays(t, -3)), budgetMin: 18 * 60, closed: true }),
      normalizePeriod({ id: pid, kind: 'week', name: 'This week', start: iso(addDays(t, -2)), end: iso(addDays(t, 4)), budgetMin: 20 * 60, closed: false })
    ];
    state.tasks = [
      mk({ periodId: prev, title: 'Physics lab report', estMin: 120, priority: 'high', category: 'School', done: true, doneAt: now - 6 * DAY, logs: log(165, 6) }, 0),
      mk({ periodId: prev, title: 'Update portfolio case study', estMin: 90, priority: 'med', category: 'Work', done: true, doneAt: now - 5 * DAY, logs: log(110, 5) }, 1),
      mk({ periodId: prev, title: 'Client call prep', estMin: 30, priority: 'med', category: 'Work', done: true, doneAt: now - 4 * DAY, logs: log(35, 4) }, 2),
      mk({ periodId: pid, title: 'Finish launch checklist for client site', estMin: 180, priority: 'high', category: 'Work', due: iso(addDays(t, 1)), logs: log(70, 1) }, 0),
      mk({ periodId: pid, title: 'AP Physics problem set 6', estMin: 120, priority: 'high', category: 'School', due: iso(addDays(t, 2)) }, 1),
      mk({ periodId: pid, title: 'Study for calc quiz', estMin: 150, priority: 'high', category: 'School', due: iso(addDays(t, 3)), notes: 'Chapters 4.1–4.4, related rates.' }, 2),
      mk({ periodId: pid, title: 'Reply to client emails', estMin: 30, priority: 'med', category: 'Work', done: true, doneAt: now - DAY, logs: log(25, 1) }, 3),
      mk({ periodId: pid, title: 'English essay draft', estMin: 240, priority: 'med', category: 'School', due: iso(addDays(t, 4)) }, 4),
      mk({ periodId: pid, title: 'Redesign pricing page', estMin: 300, priority: 'med', category: 'Work' }, 5),
      mk({ periodId: pid, title: 'Gym', estMin: 60, estGuess: true, priority: 'med', category: 'Health' }, 6),
      mk({ periodId: pid, title: 'Buy groceries', estMin: 45, estGuess: true, priority: 'med', category: 'Errands' }, 7),
      mk({ periodId: pid, title: 'Edit video reel', estMin: 180, priority: 'low', category: 'Work' }, 8),
      mk({ periodId: pid, title: 'Do laundry', estMin: 30, estGuess: true, priority: 'low', category: 'Home' }, 9),
      mk({ periodId: pid, title: 'Call grandma', estMin: 20, estGuess: true, priority: 'low', category: 'Personal' }, 10)
    ];
    state.activePeriodId = pid;
    ui.search = ''; ui.filter = 'open';
    $$('.seg-btn').forEach(function (x) { x.classList.toggle('is-on', x.dataset.filter === 'open'); });
    save(); render();
    toast('Sample week loaded');
  }

  // ---------- Events ----------
  function closeMenus() { $$('details.menu[open]').forEach(function (m) { m.open = false; }); }

  function handleAction(action) {
    closeMenus();
    if (action === 'new-period') openPeriodDialog('new');
    else if (action === 'new-session') openSessionDialog();
    else if (action === 'edit-period') {
      var p = activePeriod();
      if (p && isSession(p) && !p.closed) openEndSessionDialog(p); else if (p) openPeriodDialog('edit');
    }
    else if (action === 'edit-session') { var s = activePeriod(); if (s && isSession(s)) openSessionDialog(s); }
    else if (action === 'close-period') { if (activePeriod()) openCloseDialog(); else toast('Nothing to close'); }
    else if (action === 'clock-mode') openClockMode();
    else if (action === 'export') exportJSON();
    else if (action === 'import') { var inp = $('#import-file'); if (inp) inp.click(); }
    else if (action === 'sample') loadSample();
    else if (action === 'help') { var h = $('#help-dialog'); if (h) h.showModal(); }
    else if (action === 'signin') openAuth('signin');
    else if (action === 'signup') openAuth('signup');
    else if (action === 'signout') signOut();
    else if (action === 'sync-now') { if (window.TempoSync && TempoSync.user) TempoSync.pull(); }
    else if (action === 'show-done') { ui.filter = 'all'; $$('.seg-btn').forEach(function (x) { x.classList.toggle('is-on', x.dataset.filter === 'all'); }); render(); }
    else if (action === 'system-theme') { state.settings.theme = 'system'; save({ quiet: true }); applyTheme(); toast('Following your system theme'); }
    else if (action === 'reset') {
      if (confirm('Erase all periods and tasks? This can’t be undone. Export a backup first if you might want them.')) {
        var now = Date.now();
        state.tasks.concat(state.periods).forEach(function (o) { state.deleted[o.id] = now; });
        state.tasks = []; state.periods = []; state.activePeriodId = null; state.running = null;
        save(); render(); toast('Everything erased');
      }
    }
  }

  function bind() {
    document.addEventListener('click', function (e) {
      var a = e.target.closest('[data-action]');
      if (a) { handleAction(a.dataset.action); return; }
      var close = e.target.closest('[data-close]');
      if (close) { var d = close.closest('dialog'); if (d) d.close(); return; }
      var now = e.target.closest('[data-now]');
      if (now) { if (now.dataset.now === 'toggle') toggleTimer(now.dataset.id); else openFocus(now.dataset.id); return; }
      var au = e.target.closest('[data-auth]');
      if (au) { setAuthMode(au.dataset.auth); setText('#auth-msg', ''); return; }
      if (!e.target.closest('details.menu')) closeMenus();
    });

    var acct = $('#account-btn');
    if (acct) acct.addEventListener('click', function (e) {
      if (!(window.TempoSync && TempoSync.user)) { e.preventDefault(); openAuth('signin'); }
    });

    var popBtn = $('#pop-btn');
    if (popBtn) { if (miniCanPop()) popBtn.addEventListener('click', togglePopout); else popBtn.hidden = true; }

    var themeBtn = $('#theme-btn');
    if (themeBtn) themeBtn.addEventListener('click', cycleTheme);

    var sel = $('#period-select');
    if (sel) sel.addEventListener('change', function () { state.activePeriodId = sel.value; save({ quiet: true }); render(); });

    var dump = $('#dump'), di = $('#dump-input'), pv = $('#dump-preview');
    if (dump && di) {
      dump.addEventListener('submit', function (e) { e.preventDefault(); submitDump(); });
      di.addEventListener('input', function () { autoGrow(di); renderPreview(); });
      di.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitDump(); } });
    }
    if (pv) {
      pv.addEventListener('click', function (e) {
        var b = e.target.closest('[data-pv]'), row = e.target.closest('.pv-row');
        if (!b || !row || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
        editPreview(row.dataset.key, { include: b.dataset.pv === 'keep' });
        renderPreview();
      });
      pv.addEventListener('change', function (e) {
        var row = e.target.closest('.pv-row');
        if (!row) return;
        var kind = e.target.dataset.pv;
        if (kind === 'cat') {
          var v = e.target.value;
          if (v === '__new') { v = catName(prompt('Name the new category') || ''); if (!v) { renderPreview(); return; } }
          editPreview(row.dataset.key, { category: v });
          renderPreview();
        } else if (kind === 'est') {
          var m = parseDuration(e.target.value);
          if (m != null && m > 0) editPreview(row.dataset.key, { estMin: m });
          renderPreview();
        } else if (kind === 'title') {
          editPreview(row.dataset.key, { title: e.target.value.trim() });
          buildPreview(); updateAddButton();
        }
      });
      pv.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target.matches('.pv-title, .pv-est')) { e.preventDefault(); e.target.blur(); submitDumpSoon(); }
      });
    }

    $$('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        ui.filter = b.dataset.filter;
        $$('.seg-btn').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        render();
      });
    });

    var search = $('#search');
    if (search) search.addEventListener('input', function () { ui.search = search.value; render(); });

    var groups = $('#groups');
    if (groups) {
      groups.addEventListener('click', function (e) {
        var li = e.target.closest('.task');
        if (!li) return;
        var id = li.dataset.id;
        if (e.target.closest('.play')) toggleTimer(id);
        else if (e.target.closest('.focus-btn')) openFocus(id);
        else if (e.target.closest('[data-est]')) { ui.estEditing = id; render(); var inp = $('[data-est-input="' + CSS.escape(id) + '"]'); if (inp) { inp.focus(); inp.select(); } }
        else if (e.target.closest('.check, .est-input, .grip')) return;
        else openTaskDialog(id);     // the whole row opens the editor
      });
      groups.addEventListener('change', function (e) {
        if (!e.target.classList.contains('check')) return;
        var li = e.target.closest('.task');
        if (li) setDone(li.dataset.id, e.target.checked);
      });
      groups.addEventListener('keydown', function (e) {
        if (!e.target.matches('.est-input')) return;
        if (e.key === 'Enter') { e.preventDefault(); setEstimate(e.target.dataset.estInput, e.target.value); }
        else if (e.key === 'Escape') { ui.estEditing = null; render(); }
      });
      groups.addEventListener('focusout', function (e) {
        if (e.target.matches('.est-input') && ui.estEditing) setEstimate(e.target.dataset.estInput, e.target.value);
      });
      groups.addEventListener('dragstart', onDragStart);
      groups.addEventListener('dragover', onDragOver);
      groups.addEventListener('drop', onDrop);
      groups.addEventListener('dragend', onDragEnd);
    }

    var on = function (sel, ev, fn) { var el = $(sel); if (el) el.addEventListener(ev, fn); };
    on('#period-form', 'submit', function (e) { e.preventDefault(); if (savePeriodDialog()) $('#period-dialog').close(); });
    on('#task-form', 'submit', function (e) { e.preventDefault(); saveTaskDialog(); $('#task-dialog').close(); });
    on('#task-delete', 'click', function () { var id = ui.editingTaskId; $('#task-dialog').close(); deleteTask(id); });
    on('#close-form', 'submit', function (e) { e.preventDefault(); if (saveCloseDialog()) $('#close-dialog').close(); });
    on('#session-form', 'submit', function (e) { e.preventDefault(); if (saveSessionDialog()) $('#session-dialog').close(); });
    on('#session-form', 'input', function (e) {
      var f = e.currentTarget;
      if (e.target.name === 'until' && e.target.value) f.length.value = '';
      if (e.target.name === 'length' && e.target.value) f.until.value = '';
      updateSessionSummary();
    });
    on('#session-form', 'change', updateSessionSummary);
    on('#end-form', 'submit', function (e) { e.preventDefault(); endSession(); $('#end-dialog').close(); });
    on('#auth-form', 'submit', function (e) { e.preventDefault(); submitAuth(); });
    on('#import-file', 'change', function (e) { var imp = e.target; if (imp.files && imp.files[0]) importJSON(imp.files[0]); imp.value = ''; });

    on('#cm-exit', 'click', closeClockMode);
    on('#cm-toggle', 'click', function () { var p = activePeriod(), cur = p && currentTask(p); if (cur) toggleTimer(cur.task.id); clockModeActivity(); });
    on('#clockmode', 'mousemove', clockModeActivity);
    on('#clockmode', 'touchstart', clockModeActivity);
    on('#clock', 'dblclick', openClockMode);
    // In full screen the browser takes Esc to leave it; leaving full screen also leaves clock mode.
    document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && cm.fs) { cm.fs = false; closeClockMode(); } });
    on('#focus-toggle', 'click', function () { if (ui.pomo && ui.pomo.phase === 'break') ui.pomo = null; focusToggle(); });
    on('#focus-done', 'click', function () { var id = ui.focusId; closeFocus(); setDone(id, true); });
    on('#focus-exit', 'click', closeFocus);
    on('#pomo-toggle', 'change', function (e) {
      state.settings.pomodoro = e.target.checked;
      if (!e.target.checked) ui.pomo = null;
      else {
        if (window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (err) { /* ignore */ } }
        if (state.running && state.running.taskId === ui.focusId) ui.pomo = { phase: 'work', endsAt: Date.now() + 25 * 60000 };
      }
      save({ quiet: true }); renderFocus();
    });

    document.addEventListener('keydown', function (e) {
      var focusOpen = !!ui.focusId;
      if (clockModeOpen()) {
        if (e.key === 'Escape' || e.key === 'c') { e.preventDefault(); closeClockMode(); }
        else if (e.key === ' ') { e.preventDefault(); var cp = activePeriod(), cc = cp && currentTask(cp); if (cc) toggleTimer(cc.task.id); }
        clockModeActivity();
        return;
      }
      if (e.key === 'Escape' && focusOpen) { closeFocus(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      if (focusOpen) { if (e.key === ' ') { e.preventDefault(); focusToggle(); } return; }
      var p = activePeriod();
      if (e.key === 'n' && p) { e.preventDefault(); var i = $('#dump-input'); if (i) i.focus(); }
      else if (e.key === 's') { e.preventDefault(); openSessionDialog(); }
      else if (e.key === '/' && p) { e.preventDefault(); var s = $('#search'); if (s) s.focus(); }
      else if (e.key === 'f' && p) { e.preventDefault(); openFocus(); }
      else if (e.key === 'p' && p) togglePopout();
      else if (e.key === 'c' && p) openClockMode();
      else if (e.key === 't') cycleTheme();
      else if (e.key === '?') { var h = $('#help-dialog'); if (h) h.showModal(); }
    });

    // Coming back to the tab: the day may have changed and another device may have saved.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (clockModeOpen() && navigator.wakeLock && !cm.wake) navigator.wakeLock.request('screen').then(function (l) { cm.wake = l; }).catch(function () {});
      render();
      if (window.TempoSync && TempoSync.user) TempoSync.pull();
    });
    window.addEventListener('storage', function (e) { if (e.key === KEY) { state = load(); resetSnap(); render(); } });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    }
  }
  var submitTimer = null;
  function submitDumpSoon() { clearTimeout(submitTimer); submitTimer = setTimeout(submitDump, 0); }

  // Exposed for the test harness only.
  window.__tempo = { setupMiniWindow: setupMiniWindow, mini: mini, state: function () { return state; }, metrics: function () { var p = activePeriod(); return p && metrics(p); }, applySyncedDoc: applySyncedDoc, syncDoc: syncDoc };

  bind();
  setupMic();
  render();
  if (window.TempoSync) {
    TempoSync.init({ getDoc: syncDoc, applyDoc: applySyncedDoc, onStatus: onSyncStatus, onRecovery: function () { openAuth('newpass'); } });
  }
  setInterval(tick, 1000);
  setInterval(function () { if (state.running && !ui.focusId) render(); }, 30000);
  // Sessions with a set length count down in real time, timer or not.
  // (Clock-only mode is redrawn by tick() and this loop through renderClock.)
  setInterval(function () { var p = activePeriod(); if (p && isSession(p) && !p.closed && !state.running) renderClock(p, metrics(p)); }, 1000);
  tick();
})();
