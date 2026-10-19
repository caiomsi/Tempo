/* Tempo clock faces. Every face draws the same data in its own way, and can be built
   inside any document (the main page, clock-only mode, the pop-out window).
   TempoClocks.mount(host, id) returns update(d) with
   d = { left (sec, negative when over), budget (sec), label, sub, running }. */
(function (root) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var MONO = 'Geist Mono, ui-monospace, monospace';
  var UI = 'Geist, -apple-system, system-ui, sans-serif';

  // ---------- helpers ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hms(s) { var a = Math.abs(Math.floor(s)); return (s < 0 ? '+' : '') + Math.floor(a / 3600) + ':' + pad(Math.floor(a / 60) % 60) + ':' + pad(a % 60); }
  function hm(s) { var a = Math.abs(Math.round(s / 60)), h = Math.floor(a / 60), m = a % 60; return h ? h + 'h' + (m ? ' ' + m + 'm' : '') : m + 'm'; }
  function minLabel(m) { m = Math.round(m); return m < 60 ? String(m) : m % 60 ? Math.floor(m / 60) + 'h' + pad(m % 60) : m / 60 + 'h'; }
  function polar(cx, cy, r, turn) { var a = turn * 2 * Math.PI; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; }
  function wedge(cx, cy, r, t0, t1) {
    if (t1 - t0 >= .9999) return 'M' + cx + ' ' + (cy - r) + ' A' + r + ' ' + r + ' 0 1 1 ' + (cx - .01) + ' ' + (cy - r) + ' Z';
    if (t1 <= t0) return '';
    var a = polar(cx, cy, r, t0), b = polar(cx, cy, r, t1);
    return 'M' + cx + ' ' + cy + ' L' + a[0] + ' ' + a[1] + ' A' + r + ' ' + r + ' 0 ' + (t1 - t0 > .5 ? 1 : 0) + ' 1 ' + b[0] + ' ' + b[1] + ' Z';
  }
  function clockTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  var ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty'];
  function word(n) { return n >= 60 ? String(n) : n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''); }

  // Builders bound to one host element (and so to its document).
  function kit(host) {
    var doc = host.ownerDocument;
    function el(tag, attrs, parent, text) {
      var n = doc.createElementNS(NS, tag), style = '';
      for (var k in attrs) {
        // Presentation attributes can't take var(), so token colours go through style.
        if (/^(fill|stroke)$/.test(k) && String(attrs[k]).indexOf('var(') === 0) style += k + ':' + attrs[k] + ';';
        else n.setAttribute(k, attrs[k]);
      }
      if (style) n.setAttribute('style', style);
      if (text != null) n.textContent = text;
      if (parent) parent.appendChild(n);
      return n;
    }
    function paint(n, prop, v) { n.style[prop] = v; }
    function svg(vb) { var s = el('svg', { viewBox: vb || '0 0 220 220', 'aria-hidden': 'true', class: 'tc-svg' }); host.appendChild(s); return s; }
    function h(tag, cls, parent, html) { var n = doc.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; (parent || host).appendChild(n); return n; }
    function uid(p) { return p + Math.random().toString(36).slice(2, 9); }
    return { el: el, svg: svg, h: h, paint: paint, uid: uid };
  }

  // Each face: build(k, d0) returns update(d). d also carries frac (left/budget, 0..1),
  // used (1 - frac), over (bool) and t (ms, for animation). `live` faces redraw every frame.
  var FACES = [
    { id: 'dots', name: 'One dot a minute', note: 'A dot for every minute you have. Used ones fade; the current one pulses.', live: true,
      build: function (k, d0) {
        var s = k.svg(), mins = Math.max(d0.budget / 60, 1);
        var unit = [1, 2, 5, 10, 15, 30, 60, 120, 240].filter(function (u) { return Math.ceil(mins / u) <= 144; })[0] || 240;
        var n = Math.ceil(mins / unit), cols = n <= 36 ? 6 : n <= 64 ? 8 : n <= 100 ? 10 : 12, rows = Math.ceil(n / cols);
        var step = Math.min(180 / cols, 150 / rows), r = step * .32, x0 = 110 - step * (cols - 1) / 2, y0 = 92 - step * (rows - 1) / 2, dots = [];
        for (var i = 0; i < n; i++) dots.push(k.el('circle', { cx: x0 + (i % cols) * step, cy: y0 + Math.floor(i / cols) * step, r: r }, s));
        var cap = k.el('text', { x: 110, y: 200, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 11.5, fill: 'var(--ink-2)', class: 'tc-num' }, s);
        return function (d) {
          var usedN = d.over ? n : Math.min(Math.floor(d.used * n), n - 1), pulse = .45 + .55 * Math.abs(Math.sin(d.t / 400));
          dots.forEach(function (c, i) {
            var col = d.over ? 'var(--bad)' : i < usedN ? 'var(--line-2)' : i === usedN ? 'var(--accent)' : 'var(--ink)';
            if (c._c !== col) { c.style.fill = col; c._c = col; }
            c.setAttribute('opacity', d.over ? .35 : i === usedN && d.running ? pulse.toFixed(2) : 1);
          });
          var leftN = Math.max(Math.ceil(d.left / 60 / unit), 0);
          cap.textContent = d.over ? 'over by ' + hm(-d.left) : unit === 1 ? leftN + ' of ' + n + ' minutes left' : hm(d.left) + ' left · 1 dot = ' + minLabel(unit).replace(/^(\d+)$/, '$1 min');
          cap.style.fill = d.over ? 'var(--bad)' : 'var(--ink-2)';
        };
      } },

    { id: 'ring', name: 'The ring', note: 'A thin ring that empties as time is used, with the countdown inside.',
      build: function (k) {
        var s = k.svg(), C = 2 * Math.PI * 96;
        k.el('circle', { cx: 110, cy: 110, r: 96, fill: 'none', stroke: 'var(--line)', 'stroke-width': 10 }, s);
        var ring = k.el('circle', { class: 'dial-ring', cx: 110, cy: 110, r: 96, fill: 'none', 'stroke-width': 10, 'stroke-linecap': 'round', 'stroke-dasharray': C.toFixed(2), transform: 'rotate(-90 110 110)' }, s);
        var label = k.el('text', { x: 110, y: 82, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 9.5, 'font-weight': 500, 'letter-spacing': '.6', fill: 'var(--ink-3)' }, s);
        var t = k.el('text', { x: 110, y: 124, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 34, 'letter-spacing': '-1', class: 'tc-num' }, s);
        var sub = k.el('text', { x: 110, y: 150, 'text-anchor': 'middle', 'font-family': UI, 'font-size': 11.5, fill: 'var(--ink-2)' }, s);
        return function (d) {
          ring.setAttribute('stroke-dashoffset', (C * (1 - d.frac)).toFixed(2));
          ring.style.stroke = d.over ? 'var(--bad)' : 'var(--accent)';
          label.textContent = d.over ? 'OVER BUDGET' : d.label;
          t.textContent = hms(d.left); t.style.fill = d.over ? 'var(--bad)' : 'var(--ink)';
          sub.textContent = d.sub || '';
        };
      } },

    { id: 'disc', name: 'Red disc', note: 'Like a classroom Time Timer: a red wedge shows what’s left and shrinks toward 12.',
      build: function (k, d0) {
        var s = k.svg(), mins = d0.budget / 60;
        k.el('circle', { cx: 110, cy: 110, r: 104, fill: '#fff', stroke: 'var(--line)' }, s);
        for (var i = 0; i < 60; i++) { var a = polar(110, 110, 100, i / 60), b = polar(110, 110, i % 5 ? 95 : 90, i / 60); k.el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: '#222', 'stroke-width': i % 5 ? .8 : 1.8 }, s); }
        for (var j = 0; j < 8; j++) { var p = polar(110, 110, 79, j / 8); k.el('text', { x: p[0], y: p[1] + 4, 'text-anchor': 'middle', 'font-family': UI, 'font-weight': 600, 'font-size': 11, fill: '#222' }, s, minLabel(mins * j / 8)); }
        var w = k.el('path', { fill: '#e0322b' }, s);
        k.el('circle', { cx: 110, cy: 110, r: 9, fill: '#fff', stroke: '#ccc' }, s);
        return function (d) { w.setAttribute('d', wedge(110, 110, 70, 1 - d.frac, 1)); };
      } },

    { id: 'flip', name: 'Flip clock', note: 'Split-flap cards for hours, minutes and seconds that flip as they change.',
      build: function (k) {
        var box = k.h('div', 'tc-flip'), win = box.ownerDocument.defaultView, cards = [];
        // A real split-flap: the top half of the old digit falls forward, then the bottom
        // half of the new digit lands. Static halves underneath show new-top and old-bottom.
        function card(cls) {
          var c = k.h('div', 'fc ' + cls, box, '<span class="half top"><b></b></span><span class="half bot"><b></b></span>' +
            '<span class="flap ftop"><b></b></span><span class="flap fbot"><b></b></span>');
          var q = function (sel) { return c.querySelector(sel + ' b'); };
          return { el: c, top: q('.top'), bot: q('.bot'), ftop: q('.ftop'), fbot: q('.fbot'), v: null, timer: 0 };
        }
        function set(c, v) {
          if (c.v === v) return;
          var old = c.v; c.v = v;
          c.el.style.setProperty('--n', v.length);
          win.clearTimeout(c.timer);
          c.el.classList.remove('go');
          if (old == null) { c.top.textContent = c.bot.textContent = v; return; }
          c.top.textContent = v; c.fbot.textContent = v;
          c.ftop.textContent = old; c.bot.textContent = old;
          void c.el.offsetWidth;
          c.el.classList.add('go');
          c.timer = win.setTimeout(function () { c.bot.textContent = v; c.el.classList.remove('go'); }, 560);
        }
        ['', 'c', '', '', 'c', 'sm', 'sm'].forEach(function (c) { if (c === 'c') k.h('span', 'colon', box, ':'); else cards.push(card(c)); });
        return function (d) {
          var a = Math.abs(Math.floor(d.left)), mm = pad(Math.floor(a / 60) % 60), ss = pad(a % 60);
          var v = [(d.over ? '+' : '') + Math.floor(a / 3600), mm[0], mm[1], ss[0], ss[1]];
          cards.forEach(function (c, i) { set(c, v[i]); });
        };
      } },

    { id: 'number', name: 'Just the number', note: 'Huge light numerals and one hairline. Nothing else.',
      build: function (k) {
        var g = k.h('div', 'tc-giant'), big = k.h('div', 'big', g), hair = k.h('div', 'hair', g, '<i></i>'), cap = k.h('div', 'cap', g, '<span></span><span></span>');
        return function (d) {
          var a = Math.abs(Math.floor(d.left));
          big.innerHTML = (d.over ? '+' : '') + Math.floor(a / 3600) + ':' + pad(Math.floor(a / 60) % 60) + '<small>' + pad(a % 60) + '</small>';
          big.style.color = d.over ? 'var(--bad)' : '';
          hair.firstChild.style.width = (d.frac * 100) + '%';
          cap.firstChild.textContent = d.over ? 'Over budget' : d.label;
          cap.lastChild.textContent = 'of ' + hm(d.budget);
        };
      } },

    { id: 'hourglass', name: 'Hourglass', note: 'Sand drains from the top bulb into the bottom one as time is used.',
      build: function (k) {
        var s = k.svg(), id = k.uid('hg'), defs = k.el('defs', {}, s);
        k.el('path', { d: 'M62 30 H158 C158 70 122 92 113 108 H107 C98 92 62 70 62 30 Z' }, k.el('clipPath', { id: id + 't' }, defs));
        k.el('path', { d: 'M107 112 H113 C122 128 158 150 158 190 H62 C62 150 98 128 107 112 Z' }, k.el('clipPath', { id: id + 'b' }, defs));
        k.el('rect', { x: 46, y: 18, width: 128, height: 10, rx: 3, fill: 'var(--ink)' }, s);
        k.el('rect', { x: 46, y: 192, width: 128, height: 10, rx: 3, fill: 'var(--ink)' }, s);
        var top = k.el('rect', { x: 60, width: 100, fill: '#d9a441', 'clip-path': 'url(#' + id + 't)' }, s);
        var bot = k.el('path', { fill: '#d9a441', 'clip-path': 'url(#' + id + 'b)' }, s);
        var stream = k.el('line', { x1: 110, x2: 110, y1: 106, stroke: '#d9a441', 'stroke-width': 2 }, s);
        k.el('path', { d: 'M62 30 C62 70 98 92 107 110 C98 128 62 150 62 190 M158 30 C158 70 122 92 113 110 C122 128 158 150 158 190', fill: 'none', stroke: 'var(--ink-2)', 'stroke-width': 2.5 }, s);
        return function (d) {
          var yTop = 108 - d.frac * 72; top.setAttribute('y', yTop); top.setAttribute('height', 108 - yTop);
          var hgt = d.used * 60, peak = 190 - hgt - 10 * Math.min(d.used * 3, 1);
          bot.setAttribute('d', 'M60 190 L60 ' + (190 - hgt) + ' Q110 ' + peak + ' 160 ' + (190 - hgt) + ' L160 190 Z');
          stream.setAttribute('y2', d.frac > 0 && d.frac < 1 && d.running ? Math.max(peak, 112) : 106);
        };
      } },

    { id: 'ruler', name: 'Ruler', note: 'Your time laid out like a ruler. The needle marks how far in you are.',
      build: function (k, d0) {
        var s = k.svg('0 0 260 220'), mins = Math.max(d0.budget / 60, 1);
        var step = [5, 10, 15, 30, 60, 120, 240].filter(function (u) { return mins / u <= 24; })[0] || 240, X = function (m) { return 16 + m / mins * 228; };
        var t = k.el('text', { x: 14, y: 70, 'font-family': MONO, 'font-size': 34, class: 'tc-num' }, s);
        k.el('text', { x: 14, y: 92, fill: 'var(--ink-3)', 'font-family': MONO, 'font-size': 9.5, 'letter-spacing': '.8' }, s, 'LEFT · ' + hm(d0.budget).toUpperCase() + ' PLANNED');
        k.el('rect', { x: 10, y: 118, width: 240, height: 54, rx: 4, fill: '#f2d36b' }, s);
        var used = k.el('rect', { x: 10, y: 118, height: 54, rx: 4, fill: '#000', opacity: .12 }, s);
        for (var m = 0, i = 0; m <= mins + .01; m += step, i++) {
          var big = i % 4 === 0;
          k.el('line', { x1: X(m), y1: 118, x2: X(m), y2: 118 + (big ? 22 : i % 2 ? 9 : 15), stroke: '#2a2414', 'stroke-width': big ? 1.6 : 1 }, s);
          if (big) k.el('text', { x: X(m), y: 160, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 10, fill: '#2a2414' }, s, minLabel(m));
        }
        var needle = k.el('path', { d: 'M0 108 L5 100 L-5 100 Z M0 108 V182', stroke: '#d23a2c', 'stroke-width': 2, fill: '#d23a2c' }, s);
        return function (d) {
          t.textContent = hms(d.left); t.style.fill = d.over ? 'var(--bad)' : 'var(--ink)';
          used.setAttribute('width', 6 + d.used * 228); needle.setAttribute('transform', 'translate(' + X(d.used * mins) + ' 0)');
        };
      } },

    { id: 'segments', name: 'Segments', note: 'Sixty blocks around the edge that go dark one by one.',
      build: function (k) {
        var s = k.svg(), segs = [];
        for (var i = 0; i < 60; i++) { var a = polar(110, 110, 100, (i + .5) / 60), b = polar(110, 110, 82, (i + .5) / 60); segs.push(k.el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], 'stroke-width': 6.5, 'stroke-linecap': 'round' }, s)); }
        var t = k.el('text', { x: 110, y: 120, 'text-anchor': 'middle', 'font-family': UI, 'font-weight': 500, 'font-size': 38, class: 'tc-num' }, s);
        var u = k.el('text', { x: 110, y: 142, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-family': MONO, 'font-size': 9.5, 'letter-spacing': '.8' }, s);
        return function (d) {
          var on = Math.ceil(d.frac * 60);
          segs.forEach(function (g, i) { var c = d.over ? 'var(--bad)' : i < on ? 'var(--accent)' : 'var(--line)'; if (g._c !== c) { g.style.stroke = c; g._c = c; } });
          var mins = Math.ceil(Math.abs(d.left) / 60);
          t.textContent = (d.over ? '+' : '') + (mins >= 180 ? hm(Math.abs(d.left)) : mins); t.style.fill = d.over ? 'var(--bad)' : 'var(--ink)';
          u.textContent = d.over ? 'OVER' : mins >= 180 ? 'LEFT' : 'MINUTES LEFT';
        };
      } },

    { id: 'wall', name: 'Wall clock', note: 'A real clock with the actual time, and your remaining time shaded up to when it ends.', live: true,
      build: function (k) {
        var s = k.svg();
        k.el('circle', { cx: 110, cy: 110, r: 104, fill: 'var(--surface)', stroke: 'var(--ink)', 'stroke-width': 2 }, s);
        var zone = k.el('path', { fill: '#f5c518', opacity: .55 }, s);
        for (var i = 0; i < 60; i++) { var a = polar(110, 110, 96, i / 60), b = polar(110, 110, i % 5 ? 91 : 84, i / 60); k.el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: 'var(--ink)', 'stroke-width': i % 5 ? 1 : 2.6 }, s); }
        var hh = k.el('line', { x1: 110, y1: 122, x2: 110, y2: 62, stroke: 'var(--ink)', 'stroke-width': 6, 'stroke-linecap': 'round' }, s);
        var mh = k.el('line', { x1: 110, y1: 124, x2: 110, y2: 32, stroke: 'var(--ink)', 'stroke-width': 4, 'stroke-linecap': 'round' }, s);
        var sh = k.el('line', { x1: 110, y1: 130, x2: 110, y2: 24, stroke: '#f5a300', 'stroke-width': 1.8 }, s);
        k.el('circle', { cx: 110, cy: 110, r: 5, fill: '#f5a300' }, s);
        var cap = k.el('text', { x: 110, y: 160, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-family': UI, 'font-size': 10.5 }, s);
        return function (d) {
          var now = new Date(), H = now.getHours() % 12 + now.getMinutes() / 60 + now.getSeconds() / 3600;
          hh.setAttribute('transform', 'rotate(' + (H * 30).toFixed(2) + ' 110 110)');
          mh.setAttribute('transform', 'rotate(' + ((now.getMinutes() + now.getSeconds() / 60) * 6).toFixed(2) + ' 110 110)');
          sh.setAttribute('transform', 'rotate(' + ((now.getSeconds() + now.getMilliseconds() / 1000) * 6).toFixed(2) + ' 110 110)');
          var t0 = H / 12, span = Math.min(Math.max(d.left, 0) / 43200, .999);
          zone.setAttribute('d', span > 0 ? wedge(110, 110, 80, t0, t0 + span) : '');
          cap.textContent = d.over ? 'over by ' + hm(-d.left) : d.left > 43200 ? hm(d.left) + ' left' : 'done at ' + clockTime(Date.now() + d.left * 1000);
        };
      } },

    { id: 'glass', name: 'Draining glass', note: 'A round glass of water whose level drops as time runs out.', live: true,
      build: function (k) {
        var s = k.svg(), id = k.uid('lq');
        k.el('circle', { cx: 110, cy: 110, r: 96 }, k.el('clipPath', { id: id }, k.el('defs', {}, s)));
        k.el('circle', { cx: 110, cy: 110, r: 100, fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 2 }, s);
        var back = k.el('path', { fill: '#3b82f6', opacity: .35, 'clip-path': 'url(#' + id + ')' }, s);
        var wave = k.el('path', { fill: '#2563eb', 'clip-path': 'url(#' + id + ')' }, s);
        var t = k.el('text', { x: 110, y: 118, 'text-anchor': 'middle', fill: 'var(--ink)', 'font-family': MONO, 'font-size': 30, 'font-weight': 500, class: 'tc-num', stroke: 'var(--surface)', 'stroke-width': 4, 'paint-order': 'stroke' }, s);
        function path(level, ph, amp) { var p = 'M0 ' + level; for (var x = 0; x <= 220; x += 10) p += ' L' + x + ' ' + (level + Math.sin(x / 26 + ph) * amp).toFixed(1); return p + ' L220 220 L0 220 Z'; }
        return function (d) { var lv = 206 - d.frac * 192; wave.setAttribute('d', path(lv, d.t / 500, 4)); back.setAttribute('d', path(lv - 3, d.t / 700 + 2, 5)); t.textContent = hms(d.left); };
      } },

    { id: 'nixie', name: 'Nixie tubes', note: 'Glowing orange digits in glass tubes, like old lab equipment. Always dark.', cls: 'tc-dark',
      build: function (k) {
        var row = k.h('div', 'tc-tubes'), lbl = k.h('span', 'tc-lbl'), tubes = [], shape = '';
        return function (d) {
          var a = Math.abs(Math.floor(d.left)), str = Math.floor(a / 3600) + ':' + pad(Math.floor(a / 60) % 60) + ':' + pad(a % 60);
          var sh = str.replace(/\d/g, '0');
          if (sh !== shape) {
            shape = sh; row.innerHTML = ''; tubes = [];
            row.classList.toggle('many', str.length > 7);
            for (var i = 0; i < str.length; i++) { if (str[i] === ':') k.h('span', 'dot', row); else tubes.push(k.h('div', 'tube', row)); }
          }
          var digits = str.replace(/:/g, '');
          for (var j = 0; j < tubes.length; j++) if (tubes[j].textContent !== digits[j]) tubes[j].textContent = digits[j];
          lbl.textContent = d.over ? 'OVER BUDGET' : d.label;
        };
      } },

    { id: 'lcd', name: 'Digital watch', note: 'A grey-green LCD with seven-segment digits, like an old Casio. Always light.', cls: 'tc-lcd',
      build: function (k) {
        var lbl = k.h('span', 'tc-lbl'), s = k.svg('0 0 270 120');
        var MAP = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', ' ': '' };
        var SEG = { a: [4, 0, 22, 5], b: [26, 4, 5, 22], c: [26, 30, 5, 22], d: [4, 52, 22, 5], e: [-1, 30, 5, 22], f: [-1, 4, 5, 22], g: [4, 26, 22, 5] };
        function digit(x, y, z) { var g = k.el('g', { transform: 'translate(' + x + ' ' + y + ') scale(' + z + ') skewX(-6)' }, s), out = {}; for (var n in SEG) { var r = SEG[n]; out[n] = k.el('rect', { x: r[0], y: r[1], width: r[2], height: r[3], rx: 2 }, g); } return out; }
        var D = [digit(10, 30, 1.05), digit(48, 30, 1.05), digit(102, 30, 1.05), digit(140, 30, 1.05), digit(200, 44, .72), digit(228, 44, .72)];
        [[88, 46], [88, 72], [184, 56], [184, 76]].forEach(function (p) { k.el('rect', { x: p[0], y: p[1], width: 5, height: 5, fill: '#1f241b' }, s); });
        return function (d) {
          var a = Math.abs(Math.floor(d.left)), H = Math.min(Math.floor(a / 3600), 99);
          var str = (H < 10 ? ' ' + H : String(H)) + pad(Math.floor(a / 60) % 60) + pad(a % 60);
          D.forEach(function (dg, i) { var on = MAP[str[i]]; for (var n in dg) dg[n].setAttribute('fill', on.indexOf(n) >= 0 ? '#1f241b' : '#0000000f'); });
          lbl.textContent = d.over ? 'OVER' : 'TIMER';
        };
      } },

    { id: 'sun', name: 'Sun across the sky', note: 'The sun rises when you start and sets when your time is up.',
      build: function (k) {
        var s = k.svg();
        k.el('path', { d: 'M20 150 A90 90 0 0 1 200 150', fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 1.5, 'stroke-dasharray': '2 5', 'stroke-linecap': 'round' }, s);
        var trail = k.el('path', { fill: 'none', stroke: '#f59e0b', 'stroke-width': 3, 'stroke-linecap': 'round' }, s);
        k.el('line', { x1: 8, y1: 150, x2: 212, y2: 150, stroke: 'var(--ink)', 'stroke-width': 1.5 }, s);
        var glow = k.el('circle', { r: 22, fill: '#f59e0b', opacity: .18 }, s), sun = k.el('circle', { r: 12, fill: '#f59e0b' }, s);
        var t = k.el('text', { x: 110, y: 186, 'text-anchor': 'middle', 'font-family': MONO, 'font-size': 22, class: 'tc-num' }, s);
        var cap = k.el('text', { x: 110, y: 205, 'text-anchor': 'middle', fill: 'var(--ink-3)', 'font-family': UI, 'font-size': 10 }, s);
        return function (d) {
          var a = Math.PI * (1 - d.used), x = 110 + 90 * Math.cos(a), y = 150 - 90 * Math.sin(a);
          sun.setAttribute('cx', x); sun.setAttribute('cy', y); glow.setAttribute('cx', x); glow.setAttribute('cy', y);
          trail.setAttribute('d', d.used > 0 ? 'M20 150 A90 90 0 0 1 ' + x.toFixed(2) + ' ' + y.toFixed(2) : '');
          t.textContent = hms(d.left); t.style.fill = d.over ? 'var(--bad)' : 'var(--ink)';
          cap.textContent = d.over ? 'the sun has set' : 'sets at ' + clockTime(Date.now() + d.left * 1000);
        };
      } },

    { id: 'rings', name: 'Three rings', note: 'Like the Apple Watch: the whole period outside, this hour in the middle, this minute inside.',
      build: function (k) {
        var s = k.svg(), arcs = [];
        [[96, '#fa114f'], [74, '#92e82a'], [52, '#1eeaef']].forEach(function (r) {
          var C = 2 * Math.PI * r[0];
          k.el('circle', { cx: 110, cy: 110, r: r[0], fill: 'none', stroke: r[1], 'stroke-opacity': .18, 'stroke-width': 18 }, s);
          arcs.push([k.el('circle', { cx: 110, cy: 110, r: r[0], fill: 'none', stroke: r[1], 'stroke-width': 18, 'stroke-linecap': 'round', 'stroke-dasharray': C.toFixed(2), transform: 'rotate(-90 110 110)' }, s), C]);
        });
        var t = k.el('text', { x: 110, y: 116, 'text-anchor': 'middle', 'font-family': UI, 'font-weight': 600, 'font-size': 17, class: 'tc-num' }, s);
        return function (d) {
          var L = Math.max(d.left, 0), f = [d.frac, (L % 3600) / 3600, (L % 60) / 60];
          arcs.forEach(function (a, i) { a[0].setAttribute('stroke-dashoffset', (a[1] * (1 - f[i])).toFixed(2)); });
          t.textContent = hms(d.left); t.style.fill = d.over ? 'var(--bad)' : 'var(--ink)';
        };
      } },

    { id: 'candle', name: 'Candle', note: 'A candle that burns down over your time. Out of wax means out of time.',
      build: function (k) {
        var s = k.svg();
        k.el('ellipse', { cx: 110, cy: 196, rx: 62, ry: 10, fill: 'var(--line)' }, s);
        var body = k.el('rect', { x: 84, width: 52, rx: 6, fill: '#f3ead8', stroke: '#d6c7a6' }, s);
        var drip = k.el('path', { fill: '#e9dcc0' }, s);
        var wick = k.el('line', { x1: 110, x2: 110, stroke: '#333', 'stroke-width': 2 }, s);
        var at = k.el('g', {}, s), flame = k.el('g', { class: 'tc-flame' }, at);
        k.el('path', { d: 'M0 0 C-10 -12 -6 -28 0 -38 C6 -28 10 -12 0 0 Z', fill: '#ffb020' }, flame);
        k.el('path', { d: 'M0 -2 C-5 -9 -3 -18 0 -24 C3 -18 5 -9 0 -2 Z', fill: '#fff3c0' }, flame);
        var t = k.el('text', { x: 200, y: 36, 'text-anchor': 'end', 'font-family': MONO, 'font-size': 15, class: 'tc-num' }, s);
        return function (d) {
          var top = 192 - (14 + d.frac * 130);
          body.setAttribute('y', top); body.setAttribute('height', 192 - top);
          drip.setAttribute('d', 'M84 ' + (top + 4) + ' h14 v16 a3 3 0 0 1 -6 0 v-8 a3 3 0 0 0 -6 0 z');
          wick.setAttribute('y1', top); wick.setAttribute('y2', top - 8);
          at.setAttribute('transform', 'translate(110 ' + (top - 6) + ')'); at.style.display = d.over ? 'none' : '';
          t.textContent = hms(d.left); t.style.fill = d.over ? 'var(--bad)' : 'var(--ink-2)';
        };
      } },

    { id: 'words', name: 'In words', note: 'No numbers at all. The time left, written out as a sentence.',
      build: function (k) {
        var p = k.h('p', 'tc-words');
        return function (d) {
          var m = Math.round(Math.abs(d.left) / 60), H = Math.floor(m / 60), M = m % 60, parts = [];
          if (H) parts.push(word(H) + (H > 1 ? ' hours' : ' hour'));
          if (M) parts.push(word(M) + (M > 1 ? ' minutes' : ' minute'));
          var txt = parts.join(' and ') || 'no time';
          p.innerHTML = d.over ? 'You’re <em>' + txt + '</em> over.' : '<em>' + txt.charAt(0).toUpperCase() + txt.slice(1) + '</em> left.';
        };
      } },

    { id: 'pomodoro', name: 'Pomodoro rounds', note: 'Your time cut into 25-minute rounds with 5-minute breaks.',
      build: function (k, d0) {
        var R = Math.max(1, Math.round(d0.budget / 1800)), box = k.h('div', 'tc-pomo'), top = k.h('div', 'top', box, '<b></b><span></span>'), rounds = k.h('div', 'rounds', box), rows = [];
        for (var i = 0; i < Math.min(R, 4); i++) { var r = k.h('div', 'r', rounds); rows.push([k.h('div', 'w', r, '<i></i>').firstChild, k.h('div', 'b', r, '<i></i>').firstChild]); }
        return function (d) {
          var u = Math.max(Math.min(d.used * R * 30, R * 30), 0), cur = Math.min(Math.floor(u / 30), R - 1), inR = u - cur * 30;
          var first = Math.max(0, Math.min(cur - 1, R - rows.length));
          rows.forEach(function (r, j) {
            var i = first + j, w = i < cur ? 25 : i > cur ? 0 : Math.min(inR, 25), b = i < cur ? 5 : i > cur ? 0 : Math.max(inR - 25, 0);
            r[0].style.width = (w / 25 * 100) + '%'; r[1].style.width = (b / 5 * 100) + '%';
          });
          var onBreak = inR >= 25, leftIn = Math.max(((onBreak ? 30 : 25) - inR) * 60, 0);
          top.firstChild.textContent = d.over ? '+' + hm(-d.left) : Math.floor(leftIn / 60) + ':' + pad(Math.floor(leftIn % 60));
          top.lastChild.textContent = d.over ? 'Over time' : onBreak ? 'Break' : 'Round ' + (cur + 1) + ' of ' + R;
        };
      } },

    { id: 'battery', name: 'Battery', note: 'A battery that drains: green, then yellow, then red near the end.',
      build: function (k) {
        var box = k.h('div', 'tc-battery'), cell = k.h('div', 'cell', box, '<div class="fill"></div>'), b = k.h('b', '', box);
        return function (d) {
          var f = cell.firstChild; f.style.width = (d.frac * 100) + '%';
          f.style.background = d.frac > .4 ? '#2fa84f' : d.frac > .15 ? '#e6a817' : '#e0322b';
          b.textContent = d.over ? 'Over by ' + hm(-d.left) : Math.round(d.frac * 100) + '% · ' + hm(d.left);
        };
      } },

    { id: 'kitchen', name: 'Kitchen timer', note: 'A twist dial like an egg timer, turning back toward zero under the pointer.',
      build: function (k, d0) {
        var s = k.svg(), mins = Math.max(d0.budget / 60, 1);
        k.el('circle', { cx: 110, cy: 112, r: 100, fill: '#f6f1e7', stroke: '#d8cfbd', 'stroke-width': 2 }, s);
        var dial = k.el('g', {}, s);
        for (var i = 0; i < 48; i++) {
          var big = i % 6 === 0, a = polar(110, 112, 92, i / 48), b = polar(110, 112, big ? 80 : 86, i / 48);
          k.el('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: '#3a332a', 'stroke-width': big ? 2 : 1 }, dial);
          if (big) { var p = polar(110, 112, 67, i / 48); k.el('text', { x: p[0], y: p[1] + 4, 'text-anchor': 'middle', 'font-family': UI, 'font-weight': 600, 'font-size': 11, fill: '#3a332a' }, dial, minLabel(mins * i / 48)); }
        }
        k.el('circle', { cx: 110, cy: 112, r: 40, fill: '#e94b35' }, s);
        k.el('rect', { x: 104, y: 76, width: 12, height: 72, rx: 6, fill: '#c63b28' }, s);
        k.el('path', { d: 'M110 22 L102 6 H118 Z', fill: '#e94b35' }, s);
        return function (d) { dial.setAttribute('transform', 'rotate(' + (-d.frac * 360).toFixed(2) + ' 110 112)'); };
      } }
  ];
  var BY_ID = {};
  FACES.forEach(function (f) { BY_ID[f.id] = f; });

  // Build `id` into `host`. Faces whose layout depends on the budget are rebuilt when it changes.
  function mount(host, id) {
    var face = BY_ID[id] || FACES[0], win = host.ownerDocument.defaultView, draw = null, budget = null, last = null, raf = 0;
    host.className = host.className.replace(/\btc(-[\w-]+)?\b/g, '').trim() + ' tc tc-' + face.id + (face.cls ? ' ' + face.cls : '');
    function full(d) {
      var b = Math.max(d.budget || 0, 1), left = d.left || 0;
      return { left: left, budget: b, frac: Math.min(Math.max(left / b, 0), 1), used: Math.min(Math.max(1 - left / b, 0), 1),
        over: left < 0, label: d.label || 'LEFT TO WORK', sub: d.sub || '', running: !!d.running, t: win.performance.now() };
    }
    var token = host._tcToken = {};
    function loop() {
      raf = 0;
      if (!host.isConnected || host._tcToken !== token) return;
      if (last && draw) draw(full(last));
      raf = win.requestAnimationFrame(loop);
    }
    return function update(d) {
      last = d;
      var f = full(d);
      if (!draw || f.budget !== budget) {
        while (host.firstChild) host.removeChild(host.firstChild);
        budget = f.budget;
        draw = face.build(kit(host), f);
      }
      draw(f);
      if (face.live && !raf) raf = win.requestAnimationFrame(loop);
    };
  }

  var api = { faces: FACES.map(function (f) { return { id: f.id, name: f.name, note: f.note }; }), mount: mount, hms: hms };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TempoClocks = api;
})(typeof window !== 'undefined' ? window : this);
