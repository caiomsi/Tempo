/* Tempo timer mode: a few plain timers, each in its own clock face, that keep counting past zero.
   The model (parse / start / pause / save) is plain data so Node tests can load it (module.exports).
   In the browser the UI is window.TempoTimers (open / close / add / toggleFirst / isEditing / count). */
(function (root) {
  'use strict';

  var KEY = 'tempo:timers';
  var MAX_TIMERS = 4;
  var DEFAULT_MIN = 25;
  var MAX_MS = 24 * 3600 * 1000;
  var DEFAULT_FACES = ['dots', 'flip', 'ring', 'disc'];
  var CHIPS = [5, 10, 15, 25, 45, 60];

  function parser() {
    if (typeof require === 'function' && typeof module !== 'undefined' && module.exports) return require('./parse.js');
    return root.TempoParse;
  }

  // ---------- Model ----------
  var seq = 0;
  function newId() { return 't' + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 5); }

  function newTimer(o) {
    o = o || {};
    var d = o.durationMs > 0 ? o.durationMs : DEFAULT_MIN * 60000;
    return { id: o.id || newId(), name: o.name || '', face: o.face || 'dots', durationMs: d, state: 'idle', endsAt: 0, leftMs: d, chimed: false };
  }
  function remainingMs(t, now) {
    if (t.state === 'running') return t.endsAt - (now == null ? Date.now() : now);
    return t.leftMs;
  }
  function start(t, now) {
    now = now == null ? Date.now() : now;
    if (t.state === 'running') return t;
    t.endsAt = now + t.leftMs;           // a paused timer in overtime keeps its negative time
    t.state = 'running';
    return t;
  }
  function pause(t, now) {
    if (t.state !== 'running') return t;
    t.leftMs = remainingMs(t, now);
    t.state = 'paused'; t.endsAt = 0;
    return t;
  }
  function reset(t) {
    t.state = 'idle'; t.endsAt = 0; t.leftMs = t.durationMs; t.chimed = false;
    return t;
  }
  function setDuration(t, ms) {
    t.durationMs = ms;
    return reset(t);
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hms(s) { return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); }
  // 0:24:59, overtime +0:01:12. Whole seconds always round away from zero, so a timer
  // never shows 0:00:00 while it still has time left.
  function fmt(ms) {
    if (ms < 0) return '+' + hms(Math.ceil(-ms / 1000));
    return hms(Math.ceil(ms / 1000));
  }
  function durLabel(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.round(s / 60), h = Math.floor(m / 60);
    if (s % 60 && s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return h ? h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : m + 'm';
  }

  // ---------- Typing a time ----------
  // "25" (minutes), "25m", "90s", "1h", "1h30", "1h 30m", "1:30" (h:mm), "1:30:00",
  // "an hour", "half an hour", "until 6pm", "6:30pm", "till 18:00". Returns ms or null.
  function parseInput(str, now) {
    if (str == null) return null;
    now = now == null ? Date.now() : now;
    var s = String(str).trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return null;
    var P = parser(), m, ms = null;

    if (/^(?:until|till|til|by|at)\s/.test(s) || /\d\s*[ap]\.?m?\.?$/.test(s)) {
      var end = P && P.parseEndTime(s, now);
      ms = end == null ? null : end - now;
    } else if (s === 'half an hour' || s === 'half hour' || s === 'half a hour') ms = 30 * 60000;
    else if (s === 'an hour' || s === 'a hour' || s === 'one hour') ms = 3600000;
    else if (s === 'a minute' || s === 'one minute') ms = 60000;
    else if ((m = s.match(/^(\d+):(\d{2}):(\d{2})$/))) ms = ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000;
    else if ((m = s.match(/^(\d+):(\d{1,2})$/))) ms = ((+m[1]) * 3600 + (+m[2]) * 60) * 1000;
    else if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) ms = Math.round(parseFloat(m[1].replace(',', '.')) * 60000);
    else if ((m = s.match(/^(?:(\d+(?:[.,]\d+)?) ?h(?:rs?|ours?)?)? ?(?:(\d+(?:[.,]\d+)?) ?m(?:ins?|inutes?)?)? ?(?:(\d+) ?s(?:ecs?|econds?)?)?$/)) && (m[1] || m[2] || m[3])) {
      ms = Math.round((m[1] ? parseFloat(m[1].replace(',', '.')) * 3600000 : 0) + (m[2] ? parseFloat(m[2].replace(',', '.')) * 60000 : 0) + (m[3] ? +m[3] * 1000 : 0));
    } else if (P) {
      var min = P.parseDuration(s);     // "1h30" and friends
      ms = min == null ? null : min * 60000;
    }
    if (ms == null || !isFinite(ms) || ms <= 0 || ms > MAX_MS) return null;
    return ms;
  }

  // ---------- Saving (per device, never synced) ----------
  function sanitize(o) {
    if (!o || typeof o !== 'object') return null;
    var d = +o.durationMs;
    if (!(d > 0) || d > MAX_MS) d = DEFAULT_MIN * 60000;
    var t = newTimer({ id: typeof o.id === 'string' ? o.id : null, name: typeof o.name === 'string' ? o.name.slice(0, 40) : '', face: typeof o.face === 'string' ? o.face : 'dots', durationMs: d });
    t.chimed = !!o.chimed;
    if (o.state === 'running' && +o.endsAt > 0) { t.state = 'running'; t.endsAt = +o.endsAt; }
    else if (o.state === 'paused' && isFinite(+o.leftMs)) { t.state = 'paused'; t.leftMs = +o.leftMs; }
    return t;
  }
  function load(storage) {
    try {
      var raw = storage && storage.getItem(KEY);
      var data = raw ? JSON.parse(raw) : null;
      if (!data || data.v !== 1 || !Array.isArray(data.timers)) return [];
      return data.timers.map(sanitize).filter(Boolean).slice(0, MAX_TIMERS);
    } catch (e) { return []; }
  }
  function save(storage, timers) {
    try { storage.setItem(KEY, JSON.stringify({ v: 1, timers: timers })); return true; } catch (e) { return false; }
  }

  var model = {
    KEY: KEY, MAX_TIMERS: MAX_TIMERS, parseInput: parseInput, newTimer: newTimer, start: start, pause: pause, reset: reset,
    remainingMs: remainingMs, setDuration: setDuration, fmt: fmt, durLabel: durLabel, load: load, save: save
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = model; return; }

  // ---------- UI (browser only) ----------
  var doc = root.document;
  var grid = null, timers = [], cards = {}, tickId = 0, audio = null, wake = null, flashTimers = {};

  function store() { try { return root.localStorage; } catch (e) { return null; } }
  function persist() { var s = store(); if (s) save(s, timers); }
  function find(id) { for (var i = 0; i < timers.length; i++) if (timers[i].id === id) return timers[i]; return null; }
  function faces() { return (root.TempoClocks && root.TempoClocks.faces) || []; }

  function pickFace() {
    var used = timers.map(function (t) { return t.face; }), i;
    for (i = 0; i < DEFAULT_FACES.length; i++) if (used.indexOf(DEFAULT_FACES[i]) < 0) return DEFAULT_FACES[i];
    return DEFAULT_FACES[0];
  }

  // Chime: three short soft beeps. The AudioContext is made/resumed inside a click so browsers allow it.
  function unlockAudio() {
    try {
      if (!audio) { var AC = root.AudioContext || root.webkitAudioContext; if (AC) audio = new AC(); }
      if (audio && audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  function chime() {
    try {
      unlockAudio();
      if (!audio) return;
      var t0 = audio.currentTime + 0.02;
      [0, 0.32, 0.64].forEach(function (off, i) {
        var o = audio.createOscillator(), g = audio.createGain(), at = t0 + off;
        o.type = 'sine'; o.frequency.value = i === 2 ? 1046 : 784;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);
        o.connect(g); g.connect(audio.destination);
        o.start(at); o.stop(at + 0.3);
      });
    } catch (e) { /* no sound is fine */ }
  }

  function anyRunning() { return timers.some(function (t) { return t.state === 'running'; }); }
  function syncWake() {
    try {
      if (!root.navigator || !root.navigator.wakeLock) return;
      if (grid && anyRunning()) {
        if (!wake) {
          root.navigator.wakeLock.request('screen').then(function (l) {
            wake = l;
            l.addEventListener('release', function () { if (wake === l) wake = null; });
            if (!grid || !anyRunning()) releaseWake();
          }, function () { });
        }
      } else releaseWake();
    } catch (e) { }
  }
  function releaseWake() { try { if (wake) { var l = wake; wake = null; l.release(); } } catch (e) { } }

  function cardHtml(t) {
    var opts = faces().map(function (f) { return '<option value="' + f.id + '">' + f.name + '</option>'; }).join('');
    var chips = CHIPS.map(function (m) { return '<button type="button" class="tm-chip" data-min="' + m + '">' + (m === 60 ? '1h' : m) + '</button>'; }).join('');
    return '<div class="tm-head"><input class="tm-name" type="text" maxlength="40" placeholder="Timer" aria-label="Timer name" autocomplete="off">' +
      '<button type="button" class="tm-remove" aria-label="Remove timer" title="Remove timer">&times;</button></div>' +
      '<div class="tm-face"></div>' +
      '<div class="tm-readout"><div class="tm-read tc-num" aria-live="off"></div><div class="tm-of"></div></div>' +
      '<div class="tm-style"><button type="button" class="tm-prev" aria-label="Previous style">&lsaquo;</button>' +
      '<select class="tm-select" aria-label="Clock style">' + opts + '</select>' +
      '<button type="button" class="tm-next" aria-label="Next style">&rsaquo;</button></div>' +
      '<div class="tm-time"><input class="tm-dur" type="text" inputmode="text" placeholder="25m · 1h30 · until 6pm" aria-label="Set the time" autocomplete="off">' +
      '<div class="tm-err" role="alert"></div><div class="tm-chips">' + chips + '</div></div>' +
      '<div class="tm-ctrl"><button type="button" class="btn btn-primary tm-toggle">Start</button><button type="button" class="btn tm-reset">Reset</button></div>';
  }

  function mountFace(c, t) {
    c.update = root.TempoClocks ? root.TempoClocks.mount(c.faceEl, t.face) : null;
    c.faceBudget = t.durationMs;
  }

  function makeCard(t) {
    var el = doc.createElement('article');
    el.className = 'tm-card'; el.setAttribute('data-id', t.id);
    el.innerHTML = cardHtml(t);
    var c = { t: t, el: el, faceEl: el.querySelector('.tm-face'), read: el.querySelector('.tm-read'), of: el.querySelector('.tm-of'),
      toggle: el.querySelector('.tm-toggle'), name: el.querySelector('.tm-name'), sel: el.querySelector('.tm-select'),
      remove: el.querySelector('.tm-remove'), err: el.querySelector('.tm-err'), chips: el.querySelectorAll('.tm-chip'), update: null, last: {} };
    c.name.value = t.name; c.sel.value = t.face;
    cards[t.id] = c;
    return c;
  }

  function paint(c, now) {
    var t = c.t, ms = remainingMs(t, now), over = ms < 0, running = t.state === 'running';
    var txt = fmt(ms), of = 'of ' + durLabel(t.durationMs) + (over ? ' · over' : '');
    if (c.last.txt !== txt) { c.read.textContent = txt; c.last.txt = txt; }
    if (c.last.of !== of) { c.of.textContent = of; c.last.of = of; }
    var tg = running ? 'Pause' : t.state === 'paused' ? 'Resume' : 'Start';
    if (c.last.tg !== tg) { c.toggle.textContent = tg; c.last.tg = tg; }
    c.el.classList.toggle('is-running', running);
    c.el.classList.toggle('is-over', over);
    var mins = t.durationMs / 60000;
    for (var i = 0; i < c.chips.length; i++) c.chips[i].classList.toggle('is-on', +c.chips[i].getAttribute('data-min') === mins);
    if (c.update) {
      var secs = ms >= 0 ? Math.ceil(ms / 1000) : -Math.ceil(-ms / 1000);
      c.update({ left: secs, budget: t.durationMs / 1000, label: (t.name || 'TIMER').toUpperCase(), overLabel: 'OVERTIME', sub: 'of ' + durLabel(t.durationMs), running: running });
    }
  }

  function flash(c) {
    c.el.classList.add('is-flash');
    root.clearTimeout(flashTimers[c.t.id]);
    flashTimers[c.t.id] = root.setTimeout(function () { c.el.classList.remove('is-flash'); }, 3000);
  }

  function crossed(c) {
    var t = c.t;
    t.chimed = true; persist();
    chime(); flash(c);
    try {
      if (root.Notification && root.Notification.permission === 'granted') new root.Notification('Timer done', { body: t.name || durLabel(t.durationMs) });
    } catch (e) { }
  }

  function tick() {
    var now = Date.now();
    timers.forEach(function (t) {
      var c = cards[t.id];
      if (!c) return;
      if (t.state === 'running' && !t.chimed && remainingMs(t, now) <= 0) crossed(c);
      paint(c, now);
    });
  }

  function setN() { if (grid) grid.setAttribute('data-n', String(timers.length)); }
  function updateRemoveVisibility() {
    var one = timers.length <= 1;
    timers.forEach(function (t) { var c = cards[t.id]; if (c) c.remove.hidden = one; });
  }
  function addBtn() { return doc.getElementById('tm-add'); }
  function syncAddBtn() { var b = addBtn(); if (b) b.disabled = timers.length >= MAX_TIMERS; }

  function appendCard(t) {
    var c = makeCard(t);
    grid.appendChild(c.el);
    mountFace(c, t);
    paint(c);
  }

  function applyDuration(c, text) {
    var ms = parseInput(text);
    if (ms == null) { c.err.textContent = 'Try 25m, 1h30, 90s or until 6pm'; return false; }
    c.err.textContent = '';
    setDuration(c.t, ms);
    c.el.querySelector('.tm-dur').value = '';
    persist(); syncWake(); mountFace(c, c.t); paint(c);
    return true;
  }

  function toggle(t) {
    unlockAudio();
    if (t.state === 'running') pause(t); else start(t);
    persist(); syncWake();
    var c = cards[t.id]; if (c) paint(c);
  }

  function setFace(c, id) {
    c.t.face = id; c.sel.value = id; persist();
    c.last = {}; mountFace(c, c.t); paint(c);
  }

  function onClick(e) {
    var node = e.target.closest ? e.target.closest('button') : null;
    if (!node || !grid.contains(node)) return;
    var cardEl = node.closest('.tm-card'), t = cardEl && find(cardEl.getAttribute('data-id')), c = t && cards[t.id];
    if (!t) return;
    var cls = node.className;
    if (/\btm-toggle\b/.test(cls)) toggle(t);
    else if (/\btm-reset\b/.test(cls)) { reset(t); persist(); syncWake(); paint(c); }
    else if (/\btm-remove\b/.test(cls)) removeTimer(t.id);
    else if (/\btm-chip\b/.test(cls)) applyDuration(c, node.getAttribute('data-min') + 'm');
    else if (/\btm-prev\b|\btm-next\b/.test(cls)) {
      var list = faces(), i = 0;
      for (var k = 0; k < list.length; k++) if (list[k].id === t.face) i = k;
      i = (i + (/\btm-next\b/.test(cls) ? 1 : list.length - 1)) % list.length;
      setFace(c, list[i].id);
    }
  }
  function onChange(e) {
    var n = e.target;
    if (!n.classList || !n.classList.contains('tm-select')) return;
    var cardEl = n.closest('.tm-card'), t = cardEl && find(cardEl.getAttribute('data-id'));
    if (t) setFace(cards[t.id], n.value);
  }
  function onInput(e) {
    var n = e.target;
    if (!n.classList) return;
    var cardEl = n.closest('.tm-card'), t = cardEl && find(cardEl.getAttribute('data-id'));
    if (!t) return;
    if (n.classList.contains('tm-name')) { t.name = n.value.slice(0, 40); persist(); paint(cards[t.id]); }
    else if (n.classList.contains('tm-dur')) cards[t.id].err.textContent = '';
  }
  function onKey(e) {
    var n = e.target;
    if (!n.classList || !n.classList.contains('tm-dur')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      var cardEl = n.closest('.tm-card'), t = cardEl && find(cardEl.getAttribute('data-id'));
      if (t && (!n.value.trim() || applyDuration(cards[t.id], n.value))) n.blur();
    }
  }
  function onBlur(e) {
    var n = e.target;
    if (!n.classList || !n.classList.contains('tm-dur') || !n.value.trim()) return;
    var cardEl = n.closest('.tm-card'), t = cardEl && find(cardEl.getAttribute('data-id'));
    if (t) applyDuration(cards[t.id], n.value);
  }

  function removeTimer(id) {
    if (timers.length <= 1) return;
    var c = cards[id];
    timers = timers.filter(function (t) { return t.id !== id; });
    if (c && c.el.parentNode) c.el.parentNode.removeChild(c.el);
    delete cards[id];
    root.clearTimeout(flashTimers[id]);
    setN(); updateRemoveVisibility(); syncAddBtn(); persist(); syncWake();
  }

  function add() {
    if (!grid || timers.length >= MAX_TIMERS) return null;
    var t = newTimer({ face: pickFace() });
    timers.push(t);
    appendCard(t);
    setN(); updateRemoveVisibility(); syncAddBtn(); persist();
    return t;
  }

  function open(gridEl) {
    if (!gridEl || !doc) return;
    if (grid === gridEl && tickId) return;      // already open
    close();
    grid = gridEl;
    var s = store();
    timers = s ? load(s) : [];
    if (!timers.length) timers = [newTimer({ face: 'dots' })];
    var now = Date.now();
    timers.forEach(function (t) {   // finished long ago while we were away: don't chime for it now
      if (t.state === 'running' && !t.chimed && remainingMs(t, now) < -3000) t.chimed = true;
    });
    grid.innerHTML = '';
    cards = {};
    timers.forEach(appendCard);
    setN(); updateRemoveVisibility(); syncAddBtn(); persist();
    grid.addEventListener('click', onClick);
    grid.addEventListener('change', onChange);
    grid.addEventListener('input', onInput);
    grid.addEventListener('keydown', onKey);
    grid.addEventListener('focusout', onBlur);
    tickId = root.setInterval(tick, 250);
    syncWake();
  }

  function close() {
    if (tickId) { root.clearInterval(tickId); tickId = 0; }
    if (grid) {
      grid.removeEventListener('click', onClick);
      grid.removeEventListener('change', onChange);
      grid.removeEventListener('input', onInput);
      grid.removeEventListener('keydown', onKey);
      grid.removeEventListener('focusout', onBlur);
      grid.innerHTML = '';
      grid.removeAttribute('data-n');
    }
    Object.keys(flashTimers).forEach(function (k) { root.clearTimeout(flashTimers[k]); });
    flashTimers = {};
    releaseWake();
    try { if (audio && audio.close) audio.close(); } catch (e) { }
    audio = null;
    grid = null; cards = {};
  }

  function toggleFirst() { if (grid && timers[0]) toggle(timers[0]); }
  function isEditing() {
    var a = doc && doc.activeElement;
    return !!(grid && a && grid.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }

  root.TempoTimers = { open: open, close: close, add: add, toggleFirst: toggleFirst, isEditing: isEditing, count: function () { return timers.length; } };
  root.TempoTimersModel = model;
})(typeof window !== 'undefined' ? window : this);
