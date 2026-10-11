/* Tempo: say what you need to do, see if it fits the time you have.
   Plain DOM, data lives in localStorage. */
(function () {
  'use strict';

  var KEY = 'tempo:v1';
  var DAY = 86400000;
  var DEFAULT_EST = 30;
  var PRI_RANK = { high: 0, med: 1, low: 2 };
  var PRI_LABEL = { high: 'High', med: 'Med', low: 'Low' };
  var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var CATS = ['School', 'Work', 'Home', 'Errands', 'Health', 'Money', 'Personal', 'Other'];
  var RING = 2 * Math.PI * 52;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  // ---------- State ----------
  function blank() {
    return { periods: [], activePeriodId: null, tasks: [], running: null, learn: {}, settings: { theme: 'system', pomodoro: false } };
  }

  function normalize(s) {
    var b = blank();
    if (!s || typeof s !== 'object') return b;
    var periods = Array.isArray(s.periods) ? s.periods.filter(function (p) { return p && p.id && p.start && p.end; }) : [];
    var tasks = Array.isArray(s.tasks) ? s.tasks.filter(function (t) { return t && t.id && t.periodId; }).map(function (t) {
      return {
        id: String(t.id), periodId: String(t.periodId), title: String(t.title || 'Untitled'),
        estMin: Math.max(0, Number(t.estMin) || 0), priority: PRI_RANK[t.priority] != null ? t.priority : 'med',
        due: t.due || '', category: catName(t.category || t.tag || '') || 'Other', notes: t.notes || '',
        done: !!t.done, carried: !!t.carried, doneAt: t.doneAt || null, order: Number(t.order) || 0,
        logs: Array.isArray(t.logs) ? t.logs.filter(function (l) { return l && l.end > l.start; }) : []
      };
    }) : [];
    var active = periods.some(function (p) { return p.id === s.activePeriodId; }) ? s.activePeriodId : (periods.length ? periods[periods.length - 1].id : null);
    var running = s.running && tasks.some(function (t) { return t.id === s.running.taskId; }) ? s.running : null;
    return {
      periods: periods, activePeriodId: active, tasks: tasks, running: running,
      learn: s.learn && typeof s.learn === 'object' ? s.learn : {},
      settings: Object.assign(b.settings, s.settings || {})
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      return raw ? normalize(JSON.parse(raw)) : blank();
    } catch (e) { return blank(); }
  }

  var storageWarned = false;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) {
      if (!storageWarned) { toast('Can’t save in this browser. Export a backup so you don’t lose your work.'); storageWarned = true; }
    }
  }

  var state = load();
  var ui = { filter: 'open', search: '', editingTaskId: null, editingPeriodId: null, focusId: null, pomo: null };

  // ---------- Utils ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function daysBetween(a, b) { return Math.round((b - a) / DAY); }
  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function catName(s) {
    s = String(s || '').trim().replace(/^#/, '');
    if (!s) return '';
    for (var i = 0; i < CATS.length; i++) if (CATS[i].toLowerCase() === s.toLowerCase()) return CATS[i];
    return capFirst(s);
  }

  function fmt(min) {
    min = Math.max(0, Math.round(min));
    var h = Math.floor(min / 60), m = min % 60;
    if (!h) return m + 'm';
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }
  function fmtShortDate(s) {
    return parseISO(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtRange(p) {
    var o = { month: 'short', day: 'numeric' };
    return parseISO(p.start).toLocaleDateString(undefined, o) + ' – ' + parseISO(p.end).toLocaleDateString(undefined, o);
  }

  // Form fields: "2h", "1h30m", "90m", "1.5", "1:30" → minutes. Bare numbers are hours.
  function parseDuration(str) {
    if (str == null) return null;
    var s = String(str).trim().toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    var m;
    if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
    if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    if ((m = s.match(/^(?:(\d+(?:[.,]\d+)?)h(?:rs?|ours?)?)?(?:(\d+)m(?:in(?:s|utes?)?)?)?$/)) && (m[1] || m[2])) {
      return Math.round((m[1] ? parseFloat(m[1].replace(',', '.')) * 60 : 0) + (m[2] ? +m[2] : 0));
    }
    return null;
  }

  // ---------- Natural-language parsing ----------
  var NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, 'forty five': 45, fifty: 50, sixty: 60, ninety: 90,
    couple: 2, 'a couple': 2, 'a couple of': 2, 'couple of': 2, few: 3, 'a few': 3 };
  function num(w) {
    w = String(w).toLowerCase().replace(/\s+/g, ' ').trim();
    if (/^\d+([.,]\d+)?$/.test(w)) return parseFloat(w.replace(',', '.'));
    return NUM[w] != null ? NUM[w] : null;
  }
  var NUMW = '(\\d+(?:[.,]\\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty(?:[- ]five)?|fifty|sixty|ninety|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few)';
  var LEAD = '(?:\\b(?:which|that|it|this)\\s+)?(?:(?:for|takes?|taking|(?:(?:would|will|should|might|could|may|it\'?ll)\\s+|(?:is|are|it\'?s)\\s+(?:gonna|going\\s+to)\\s+|gonna\\s+)(?:probably\\s+|likely\\s+|only\\s+)?take|about|around|roughly|approx(?:imately)?|like|~|maybe|probably|only|just)\\s*)*';
  var HRS = '(?:h|hrs?|hours?)';
  var MINS = '(?:m|mins?|minutes?)';
  var DURATIONS = [
    [new RegExp(LEAD + '\\b(?:half\\s+an?\\s+hour|half\\s+hour|half-hour)\\b', 'i'), function () { return 30; }],
    [new RegExp(LEAD + '\\b' + NUMW + '\\s+' + HRS + '\\s+and\\s+a\\s+half\\b', 'i'), function (m) { return num(m[1]) * 60 + 30; }],
    [new RegExp(LEAD + '\\b' + NUMW + '\\s+and\\s+a\\s+half\\s+' + HRS + '\\b', 'i'), function (m) { return num(m[1]) * 60 + 30; }],
    [new RegExp(LEAD + '\\b(\\d+)h(\\d{1,2})\\b', 'i'), function (m) { return +m[1] * 60 + +m[2]; }],
    [new RegExp(LEAD + '(?:\\b|~)' + NUMW + '\\s*' + HRS + '\\b(?:\\s*(?:and\\s*)?(\\d+)\\s*' + MINS + '\\b)?', 'i'), function (m) { return num(m[1]) * 60 + (m[2] ? +m[2] : 0); }],
    [new RegExp(LEAD + '(?:\\b|~)' + NUMW + '\\s*' + MINS + '\\b', 'i'), function (m) { var n = num(m[1]); return /few/i.test(m[1]) ? 10 : n; }]
  ];
  function takeDuration(s) {
    for (var i = 0; i < DURATIONS.length; i++) {
      var m = s.match(DURATIONS[i][0]);
      if (m) {
        var v = DURATIONS[i][1](m);
        if (v != null && !isNaN(v) && v > 0) return { min: Math.round(v), rest: s.replace(m[0], ' ') };
      }
    }
    return { min: null, rest: s };
  }

  var PRI_LOW = /\b(?:low\s+priority|low\s+prio|if\s+i\s+(?:have|get)\s+(?:the\s+)?time|whenever|someday|no\s+rush|not\s+urgent|not\s+important|optional|eventually)\b|!(?:low|lo|l|3)\b/i;
  var PRI_HIGH = /\b(?:urgent(?:ly)?|asap|important|high\s+priority|top\s+priority|critical|must\s+do)\b|!(?:high|hi|h|1)\b|!!/i;
  var PRI_MED = /!(?:med|medium|m|2)\b/i;
  function takePriority(s) {
    var m;
    if ((m = s.match(PRI_LOW))) return { pri: 'low', rest: s.replace(m[0], ' ') };
    if ((m = s.match(PRI_HIGH))) return { pri: 'high', rest: s.replace(m[0], ' ') };
    if ((m = s.match(PRI_MED))) return { pri: 'med', rest: s.replace(m[0], ' ') };
    return { pri: null, rest: s };
  }

  function nextWeekday(idx, allowToday) {
    var t = today(), diff = (idx - t.getDay() + 7) % 7;
    if (diff === 0 && !allowToday) diff = 7;
    return iso(addDays(t, diff));
  }
  function dueFromWord(w) {
    w = w.toLowerCase().replace(/\s+/g, ' ');
    var t = today(), m;
    if (w === 'today' || w === 'tonight' || w === 'tod') return iso(t);
    if (w === 'tomorrow' || w === 'tmr' || w === 'tom') return iso(addDays(t, 1));
    if (/^(this )?weekend$/.test(w)) return nextWeekday(6, true);
    if (/^end of (the )?week$/.test(w)) return nextWeekday(5, true);
    if (w === 'next week') return nextWeekday(1, false);
    for (var i = 0; i < 7; i++) {
      var full = WEEKDAYS[i];
      if (w === full || (w.length >= 3 && full.indexOf(w) === 0)) return nextWeekday(i, true);
    }
    if ((m = w.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(new Date(+m[1], +m[2] - 1, +m[3]));
    if ((m = w.match(/^(\d{1,2})\/(\d{1,2})$/))) {
      var d = new Date(t.getFullYear(), +m[1] - 1, +m[2]);
      if (d < addDays(t, -60)) d.setFullYear(d.getFullYear() + 1);
      return iso(d);
    }
    return null;
  }
  var DAYWORD = '(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|(?:this\\s+)?weekend|end\\s+of\\s+(?:the\\s+)?week|next\\s+week)';
  var DUE_RES = [
    new RegExp('@(\\S+)', 'i'),
    new RegExp('\\b(?:due|by|on|before|until|for)\\s+(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|\\d{1,2}\\/\\d{1,2}|\\d{4}-\\d{1,2}-\\d{1,2})\\b', 'i'),
    new RegExp('\\b(?:(?:due|by|on|before|until|for)\\s+)?(?:(?:this|next)\\s+(?=monday|tuesday|wednesday|thursday|friday|saturday|sunday))?' + DAYWORD + '\\b', 'i')
  ];
  function takeDue(s) {
    for (var i = 0; i < DUE_RES.length; i++) {
      var m = s.match(DUE_RES[i]);
      if (m) {
        var d = dueFromWord(m[1]);
        if (d) return { due: d, rest: s.replace(m[0], ' ') };
      }
    }
    return { due: '', rest: s };
  }

  var CAT_ALIAS = { school: 'School', class: 'School', uni: 'School', college: 'School', university: 'School',
    work: 'Work', job: 'Work', 'the office': 'Work', 'my job': 'Work', home: 'Home', 'the house': 'Home', house: 'Home' };
  function takeCategory(s) {
    var m = s.match(/#([\w\-À-ž]+)/);
    if (m) return { cat: catName(m[1]), rest: s.replace(m[0], ' ') };
    m = s.match(/\bfor\s+(school|class|uni|college|university|work|my\s+job|the\s+office|the\s+house)\b/i);
    if (m) return { cat: CAT_ALIAS[m[1].toLowerCase().replace(/\s+/g, ' ')], rest: s.replace(m[0], ' ') };
    return { cat: '', rest: s };
  }

  var LEAD_IN = /^(?:(?:and|also|then|plus|oh|so|ok|okay|um|uh|first|next|lastly|finally)[,:]?\s+)*(?:i\s+|we\s+)?(?:also\s+|really\s+|still\s+|definitely\s+)?(?:(?:need|needs|have|has|got|want|going)\s+to\s+|gotta\s+|gonna\s+|must\s+|should\s+|wanna\s+|'ll\s+|will\s+|remember\s+to\s+|don'?t\s+forget\s+to\s+|i'?ve\s+got\s+to\s+|i'?ll\s+)+/i;
  var TRAIL = /\s+(?:and|which|that|it|is|are|will|would|should|takes?|for|about|around|by|on|due|to|the|also|then|plus|maybe|like|with|probably)$/i;
  // Words that name a piece of work. "a quiz for my business class" → "Business class quiz".
  var TASK_NOUN = '(?:quiz(?:zes)?|tests?|exams?|midterms?|finals?|essays?|papers?|homework|hw|assignments?|projects?|reports?|presentations?|labs?|worksheets?|readings?|problem\\s+sets?|psets?|discussion\\s+posts?|posts?|reflections?|study\\s+guides?|notes|slides|decks?|proposals?|applications?|reviews?|summar(?:y|ies)|outlines?|drafts?|lectures?|chapters?|questions|exercises?|modules?|case\\s+stud(?:y|ies)|research|flashcards|portfolio|resume|cover\\s+letter|forms?|invoices?)';
  var WEAK_VERB = /^(?:do(?:ing)?|finish(?:ing)?|complete|completing|work(?:ing)?\s+on|get\s+done|take|taking|start(?:\s+on)?|knock\s+out|get\s+started\s+on|deal\s+with)\s+/i;
  var DETERMINERS = /\b(?:a|an|the|my|our|his|her|their|some|this|these|those)\s+(?=\S)/gi;
  var FILLER = /\b(?:real\s+quick|quickly|or\s+so|i\s+think|probably|basically|actually|just|kind\s+of|sort\s+of|at\s+some\s+point|as\s+well|too)\b/gi;

  function tidy(s) {
    var prev;
    do {
      prev = s;
      s = s.replace(LEAD_IN, '').replace(/^to\s+/i, '').replace(/^[\s,.;:!?\-–—]+|[\s,.;:!?\-–—(]+$/g, '').replace(TRAIL, '').trim();
    } while (s !== prev);
    return s.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ');
  }

  // Boil a spoken phrase down to the thing to do.
  function condense(s) {
    s = s.replace(FILLER, ' ').replace(/\s{2,}/g, ' ').trim();
    // "go to the gym" → "gym", "go for a run" → "run"
    s = s.replace(/^go\s+(?:to\s+|for\s+)?(?=\S)/i, '');
    // Drop a weak verb when what follows is a piece of work: "do a quiz…" → "quiz…"
    var noVerb = s.replace(WEAK_VERB, '');
    if (noVerb !== s && new RegExp('^(?:(?:a|an|the|my|our|this|that|some)\\s+)?(?:[\\w\'-]+\\s+){0,2}' + TASK_NOUN + '\\b', 'i').test(noVerb)) s = noVerb;
    s = s.replace(DETERMINERS, '').replace(/\s{2,}/g, ' ').trim();
    // "quiz for business class" → "business class quiz"
    var m = s.match(new RegExp('^((?:[\\w\'-]+\\s+){0,2}' + TASK_NOUN + ')\\s+(?:for|in|on|of|from|about)\\s+(.{2,40})$', 'i'));
    if (m && m[2].split(/\s+/).length <= 4 && !/\b(?:and|with|to)\b/i.test(m[2])) s = m[2] + ' ' + m[1];
    return s;
  }

  function cleanTitle(s) {
    s = tidy(s.replace(/\s+/g, ' ').trim());
    s = tidy(condense(s));
    // Keep short all-caps words (AP, SAT) and capitalise the first letter.
    return capFirst(s);
  }

  // One task out of one phrase.
  function parseOne(text, forcedCat) {
    var s = ' ' + text + ' ';
    var c = takeCategory(s); s = c.rest;
    var d = takeDuration(s); s = d.rest;
    var p = takePriority(s); s = p.rest;
    var u = takeDue(s); s = u.rest;
    var title = cleanTitle(s);
    var cat = c.cat || forcedCat || '';
    return {
      title: title, estMin: d.min, priority: p.pri || 'med', due: u.due,
      category: cat || classify(title), catAuto: !cat
    };
  }

  function hasDuration(s) { return takeDuration(' ' + s + ' ').min != null; }
  function wordCount(s) { return s.trim().split(/\s+/).filter(Boolean).length; }

  // A whole brain dump → list of tasks.
  function parseDump(text) {
    var out = [], header = '';
    String(text).split(/\n+/).forEach(function (rawLine) {
      var line = rawLine.replace(/^\s*(?:[-*•·]|\d+[.)]|\[\s?\])\s+/, '').trim();
      if (!line) { header = ''; return; }
      var hm = line.match(/^([A-Za-zÀ-ž][\wÀ-ž &\-]{0,24}):\s*(.*)$/);
      var lineCat = header;
      if (hm && !/^\d/.test(hm[2])) {
        if (!hm[2]) { header = catName(CAT_ALIAS[hm[1].toLowerCase()] || hm[1]); return; }
        lineCat = catName(CAT_ALIAS[hm[1].toLowerCase()] || hm[1]);
        line = hm[2];
      }
      // Split on ; and sentence ends, then commas, then "and"/"then" between two real tasks.
      var parts = [];
      line.split(/;|\.\s+(?=[A-Za-z])|\.$/).forEach(function (sentence) {
        // Protect "an hour and a half" so the "and" splitter doesn't cut it.
        sentence = sentence.replace(/\band\s+a\s+half\b/gi, 'and_a_half');
        var bits = sentence.split(/,\s*(?:(?:and|then|also|plus)\s+)?|\s+(?:and\s+then|then\s+also|and\s+(?:i\s+)?also|(?:i\s+)?also|plus)\s+/i);
        var merged = [];
        bits.forEach(function (b) {
          b = b.trim();
          if (!b) return;
          // "buy eggs, milk, bread": a one-word fragment belongs to the previous task.
          // "…, which takes 20 min" or "…, milk" belongs to the previous task.
          var trailing = /^(?:which|that|it'?ll|it\s+will|it'?s|should|probably|maybe)\b/i.test(b);
          var restWords = wordCount(takeDuration(' ' + b + ' ').rest);
          if (merged.length && (trailing || restWords === 0 || (restWords === 1 && !hasDuration(b)))) merged[merged.length - 1] += ', ' + b;
          else merged.push(b);
        });
        merged.forEach(function (chunk) {
          var andParts = chunk.split(/\s+and\s+/i);
          var acc = andParts[0];
          for (var i = 1; i < andParts.length; i++) {
            var right = andParts[i];
            if (hasDuration(acc) || (wordCount(acc) >= 2 && wordCount(right) >= 2)) { parts.push(acc); acc = right; }
            else acc += ' and ' + right;
          }
          parts.push(acc);
        });
        parts = parts.map(function (x) { return x.replace(/and_a_half/g, 'and a half'); });
      });
      parts.forEach(function (p) {
        var t = parseOne(p, lineCat);
        if (t.title && /[a-z0-9À-ž]/i.test(t.title)) out.push(t);
      });
    });
    return out;
  }

  // ---------- Auto-categorizer ----------
  var CAT_WORDS = {
    School: 'study studying homework hw essay essays exam exams quiz quizzes test tests midterm midterms final finals class classes lecture lectures chapter chapters assignment assignments lab labs physics calc calculus math maths algebra geometry statistics stats chemistry chem biology bio history english spanish french latin literature ap sat act pset psets problem_set reading_assignment professor teacher syllabus flashcards revise revision thesis paper school course coursework textbook worksheet seminar tutor tutoring notes studyguide study_guide college university application applications scholarship psychology psych business marketing economics econ sociology philosophy government accounting anatomy physiology engineering cs programming art music discussion_post',
    Work: 'client clients meeting meetings email emails inbox report reports deck slides presentation pitch proposal invoice invoices deploy website websites site landing code coding bug bugs pr standup sprint ticket tickets launch portfolio boss manager coworker team project projects deadline spreadsheet figma design mockup mockups brief contract onboarding interview resume linkedin agency demo shift wireframe copy seo analytics pull_request code_review follow_up',
    Home: 'clean cleaning laundry dishes cook cooking dinner lunch breakfast vacuum tidy organize declutter repair trash garbage recycling garden plants bed room bedroom kitchen bathroom fridge closet mop dust iron ironing fold water_the_plants take_out meal_prep',
    Errands: 'buy groceries grocery shop shopping pharmacy package return store target costco walmart mall hardware haircut pick_up drop_off post_office dry_cleaning car_wash oil_change gas_station',
    Health: 'gym workout run running jog jogging exercise doctor dentist therapy therapist meditate meditation yoga sleep walk stretch stretching physio checkup appointment meds medicine vitamins swim swimming bike lift lifting cardio steps work_out',
    Money: 'pay bill bills taxes tax budget budgeting insurance renew rent mortgage refund subscription subscriptions loan venmo transfer expenses receipts finances savings invest investing bank credit_card',
    Personal: 'mom dad parents grandma grandpa family friend friends birthday gift gifts party date read reading book journal guitar piano drums practice hobby text call podcast movie travel trip pack packing vacation girlfriend boyfriend wife husband sister brother wedding church volunteer'
  };
  var CAT_INDEX = {}, CAT_PHRASES = [];
  Object.keys(CAT_WORDS).forEach(function (cat) {
    CAT_WORDS[cat].split(/\s+/).forEach(function (w) {
      if (!w) return;
      if (w.indexOf('_') >= 0) CAT_PHRASES.push([w.replace(/_/g, ' '), cat]);
      else CAT_INDEX[w] = cat;
    });
  });
  var STOP = { the: 1, and: 1, for: 1, with: 1, from: 1, into: 1, about: 1, this: 1, that: 1, some: 1, more: 1, all: 1, out: 1, off: 1, get: 1, make: 1, do: 1, finish: 1, start: 1, work: 0, my: 1, our: 1, your: 1, new: 1, before: 1, after: 1 };

  function wordsOf(s, minLen) {
    return String(s).toLowerCase().replace(/[^a-z0-9À-ž\s'-]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= (minLen || 3) && !STOP[w]; });
  }
  function stem(w) { return w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, ''); }

  function classify(title) {
    var text = ' ' + String(title).toLowerCase() + ' ';
    var score = {};
    var add = function (cat, n) { score[cat] = (score[cat] || 0) + n; };
    CAT_PHRASES.forEach(function (pc) { if (text.indexOf(' ' + pc[0] + ' ') >= 0) add(pc[1], 2.5); });
    wordsOf(title, 2).forEach(function (w) {
      var hit = CAT_INDEX[w] || CAT_INDEX[stem(w)];
      if (hit) add(hit, 1);
      var learned = state.learn[w] || state.learn[stem(w)];
      if (learned) Object.keys(learned).forEach(function (cat) { add(cat, learned[cat] * 1.6); });
    });
    // A custom category whose name appears in the title wins outright.
    usedCategories().forEach(function (cat) {
      if (CATS.indexOf(cat) < 0 && text.indexOf(' ' + cat.toLowerCase() + ' ') >= 0) add(cat, 5);
    });
    var best = 'Other', bestScore = 0;
    Object.keys(score).forEach(function (cat) { if (score[cat] > bestScore) { best = cat; bestScore = score[cat]; } });
    return best;
  }

  // Remember which category the person put a task in, so similar wording lands there next time.
  function learn(title, cat) {
    wordsOf(title).forEach(function (w) {
      var k = stem(w) || w;
      var row = state.learn[k] || (state.learn[k] = {});
      Object.keys(row).forEach(function (c) { if (c !== cat) row[c] = Math.max(0, row[c] - 0.5); });
      row[cat] = Math.min((row[cat] || 0) + 1, 6);
    });
  }

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

  // ---------- Derived data ----------
  function activePeriod() {
    for (var i = 0; i < state.periods.length; i++) if (state.periods[i].id === state.activePeriodId) return state.periods[i];
    return null;
  }
  function periodTasks(pid) { return state.tasks.filter(function (t) { return t.periodId === pid; }); }
  function taskById(id) { for (var i = 0; i < state.tasks.length; i++) if (state.tasks[i].id === id) return state.tasks[i]; return null; }
  function isRunning(t) { return !!(state.running && state.running.taskId === t.id); }

  function loggedMs(t) {
    var ms = 0;
    t.logs.forEach(function (l) { ms += l.end - l.start; });
    if (isRunning(t)) ms += Date.now() - state.running.start;
    return ms;
  }
  function loggedMin(t) { return loggedMs(t) / 60000; }
  function remainingMin(t) { return Math.max(t.estMin - loggedMin(t), 0); }

  function sortTasks(list) {
    return list.slice().sort(function (a, b) {
      return (PRI_RANK[a.priority] - PRI_RANK[b.priority]) || (a.order - b.order);
    });
  }
  function openTasks(pid) { return sortTasks(periodTasks(pid).filter(function (t) { return !t.done && !t.carried; })); }

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

  function metrics(p) {
    var tasks = periodTasks(p.id);
    var used = 0, remaining = 0, open = 0, done = 0;
    tasks.forEach(function (t) {
      var lg = loggedMin(t);
      if (t.done) { used += lg > 0 ? lg : t.estMin; done++; }
      else if (t.carried) { used += lg; }
      else { used += lg; remaining += remainingMin(t); open++; }
    });
    var budget = p.budgetMin;
    var total = used + remaining;
    var ratio = budget > 0 ? total / budget : (total > 0 ? Infinity : 0);
    var status = !tasks.length ? 'idle' : ratio > 1 ? 'over' : ratio > 0.85 ? 'tight' : 'fits';

    // Walk open tasks by priority and mark where the time left runs out.
    var avail = budget - used, cum = 0, cutIds = {}, cutCount = 0, cutMin = 0, cutting = false;
    openTasks(p.id).forEach(function (t) {
      var r = remainingMin(t);
      cum += r;
      if (!cutting && cum > avail + 0.01) cutting = true;
      if (cutting) { cutIds[t.id] = true; cutCount++; cutMin += r; }
    });

    var start = parseISO(p.start), endEx = addDays(parseISO(p.end), 1), now = Date.now();
    var len = endEx - start;
    return {
      tasks: tasks, used: used, remaining: remaining, total: total, budget: budget, ratio: ratio,
      status: status, open: open, done: done, cutIds: cutIds, cutCount: cutCount, cutMin: cutMin,
      free: budget - total, left: budget - used,
      elapsed: len > 0 ? Math.min(Math.max((now - start) / len, 0), 1) : 1,
      daysLeft: Math.max(Math.ceil((endEx - now) / DAY), 0),
      notStarted: now < start, ended: now >= endEx
    };
  }

  // ---------- Rendering ----------
  var ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/></svg>',
    focus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4v2H6v3zm11-5h4a1 1 0 0 1 1 1v4h-2V6h-3zM4 15h2v3h3v2H5a1 1 0 0 1-1-1zm14 0h2v4a1 1 0 0 1-1 1h-4v-2h3z"/></svg>',
    grip: '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>',
    note: '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" style="vertical-align:-1px;fill:currentColor"><path d="M3 2h10v8l-4 4H3zm1.5 1.5v9H8V9h3.5V3.5z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g></svg>',
    moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>',
    auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18zm0 2v14a7 7 0 0 1 0-14z" fill-rule="evenodd"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/></svg>'
  };

  function setText(sel, txt) { var el = $(sel); if (el) el.textContent = txt; }

  function render() {
    applyTheme();
    var p = activePeriod();
    var onboard = $('#onboard'), dash = $('#dashboard'), sel = $('#period-select');
    if (onboard) onboard.hidden = !!p;
    if (dash) dash.hidden = !p;
    if (sel) {
      sel.hidden = state.periods.length < 2;
      sel.innerHTML = state.periods.slice().reverse().map(function (x) {
        return '<option value="' + esc(x.id) + '"' + (x.id === state.activePeriodId ? ' selected' : '') + '>' + esc(x.name) + (x.closed ? ' (closed)' : '') + '</option>';
      }).join('');
    }
    if (!p) return;
    var m = metrics(p);
    renderHead(p, m);
    renderClock(p, m);
    renderNow(p, m);
    renderFit(p, m);
    renderGroups(p, m);
  }

  function renderHead(p, m) {
    var dates = fmtRange(p);
    if (p.closed) dates += ' · closed';
    else if (m.notStarted) dates += ' · starts in ' + daysBetween(today(), parseISO(p.start)) + 'd';
    else if (m.ended) dates += ' · ended';
    else dates += ' · ' + m.daysLeft + (m.daysLeft === 1 ? ' day' : ' days') + ' left';
    setText('#period-dates', dates);
    setText('#period-name', p.name);
  }

  // The dial: outer ring is the time left (drains as you work), inner ring is the work
  // still planned. Whatever part of the plan doesn't fit in the time left shows in red.
  var ticksFor = null;
  function drawTicks(budgetMin) {
    var g = $('#dial-ticks');
    if (!g || ticksFor === budgetMin) return;
    ticksFor = budgetMin;
    var hours = budgetMin / 60;
    var step = hours <= 30 ? 1 : hours <= 60 ? 2 : hours <= 150 ? 5 : 10;
    var count = Math.floor(hours / step), html = '';
    for (var i = 0; i < count; i++) {
      var a = (i * step / hours) * 2 * Math.PI, major = (i * step) % (step * 5) === 0;
      var r1 = major ? 93 : 95, r2 = 99;
      html += '<line' + (major ? ' class="major"' : '') + ' x1="' + (100 + r1 * Math.sin(a)).toFixed(2) + '" y1="' + (100 - r1 * Math.cos(a)).toFixed(2) +
        '" x2="' + (100 + r2 * Math.sin(a)).toFixed(2) + '" y2="' + (100 - r2 * Math.cos(a)).toFixed(2) + '"/>';
    }
    g.innerHTML = html;
  }
  function arc(el, start, len) {
    if (!el) return;
    len = Math.max(0, Math.min(len, 100));
    el.style.strokeDasharray = len.toFixed(3) + ' 100';
    el.style.strokeDashoffset = (-start).toFixed(3);
  }

  function renderClock(p, m) {
    var dial = $('#clock');
    if (!dial) return;
    var leftMs = m.left * 60000, over = leftMs < 0;
    var running = state.running && taskById(state.running.taskId);
    dial.classList.toggle('is-over', over);
    dial.classList.toggle('is-running', !!(running && running.periodId === p.id));
    drawTicks(m.budget);

    var secs = over ? Math.ceil(-leftMs / 1000) : Math.floor(leftMs / 1000);
    setText('#clock-label', over ? 'over budget' : 'left to work');
    setText('#clock-hm', (over ? '+' : '') + Math.floor(secs / 3600) + ':' + pad(Math.floor(secs / 60) % 60));
    setText('#clock-sec', ':' + pad(secs % 60));
    setText('#clock-sub', 'of ' + fmt(m.budget) + ' · ' + fmt(m.used) + ' worked');

    var b = m.budget > 0 ? m.budget : 1;
    var leftPct = Math.max(m.left, 0) / b * 100;
    arc($('#dial-left'), 0, leftPct);
    var fits = Math.min(m.remaining, Math.max(m.left, 0));
    arc($('#dial-work'), 0, fits / b * 100);
    arc($('#dial-over'), leftPct, (m.remaining - fits) / b * 100);
    var knob = $('#dial-knob');
    if (knob) {
      var a = Math.min(leftPct, 100) / 100 * 2 * Math.PI;
      knob.setAttribute('cx', (100 + 84 * Math.sin(a)).toFixed(2));
      knob.setAttribute('cy', (100 - 84 * Math.cos(a)).toFixed(2));
    }
    setText('#lg-left', m.left >= 0 ? fmt(m.left) : '−' + fmt(-m.left));
    setText('#lg-work', fmt(m.remaining));
  }

  function renderNow(p, m) {
    var box = $('#now');
    if (!box) return;
    var running = state.running && taskById(state.running.taskId);
    if (running && running.periodId === p.id) {
      box.className = 'now is-running';
      box.innerHTML = '<div class="now-text"><span class="now-label">Working on · <span data-live="' + esc(running.id) + '">' + fmt(loggedMin(running)) + '</span> of ' + fmt(running.estMin) + '</span>' +
        '<span class="now-title">' + esc(running.title) + '</span></div>' +
        '<button type="button" class="icon-btn" data-now="focus" data-id="' + esc(running.id) + '" aria-label="Focus mode" title="Focus mode">' + ICON.focus + '</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-now="toggle" data-id="' + esc(running.id) + '">' + 'Pause</button>';
      return;
    }
    var next = openTasks(p.id)[0];
    box.className = 'now';
    if (!next) {
      box.innerHTML = '<div class="now-text"><span class="now-label">Up next</span><span class="now-title">Nothing left. Add tasks on the right.</span></div>';
      return;
    }
    box.innerHTML = '<div class="now-text"><span class="now-label">Up next · ' + esc(next.category) + '</span>' +
      '<span class="now-title">' + esc(next.title) + '</span></div>' +
      '<button type="button" class="icon-btn" data-now="focus" data-id="' + esc(next.id) + '" aria-label="Focus mode" title="Focus mode">' + ICON.focus + '</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-now="toggle" data-id="' + esc(next.id) + '">Start</button>';
  }

  function renderFit(p, m) {
    var acc = accuracy();
    var pill = $('#sum-status');
    if (pill) {
      pill.className = 'status-pill is-' + m.status;
      pill.textContent = { idle: 'No tasks yet', fits: 'Everything fits', tight: 'Tight fit', over: 'Plan is ' + fmt(m.total - m.budget) + ' over' }[m.status];
    }
    var realistic = acc.factor ? m.used + m.remaining * acc.factor : null;

    var pace = $('#st-pace'), paceSub = '';
    if (pace) {
      var word = '–', tone = '';
      if (!m.tasks.length) { /* nothing yet */ }
      else if (m.notStarted) { word = 'Not started'; paceSub = 'period hasn’t begun'; }
      else if (m.open === 0) { word = 'All done'; tone = 'tone-ok'; paceSub = 'nothing left to do'; }
      else if (m.ended || p.closed) { word = 'Ended'; tone = 'tone-warn'; paceSub = fmt(m.remaining) + ' unfinished'; }
      else {
        var diff = (m.total > 0 ? m.used / m.total : 0) - m.elapsed;
        word = diff > 0.1 ? 'Ahead' : diff < -0.1 ? 'Behind' : 'On track';
        tone = diff > 0.1 ? 'tone-ok' : diff < -0.1 ? 'tone-bad' : '';
        paceSub = '~' + fmt(m.daysLeft > 0 ? m.remaining / m.daysLeft : m.remaining) + '/day for ' + m.daysLeft + 'd';
      }
      pace.textContent = word;
      pace.className = tone;
    }
    setText('#st-pace-sub', paceSub);

    var accEl = $('#st-acc'), accSub = '';
    if (accEl) {
      if (!acc.factor) {
        accEl.textContent = '–'; accEl.className = '';
        accSub = 'time ' + (3 - acc.n) + ' more finished task' + (3 - acc.n === 1 ? '' : 's') + ' to learn this';
      } else {
        var d = Math.round((acc.factor - 1) * 100);
        if (Math.abs(d) <= 10) { accEl.textContent = 'Spot on'; accEl.className = 'tone-ok'; accSub = 'within 10% of your estimates'; }
        else if (d > 0) { accEl.textContent = '+' + d + '% longer'; accEl.className = 'tone-warn'; accSub = 'realistic total: ' + fmt(realistic); }
        else { accEl.textContent = Math.abs(d) + '% faster'; accEl.className = 'tone-ok'; accSub = 'realistic total: ' + fmt(realistic); }
      }
    }
    setText('#st-acc-sub', accSub);
  }

  function dueInfo(t) {
    if (!t.due) return null;
    var d = daysBetween(today(), parseISO(t.due));
    var cls = !t.done && d < 0 ? 'is-late' : !t.done && d <= 1 ? 'is-soon' : '';
    var label = d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : d === -1 ? 'Due yesterday' : 'Due ' + fmtShortDate(t.due);
    return { cls: cls, label: label };
  }

  function taskHTML(t, m) {
    var lg = loggedMin(t), running = isRunning(t);
    var cls = ['task'];
    if (t.done) cls.push('is-done');
    if (t.carried) cls.push('is-carried');
    if (running) cls.push('is-running');
    if (m.cutIds[t.id]) cls.push('no-fit');
    var due = dueInfo(t);
    var meta = ['<span class="pri pri-' + t.priority + '">' + PRI_LABEL[t.priority] + '</span>'];
    if (m.cutIds[t.id]) meta.push('<span class="nofit-tag">won’t fit</span>');
    if (due) meta.push('<span class="due ' + due.cls + '">' + esc(due.label) + '</span>');
    if (t.carried) meta.push('<span>moved to next period</span>');
    if (t.notes) meta.push('<span title="Has notes">' + ICON.note + ' note</span>');
    var progress = t.estMin > 0 ? Math.min(lg / t.estMin, 1) : (lg > 0 ? 1 : 0);
    var canDrag = !t.done && !t.carried;
    return '<li class="' + cls.join(' ') + '" data-id="' + esc(t.id) + '"' + (canDrag ? ' draggable="true"' : '') + '>' +
      '<span class="grip" aria-hidden="true">' + (canDrag ? ICON.grip : '') + '</span>' +
      '<input type="checkbox" class="check" aria-label="Mark “' + esc(t.title) + '” done"' + (t.done ? ' checked' : '') + (t.carried ? ' disabled' : '') + '>' +
      '<div class="task-main"><button type="button" class="task-title">' + esc(t.title) + '</button>' +
      '<div class="task-meta">' + meta.join('') + '</div></div>' +
      '<div class="task-time"><span class="logged" data-live="' + esc(t.id) + '">' + (lg >= 0.5 || running ? fmt(lg) : '–') + '</span> / <span class="est">' + fmt(t.estMin) + '</span>' +
      '<span class="task-bar' + (t.estMin > 0 && lg > t.estMin ? ' is-overrun' : '') + '"><i style="width:' + (progress * 100).toFixed(1) + '%"></i></span></div>' +
      '<div class="task-btns">' +
      (canDrag ?
        '<button type="button" class="icon-btn play" aria-label="' + (running ? 'Pause timer' : 'Start timer') + '" title="' + (running ? 'Pause' : 'Start timer') + '">' + (running ? ICON.pause : ICON.play) + '</button>' +
        '<button type="button" class="icon-btn focus-btn" aria-label="Focus mode" title="Focus mode">' + ICON.focus + '</button>' : '') +
      '</div></li>';
  }

  function renderGroups(p, m) {
    var box = $('#groups'), empty = $('#empty'), note = $('#nofit-note');
    if (!box) return;
    var q = ui.search.trim().toLowerCase();
    var match = function (t) { return !q || (t.title + ' ' + t.category + ' ' + t.notes).toLowerCase().indexOf(q) >= 0; };
    var visible = m.tasks.filter(function (t) {
      var closed = t.done || t.carried;
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
        '<ol class="tasks">' + open.concat(closed).map(function (t) { return taskHTML(t, m); }).join('') + '</ol></section>';
    }).join('');

    if (note) {
      note.hidden = !m.cutCount || ui.filter === 'done';
      note.textContent = m.cutCount + (m.cutCount === 1 ? ' task' : ' tasks') + ' (' + fmt(m.cutMin) + ') won’t fit in the time left';
    }
    if (empty) {
      empty.hidden = visible.length > 0;
      if (!visible.length) {
        if (q) empty.innerHTML = '<b>No matches</b>Try a different search.';
        else if (ui.filter === 'done') empty.innerHTML = '<b>Nothing finished yet</b>Check off a task and it shows up here.';
        else if (m.tasks.length) empty.innerHTML = '<b>All clear</b>Everything in this period is done. Nice work.';
        else empty.innerHTML = '<b>Nothing here yet</b>Tell Tempo what you need to do above, the way you’d say it.';
      }
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
  }

  // ---------- Theme ----------
  function applyTheme() {
    var mode = state.settings.theme;
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
    var btn = $('#theme-btn');
    if (btn) {
      btn.innerHTML = mode === 'light' ? ICON.sun : mode === 'dark' ? ICON.moon : ICON.auto;
      btn.setAttribute('aria-label', 'Theme: ' + mode + '. Click to change.');
      btn.title = 'Theme: ' + mode + ' (t)';
    }
  }
  function cycleTheme() {
    var order = ['system', 'light', 'dark'];
    state.settings.theme = order[(order.indexOf(state.settings.theme) + 1) % 3];
    save(); applyTheme();
    toast('Theme: ' + state.settings.theme);
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
    toastTimer = setTimeout(function () { el.classList.remove('is-on'); }, actionLabel ? 6000 : 3000);
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

  // ---------- Task actions ----------
  function addParsed(items) {
    var p = activePeriod();
    if (!p || !items.length) return [];
    var order = periodTasks(p.id).reduce(function (mx, t) { return Math.max(mx, t.order); }, 0);
    var added = items.map(function (q) {
      var t = {
        id: uid(), periodId: p.id, title: q.title, estMin: q.estMin != null ? q.estMin : DEFAULT_EST,
        priority: q.priority, due: q.due, category: q.category, notes: '', done: false, carried: false,
        doneAt: null, order: ++order, logs: []
      };
      state.tasks.push(t);
      if (!q.catAuto) learn(t.title, t.category);
      return t;
    });
    save(); render();
    return added;
  }

  function submitDump() {
    var input = $('#dump-input');
    if (!input) return;
    var items = parseDump(input.value);
    if (!items.length) { toast('Type a task or two first'); return; }
    var added = addParsed(items);
    input.value = '';
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
      save(); render();
    });
  }

  function renderPreview() {
    var input = $('#dump-input'), box = $('#dump-preview');
    if (!input || !box) return;
    var items = input.value.trim() ? parseDump(input.value) : [];
    box.innerHTML = items.slice(0, 12).map(function (t) {
      var meta = [t.estMin != null ? fmt(t.estMin) : '30m?'];
      if (t.priority !== 'med') meta.push(PRI_LABEL[t.priority]);
      if (t.due) meta.push('due ' + fmtShortDate(t.due));
      return '<li><span class="cat-chip" style="--cat:' + catColor(t.category) + '">' + esc(t.category) + '</span>' +
        '<b>' + esc(t.title) + '</b><span class="pv-meta">' + meta.join(' · ') + '</span></li>';
    }).join('') + (items.length > 12 ? '<li>+ ' + (items.length - 12) + ' more</li>' : '');
    var btn = $('#dump-submit');
    if (btn) btn.textContent = items.length > 1 ? 'Add ' + items.length : items.length === 1 ? 'Add' : 'Sort it';
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
    if (isRunning(removed)) state.running = null;
    state.tasks.splice(idx, 1);
    save(); render();
    toast('Deleted: ' + removed.title, 'Undo', function () {
      state.tasks.splice(Math.min(idx, state.tasks.length), 0, removed);
      save(); render();
    });
  }

  function openTaskDialog(id) {
    var t = taskById(id), dlg = $('#task-dialog'), f = $('#task-form');
    if (!t || !dlg || !f) return;
    ui.editingTaskId = id;
    f.title.value = t.title;
    f.est.value = fmt(t.estMin);
    f.logged.value = fmt(loggedMin(t));
    f.logged.dataset.orig = f.logged.value;
    f.priority.value = t.priority;
    f.due.value = t.due || '';
    f.category.value = t.category;
    f.notes.value = t.notes || '';
    var dl = $('#cat-list');
    if (dl) dl.innerHTML = CATS.concat(usedCategories().filter(function (c) { return CATS.indexOf(c) < 0; }))
      .map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
    dlg.showModal();
  }

  function saveTaskDialog() {
    var t = taskById(ui.editingTaskId), f = $('#task-form');
    if (!t || !f) return;
    var est = parseDuration(f.est.value);
    t.title = f.title.value.trim() || t.title;
    if (est != null) t.estMin = est;
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
      var ordered = openTasks(p.id).filter(function (t) { return t.id !== dragId; });
      var newCat = group.dataset.cat;
      if (li && li.dataset.id !== dragId) {
        var target = taskById(li.dataset.id);
        ordered.splice(ordered.indexOf(target) + (li.classList.contains('drop-above') ? 0 : 1), 0, moved);
        if (moved.priority !== target.priority) moved.priority = target.priority;
      } else {
        ordered.push(moved);
      }
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

  // ---------- Periods ----------
  function openPeriodDialog(mode) {
    var dlg = $('#period-dialog'), f = $('#period-form');
    if (!dlg || !f) return;
    var p = mode === 'edit' ? activePeriod() : null;
    ui.editingPeriodId = p ? p.id : null;
    setText('#period-dialog-title', p ? 'Edit period' : 'New period');
    if (p) {
      f.name.value = p.name; f.start.value = p.start; f.end.value = p.end; f.budget.value = fmt(p.budgetMin);
    } else {
      var t = today();
      f.name.value = state.periods.length ? '' : 'This week';
      f.start.value = iso(t);
      f.end.value = iso(addDays(t, 6));
      f.budget.value = '20h';
    }
    dlg.showModal();
  }

  function readPeriodForm(f) {
    var budget = parseDuration(f.budget.value);
    if (budget == null || budget <= 0) { toast('Enter the budget as hours, e.g. 20h or 12.5'); return null; }
    if (f.end.value < f.start.value) { toast('The period has to end on or after its start'); return null; }
    return { name: f.name.value.trim() || 'Untitled period', start: f.start.value, end: f.end.value, budgetMin: budget };
  }

  function savePeriodDialog() {
    var f = $('#period-form');
    var data = f && readPeriodForm(f);
    if (!data) return false;
    var p = ui.editingPeriodId && state.periods.find(function (x) { return x.id === ui.editingPeriodId; });
    if (p) Object.assign(p, data);
    else {
      p = Object.assign({ id: uid(), closed: false }, data);
      state.periods.push(p);
      state.activePeriodId = p.id;
    }
    save(); render();
    if (!ui.editingPeriodId) setTimeout(function () { var i = $('#dump-input'); if (i) i.focus(); }, 50);
    return true;
  }

  function openCloseDialog() {
    var p = activePeriod(), dlg = $('#close-dialog'), f = $('#close-form');
    if (!p || !dlg || !f) return;
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
    var note = '';
    if (actDone >= 1 && estDone > 0) {
      var d = Math.round((actDone / estDone - 1) * 100);
      note = Math.abs(d) <= 10 ? 'Your estimates were within 10% this period.' :
        d > 0 ? 'Finished tasks took ' + d + '% longer than estimated. Pad next period’s estimates, or plan fewer tasks.' :
        'Finished tasks took ' + Math.abs(d) + '% less time than estimated.';
    }
    setText('#recap-note', note);
    // Suggest the next period: same length, starting the day after this one ends.
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

  function saveCloseDialog() {
    var p = activePeriod(), f = $('#close-form');
    var data = p && f && readPeriodForm(f);
    if (!data) return false;
    var np = Object.assign({ id: uid(), closed: false }, data);
    p.closed = true;
    state.periods.push(np);
    if (f.carry.checked) {
      var i = 0;
      openTasks(p.id).forEach(function (t) {
        t.carried = true;
        state.tasks.push({
          id: uid(), periodId: np.id, title: t.title, estMin: Math.max(Math.round(remainingMin(t)), 15),
          priority: t.priority, due: t.due, category: t.category, notes: t.notes, done: false, carried: false,
          doneAt: null, order: ++i, logs: []
        });
      });
    }
    state.activePeriodId = np.id;
    save(); render();
    toast('Started ' + np.name);
    return true;
  }

  // ---------- Focus mode ----------
  function openFocus(id) {
    var t = id ? taskById(id) : null;
    if (!t) {
      var p = activePeriod();
      if (!p) return;
      var running = state.running && taskById(state.running.taskId);
      t = running && running.periodId === p.id ? running : openTasks(p.id)[0];
    }
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
    setText('#focus-of', t.estMin ? (min > t.estMin ? fmt(min - t.estMin) + ' over the ' + fmt(t.estMin) + ' estimate' : 'of ' + fmt(t.estMin) + ' estimated') : 'no estimate');
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
      if (line) {
        line.hidden = false;
        line.textContent = (ui.pomo.phase === 'work' ? 'Focus round · ' : 'Break · ') + fmtClock(left).replace(/^0:/, '') + ' left';
      }
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
    try { if (window.Notification && Notification.permission === 'granted') new Notification(title, { body: body }); } catch (e) { /* ignore */ }
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
        state = next;
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
    var mk = function (o, i) { return Object.assign({ id: uid(), notes: '', due: '', done: false, carried: false, doneAt: null, order: i + 1, logs: [] }, o); };
    var learnKeep = state.learn;
    state = blank();
    state.learn = learnKeep || {};
    state.periods = [
      { id: prev, name: 'Last week', start: iso(addDays(t, -9)), end: iso(addDays(t, -3)), budgetMin: 18 * 60, closed: true },
      { id: pid, name: 'This week', start: iso(addDays(t, -2)), end: iso(addDays(t, 4)), budgetMin: 20 * 60, closed: false }
    ];
    state.tasks = [
      mk({ periodId: prev, title: 'Lab report: projectile motion', estMin: 120, priority: 'high', category: 'School', done: true, doneAt: now - 6 * DAY, logs: log(165, 6) }, 0),
      mk({ periodId: prev, title: 'Update portfolio case study', estMin: 90, priority: 'med', category: 'Work', done: true, doneAt: now - 5 * DAY, logs: log(110, 5) }, 1),
      mk({ periodId: prev, title: 'Client call prep', estMin: 30, priority: 'med', category: 'Work', done: true, doneAt: now - 4 * DAY, logs: log(35, 4) }, 2),
      mk({ periodId: pid, title: 'Finish launch checklist for client site', estMin: 180, priority: 'high', category: 'Work', due: iso(addDays(t, 1)), logs: log(70, 1) }, 0),
      mk({ periodId: pid, title: 'AP Physics problem set 6', estMin: 120, priority: 'high', category: 'School', due: iso(addDays(t, 2)) }, 1),
      mk({ periodId: pid, title: 'Study for calc quiz', estMin: 150, priority: 'high', category: 'School', due: iso(addDays(t, 3)), notes: 'Chapters 4.1–4.4, related rates.' }, 2),
      mk({ periodId: pid, title: 'Reply to client emails', estMin: 30, priority: 'med', category: 'Work', done: true, doneAt: now - DAY, logs: log(25, 1) }, 3),
      mk({ periodId: pid, title: 'Write essay draft', estMin: 240, priority: 'med', category: 'School', due: iso(addDays(t, 4)) }, 4),
      mk({ periodId: pid, title: 'Redesign pricing page', estMin: 300, priority: 'med', category: 'Work' }, 5),
      mk({ periodId: pid, title: 'Gym', estMin: 60, priority: 'med', category: 'Health' }, 6),
      mk({ periodId: pid, title: 'Buy groceries', estMin: 45, priority: 'med', category: 'Errands' }, 7),
      mk({ periodId: pid, title: 'Edit video reel', estMin: 180, priority: 'low', category: 'Work' }, 8),
      mk({ periodId: pid, title: 'Do laundry', estMin: 30, priority: 'low', category: 'Home' }, 9),
      mk({ periodId: pid, title: 'Call grandma', estMin: 30, priority: 'low', category: 'Personal' }, 10)
    ];
    state.activePeriodId = pid;
    ui.search = ''; ui.filter = 'open';
    $$('.seg-btn').forEach(function (x) { x.classList.toggle('is-on', x.dataset.filter === 'open'); });
    save(); render();
    toast('Sample week loaded');
  }

  // ---------- Events ----------
  function closeMenu() { var m = $('#menu'); if (m) m.open = false; }

  function handleAction(action) {
    closeMenu();
    if (action === 'new-period') openPeriodDialog('new');
    else if (action === 'edit-period') { if (activePeriod()) openPeriodDialog('edit'); }
    else if (action === 'close-period') { if (activePeriod()) openCloseDialog(); else toast('No period to close'); }
    else if (action === 'export') exportJSON();
    else if (action === 'import') { var inp = $('#import-file'); if (inp) inp.click(); }
    else if (action === 'sample') loadSample();
    else if (action === 'help') { var h = $('#help-dialog'); if (h) h.showModal(); }
    else if (action === 'reset') {
      if (confirm('Erase all periods and tasks? This can’t be undone. Export a backup first if you might want them.')) {
        state = blank(); save(); render(); toast('Everything erased');
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
      if (now) {
        if (now.dataset.now === 'toggle') toggleTimer(now.dataset.id);
        else openFocus(now.dataset.id);
        return;
      }
      var menu = $('#menu');
      if (menu && menu.open && !e.target.closest('#menu')) closeMenu();
    });

    var themeBtn = $('#theme-btn');
    if (themeBtn) themeBtn.addEventListener('click', cycleTheme);

    var sel = $('#period-select');
    if (sel) sel.addEventListener('change', function () { state.activePeriodId = sel.value; save(); render(); });

    var dump = $('#dump'), di = $('#dump-input');
    if (dump && di) {
      dump.addEventListener('submit', function (e) { e.preventDefault(); submitDump(); });
      di.addEventListener('input', function () { autoGrow(di); renderPreview(); });
      di.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitDump(); }
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
        else if (e.target.closest('.task-title')) openTaskDialog(id);
      });
      groups.addEventListener('change', function (e) {
        if (!e.target.classList.contains('check')) return;
        var li = e.target.closest('.task');
        if (li) setDone(li.dataset.id, e.target.checked);
      });
      groups.addEventListener('dragstart', onDragStart);
      groups.addEventListener('dragover', onDragOver);
      groups.addEventListener('drop', onDrop);
      groups.addEventListener('dragend', onDragEnd);
    }

    var pf = $('#period-form');
    if (pf) pf.addEventListener('submit', function (e) {
      e.preventDefault();
      if (savePeriodDialog()) $('#period-dialog').close();
    });
    var tf = $('#task-form');
    if (tf) tf.addEventListener('submit', function (e) {
      e.preventDefault();
      saveTaskDialog();
      $('#task-dialog').close();
    });
    var td = $('#task-delete');
    if (td) td.addEventListener('click', function () {
      var id = ui.editingTaskId;
      $('#task-dialog').close();
      deleteTask(id);
    });
    var cf = $('#close-form');
    if (cf) cf.addEventListener('submit', function (e) {
      e.preventDefault();
      if (saveCloseDialog()) $('#close-dialog').close();
    });

    var imp = $('#import-file');
    if (imp) imp.addEventListener('change', function () { if (imp.files && imp.files[0]) importJSON(imp.files[0]); imp.value = ''; });

    var ft = $('#focus-toggle');
    if (ft) ft.addEventListener('click', function () {
      if (ui.pomo && ui.pomo.phase === 'break') ui.pomo = null;
      focusToggle();
    });
    var fd = $('#focus-done');
    if (fd) fd.addEventListener('click', function () { var id = ui.focusId; closeFocus(); setDone(id, true); });
    var fx = $('#focus-exit');
    if (fx) fx.addEventListener('click', closeFocus);
    var pt = $('#pomo-toggle');
    if (pt) pt.addEventListener('change', function () {
      state.settings.pomodoro = pt.checked;
      if (!pt.checked) ui.pomo = null;
      else {
        if (window.Notification && Notification.permission === 'default') { try { Notification.requestPermission(); } catch (e) { /* ignore */ } }
        if (state.running && state.running.taskId === ui.focusId) ui.pomo = { phase: 'work', endsAt: Date.now() + 25 * 60000 };
      }
      save(); renderFocus();
    });

    document.addEventListener('keydown', function (e) {
      var focusOpen = !!ui.focusId;
      if (e.key === 'Escape' && focusOpen) { closeFocus(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      if (focusOpen) {
        if (e.key === ' ') { e.preventDefault(); focusToggle(); }
        return;
      }
      var p = activePeriod();
      if (e.key === 'n' && p) { e.preventDefault(); var i = $('#dump-input'); if (i) i.focus(); }
      else if (e.key === '/' && p) { e.preventDefault(); var s = $('#search'); if (s) s.focus(); }
      else if (e.key === 'f' && p) { e.preventDefault(); openFocus(); }
      else if (e.key === 't') cycleTheme();
      else if (e.key === '?') { var h = $('#help-dialog'); if (h) h.showModal(); }
    });

    // Re-render when coming back to the tab (the day may have changed) and when another tab edits data.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) render(); });
    window.addEventListener('storage', function (e) { if (e.key === KEY) { state = load(); render(); } });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', applyTheme);
    }
  }

  // Exposed for the test harness only.
  window.__tempo = { parseDump: parseDump, classify: classify, parseDuration: parseDuration };

  bind();
  setupMic();
  render();
  setInterval(tick, 1000);
  setInterval(function () { if (state.running && !ui.focusId) render(); }, 30000);
  tick();
})();
