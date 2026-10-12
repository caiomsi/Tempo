/* Tempo parser: plain language in, tasks out. No network, no DOM.
   Loaded as a plain <script> (window.TempoParse) and by Node tests (module.exports). */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var CATS = ['School', 'Work', 'Home', 'Errands', 'Health', 'Money', 'Personal', 'Other'];
  var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  // ---------- Small helpers ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseISO(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function round5(n) { return Math.max(5, Math.round(n / 5) * 5); }
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
  function wordCount(s) { return String(s).trim().split(/\s+/).filter(Boolean).length; }

  // Form fields: "2h", "1h30m", "90m", "1.5", "1:30" → minutes. Bare numbers are hours.
  function parseDuration(str) {
    if (str == null) return null;
    var s = String(str).trim().toLowerCase().replace(/^~/, '').replace(/\s+/g, '');
    if (!s) return null;
    var m;
    if ((m = s.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
    if ((m = s.match(/^(\d+)h(\d{1,2})$/))) return +m[1] * 60 + +m[2];
    if ((m = s.match(/^(\d+(?:[.,]\d+)?)$/))) return Math.round(parseFloat(m[1].replace(',', '.')) * 60);
    if ((m = s.match(/^(?:(\d+(?:[.,]\d+)?)h(?:rs?|ours?)?)?(?:(\d+)m(?:in(?:s|utes?)?)?)?$/)) && (m[1] || m[2])) {
      return Math.round((m[1] ? parseFloat(m[1].replace(',', '.')) * 60 : 0) + (m[2] ? +m[2] : 0));
    }
    return null;
  }

  // ---------- Durations in speech ----------
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
    [new RegExp(LEAD + '(?:\\b|~)' + NUMW + '\\s*' + MINS + '\\b', 'i'), function (m) { return /few/i.test(m[1]) ? 10 : num(m[1]); }]
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
  function hasDuration(s) { return takeDuration(' ' + s + ' ').min != null; }

  // ---------- Priority ----------
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

  // ---------- Due dates and scheduling words ----------
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
    new RegExp('\\b(?:(?:is|are|it\'?s)\\s+)?(?:due|by|on|before|until|for)\\s+(mon|tues?|wed|thu(?:rs?)?|fri|sat|sun|\\d{1,2}\\/\\d{1,2}|\\d{4}-\\d{1,2}-\\d{1,2})\\b', 'i'),
    new RegExp('\\b(?:(?:is|are|it\'?s)\\s+)?(?:(?:due|by|on|before|until|for)\\s+)?(?:(?:this|next)\\s+(?=monday|tuesday|wednesday|thursday|friday|saturday|sunday))?' + DAYWORD + '\\b', 'i')
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
  // Words about *when* that aren't part of the task.
  var WHEN_WORDS = /\b(?:this\s+(?:morning|afternoon|evening)|in\s+the\s+(?:morning|afternoon|evening)|after\s+(?:school|class|work|dinner|lunch|practice)|before\s+(?:school|class|work|dinner|lunch|bed)|later(?:\s+today)?|first\s+thing|right\s+now|asap\s+today|at\s+some\s+point|sometime|soon)\b/gi;

  // ---------- Category hints ----------
  var CAT_ALIAS = { school: 'School', class: 'School', uni: 'School', college: 'School', university: 'School',
    work: 'Work', job: 'Work', 'the office': 'Work', 'my job': 'Work', home: 'Home', 'the house': 'Home', house: 'Home' };
  function takeCategory(s) {
    var m = s.match(/#([\w\-À-ž]+)/);
    if (m) return { cat: catName(m[1]), rest: s.replace(m[0], ' ') };
    m = s.match(/\bfor\s+(school|class|uni|college|university|work|my\s+job|the\s+office|the\s+house)\b/i);
    if (m) return { cat: CAT_ALIAS[m[1].toLowerCase().replace(/\s+/g, ' ')], rest: s.replace(m[0], ' ') };
    return { cat: '', rest: s };
  }

  // ---------- Quantities ("pages 40-60", "10 problems", "chapters 3 and 4") ----------
  var QTY_WORD = '(\\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)';
  function findQty(s) {
    var m;
    if ((m = s.match(/\bpages?\s+(\d+)\s*(?:-|–|to|through)\s*(\d+)\b/i))) return { unit: 'page', n: Math.max(1, +m[2] - +m[1] + 1) };
    if ((m = s.match(new RegExp('\\b' + QTY_WORD + '\\s+pages?\\b', 'i')))) return { unit: 'page', n: num(m[1]) };
    if ((m = s.match(/\bchapters?\s+(\d+)\s*(?:-|–|to|through)\s*(\d+)\b/i))) return { unit: 'chapter', n: Math.max(1, +m[2] - +m[1] + 1) };
    if ((m = s.match(/\bchapters?\s+\d+(?:\s*(?:,|and|&)\s*\d+)+/i))) return { unit: 'chapter', n: (m[0].match(/\d+/g) || []).length };
    if ((m = s.match(new RegExp('\\b' + QTY_WORD + '\\s+chapters?\\b', 'i')))) return { unit: 'chapter', n: num(m[1]) };
    if ((m = s.match(new RegExp('\\b' + QTY_WORD + '\\s+(?:math\\s+|practice\\s+|homework\\s+)?(?:problems?|questions?|exercises?)\\b', 'i')))) return { unit: 'problem', n: num(m[1]) };
    if ((m = s.match(new RegExp('\\b' + QTY_WORD + '\\s+(essays?|papers?|quizzes|quiz|worksheets?|assignments?|emails?|calls?|labs?|readings?|problem\\s+sets?|psets?|discussion\\s+posts?|posts?)\\b', 'i')))) return { unit: 'item', n: num(m[1]) };
    return null;
  }

  // ---------- Turning speech into a clean task name ----------
  var LEAD_IN = /^(?:(?:and|also|then|plus|oh|so|ok|okay|um|uh|first|next|lastly|finally|still)[,:]?\s+)*(?:i\s+|we\s+)?(?:also\s+|really\s+|still\s+|definitely\s+|probably\s+)?(?:(?:need|needs|have|has|got|want|going)\s+to\s+|gotta\s+|gonna\s+|must\s+|should\s+|wanna\s+|'ll\s+|will\s+|remember\s+to\s+|don'?t\s+forget\s+to\s+|i'?ve\s+got\s+to\s+|i'?ll\s+|let\s+me\s+|try\s+to\s+)+/i;
  var TRAIL = /\s+(?:and|which|that|that's|it|it's|is|are|will|would|should|takes?|for|about|around|by|on|due|to|the|also|then|plus|maybe|like|with|probably|still|yet)$/i;
  var TASK_NOUN = '(?:quiz(?:zes)?|tests?|exams?|midterms?|finals?|essays?|papers?|homework|hw|assignments?|projects?|reports?|presentations?|labs?|worksheets?|readings?|problem\\s+sets?|psets?|discussion\\s+posts?|posts?|reflections?|study\\s+guides?|notes|slides|decks?|proposals?|applications?|reviews?|summar(?:y|ies)|outlines?|drafts?|lectures?|chapters?|questions|problems|exercises?|modules?|case\\s+stud(?:y|ies)|research|flashcards|portfolio|resume|cover\\s+letter|forms?|invoices?|thesis|lesson|vocab(?:ulary)?)';
  var TASK_NOUN_RE = new RegExp('\\b' + TASK_NOUN + '\\b', 'i');
  var WEAK_VERB = /^(?:do(?:ing)?|finish(?:ing)?|complete|completing|work(?:ing)?\s+on|get\s+done|take|taking|start(?:\s+on)?|knock\s+out|get\s+started\s+on|deal\s+with)\s+/i;
  var DETERMINERS = /\b(?:a|an|the|my|our|his|her|their|some|this|these|those)\s+(?=\S)/gi;
  var FILLER = /\b(?:real\s+quick|quickly|or\s+so|i\s+think|i\s+guess|probably|basically|actually|just|kind\s+of|sort\s+of|as\s+well|too|somehow|like\s+really)\b/gi;
  var ACTION_VERBS = 'study review read write finish do complete submit turn email call text buy pay clean cook wash fix build make prepare prep practice plan organize schedule book return pick drop apply update send reply respond edit design research outline draft revise memorize watch listen record meet visit go run walk workout work meditate file sign renew cancel order pack move learn solve grade print upload install set check look ask take start get feed water mow vacuum iron fold sweep mop shop grab bring print finish translate code debug deploy test ship publish post sketch paint draw film shoot rehearse train lift stretch swim bike hike sell list';
  var ACTION_SET = {};
  ACTION_VERBS.split(' ').forEach(function (v) { ACTION_SET[v] = true; });
  // Things people say that aren't tasks: moods, comments, filler.
  var NOT_TASK = /^(?:i'?m|im|i\s+am|i\s+feel|feeling|this\s+week|today\s+is|it'?s\s+(?:been|gonna\s+be|going\s+to\s+be)|ugh+|wow|lol|omg|man|honestly|yeah|ok(?:ay)?|cool|hmm+|so\s+much|too\s+much|i\s+hate|i\s+love|kinda|sigh)\b/i;

  var SUBJECT_CASE = {
    english: 'English', spanish: 'Spanish', french: 'French', german: 'German', latin: 'Latin', italian: 'Italian',
    portuguese: 'Portuguese', chinese: 'Chinese', japanese: 'Japanese', korean: 'Korean', arabic: 'Arabic', american: 'American',
    european: 'European', ap: 'AP', sat: 'SAT', act: 'ACT', ib: 'IB', apush: 'APUSH', gpa: 'GPA', cs: 'CS', mla: 'MLA', apa: 'APA',
    pe: 'PE', ela: 'ELA', ui: 'UI', ux: 'UX', seo: 'SEO', pdf: 'PDF', ai: 'AI', dmv: 'DMV', i: 'I'
  };
  function fixCase(s) {
    return s.replace(/[A-Za-zÀ-ž']+/g, function (w) {
      var k = w.toLowerCase();
      return SUBJECT_CASE[k] || w;
    });
  }

  function tidy(s) {
    var prev;
    do {
      prev = s;
      s = s.replace(LEAD_IN, '').replace(/^(?:to|due)\s+/i, '').replace(/^[\s,.;:!?\-–—]+|[\s,.;:!?\-–—(]+$/g, '').replace(TRAIL, '').trim();
    } while (s !== prev);
    return s.replace(/\(\s*\)/g, '').replace(/\s{2,}/g, ' ');
  }

  // Statements that imply a task: "I have a chem test" → "Study for chem test".
  var EXAM = '(quiz|test|exam|midterm|final)';
  function inferTask(s) {
    var m = s.match(new RegExp('^(?:i\\s+|we\\s+)?(?:have|got|\'ve\\s+got|ve\\s+got|got\\s+a)\\s+(?:a|an|my|the|another|two|\\d+)?\\s*([\\w\' ]{0,30}?)\\s*\\b' + EXAM + 's?\\b\\s*(?:in|for|on)?\\s*([\\w\' ]{0,30})$', 'i'));
    if (m) {
      var subj = (m[1] + ' ' + (m[3] || '')).replace(DETERMINERS, '').replace(/\s+/g, ' ').trim();
      return { title: 'Study for ' + (subj ? subj + ' ' : '') + m[2].toLowerCase(), kind: 'study-' + m[2].toLowerCase() };
    }
    // "the essay is due" / "essay due" → "essay"
    m = s.match(/^(.*?)\s+(?:is|are)\s*$/i);
    if (m && TASK_NOUN_RE.test(m[1])) return { title: m[1], kind: '' };
    return null;
  }

  // Boil a spoken phrase down to the thing to do.
  function condense(s) {
    s = s.replace(FILLER, ' ').replace(WHEN_WORDS, ' ').replace(/\s{2,}/g, ' ').trim();
    s = s.replace(/^go\s+(?:to\s+|for\s+)?(?=\S)/i, '');
    var noVerb = s.replace(WEAK_VERB, '');
    if (noVerb !== s && new RegExp('^(?:(?:a|an|the|my|our|this|that|some)\\s+)?(?:[\\w\'-]+\\s+){0,2}' + TASK_NOUN + '\\b', 'i').test(noVerb)) s = noVerb;
    s = s.replace(DETERMINERS, '').replace(/\s{2,}/g, ' ').trim();
    var m = s.match(new RegExp('^((?:[\\w\'-]+\\s+){0,2}' + TASK_NOUN + ')\\s+(?:for|in|on|of|from|about)\\s+(.{2,40})$', 'i'));
    if (m && m[2].split(/\s+/).length <= 4 && !/\b(?:and|with|to)\b/i.test(m[2]) && !/^\d/.test(m[2])) s = m[2] + ' ' + m[1];
    return s;
  }

  function cleanTitle(s) {
    s = tidy(s.replace(/\s+/g, ' ').trim());
    var inferred = inferTask(s);
    var kind = '';
    if (inferred) { s = inferred.title; kind = inferred.kind; }
    s = tidy(inferred && kind ? s.replace(DETERMINERS, '') : condense(s));
    return { title: capFirst(fixCase(s)), kind: kind };
  }

  // ---------- Categorizer ----------
  var CAT_WORDS = {
    School: 'study studying homework hw essay essays exam exams quiz quizzes test tests midterm midterms final finals class classes lecture lectures chapter chapters assignment assignments lab labs physics calc calculus math maths algebra geometry trig trigonometry statistics stats chemistry chem biology bio history english spanish french latin german literature ap sat act ib apush pset psets problem_set reading_assignment professor teacher syllabus flashcards revise revision thesis paper school course coursework textbook worksheet seminar tutor tutoring notes studyguide study_guide college university application applications scholarship psychology psych business marketing economics econ sociology philosophy government gov accounting anatomy physiology engineering cs programming art music discussion_post vocab vocabulary lesson homeroom semester grade grades gpa',
    Work: 'client clients meeting meetings email emails inbox report reports deck slides presentation pitch proposal invoice invoices deploy website websites site landing code coding bug bugs pr standup sprint ticket tickets launch portfolio boss manager coworker team project projects deadline spreadsheet figma design mockup mockups brief contract onboarding interview resume linkedin agency demo shift wireframe copy seo analytics pull_request code_review follow_up',
    Home: 'clean cleaning laundry dishes cook cooking dinner lunch breakfast vacuum tidy organize declutter repair trash garbage recycling garden plants bed room bedroom kitchen bathroom fridge closet mop dust iron ironing fold water_the_plants take_out meal_prep mow lawn',
    Errands: 'buy groceries grocery shop shopping pharmacy package return store target costco walmart mall hardware haircut pick_up drop_off post_office dry_cleaning car_wash oil_change gas_station dmv',
    Health: 'gym workout run running jog jogging exercise doctor dentist therapy therapist meditate meditation yoga sleep walk stretch stretching physio checkup appointment meds medicine vitamins swim swimming bike lift lifting cardio steps work_out hike',
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
  var STOP = { the: 1, and: 1, for: 1, with: 1, from: 1, into: 1, about: 1, this: 1, that: 1, some: 1, more: 1, all: 1, out: 1, off: 1, get: 1, make: 1, do: 1, finish: 1, start: 1, my: 1, our: 1, your: 1, new: 1, before: 1, after: 1 };

  function wordsOf(s, minLen) {
    return String(s).toLowerCase().replace(/[^a-z0-9À-ž\s'-]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= (minLen || 3) && !STOP[w]; });
  }
  function stem(w) { return w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, ''); }

  function catScores(title, ctx) {
    ctx = ctx || {};
    var learnMap = ctx.learn || {}, custom = ctx.customCats || [];
    var text = ' ' + String(title).toLowerCase() + ' ';
    var score = {};
    var add = function (cat, n) { score[cat] = (score[cat] || 0) + n; };
    CAT_PHRASES.forEach(function (pc) { if (text.indexOf(' ' + pc[0] + ' ') >= 0) add(pc[1], 2.5); });
    wordsOf(title, 2).forEach(function (w) {
      var hit = CAT_INDEX[w] || CAT_INDEX[stem(w)];
      if (hit) add(hit, 1);
      var learned = learnMap[w] || learnMap[stem(w)];
      if (learned) Object.keys(learned).forEach(function (cat) { add(cat, learned[cat] * 1.6); });
    });
    custom.forEach(function (cat) {
      if (CATS.indexOf(cat) < 0 && text.indexOf(' ' + cat.toLowerCase() + ' ') >= 0) add(cat, 5);
    });
    return score;
  }
  function classify(title, ctx) {
    var score = catScores(title, ctx), best = 'Other', bestScore = 0;
    Object.keys(score).forEach(function (cat) { if (score[cat] > bestScore) { best = cat; bestScore = score[cat]; } });
    return best;
  }
  // Remember which category a task went into, so similar wording lands there next time.
  function learn(learnMap, title, cat) {
    wordsOf(title).forEach(function (w) {
      var k = stem(w) || w;
      var row = learnMap[k] || (learnMap[k] = {});
      Object.keys(row).forEach(function (c) { if (c !== cat) row[c] = Math.max(0, row[c] - 0.5); });
      row[cat] = Math.min((row[cat] || 0) + 1, 6);
    });
    return learnMap;
  }

  // ---------- Similarity (duplicates, history) ----------
  function tokens(s) {
    var out = {};
    wordsOf(s, 2).forEach(function (w) { var k = stem(w); if (k && !/^(study|class)$/.test(k)) out[k] = true; });
    return Object.keys(out);
  }
  function similarity(a, b) {
    var ta = tokens(a), tb = tokens(b);
    if (!ta.length || !tb.length) return 0;
    var inter = ta.filter(function (t) { return tb.indexOf(t) >= 0; }).length;
    return inter / (ta.length + tb.length - inter);
  }

  // ---------- Time estimates ----------
  // First match wins. [pattern, minutes, unit-minutes for quantities]
  var EST_TABLE = [
    [/\bstudy\b.*\b(?:midterm|final)s?\b/i, 120],
    [/\bstudy\b.*\b(?:test|exam)s?\b/i, 90],
    [/\bstudy\b.*\bquiz/i, 30],
    [/\bthesis\b/i, 240],
    [/\btaxes\b/i, 180],
    [/\bpapers?\b/i, 180],
    [/\bessays?\b/i, 150],
    [/\blab\s+reports?\b/i, 120],
    [/\bpresentations?\b/i, 120],
    [/\b(?:midterm|final\s+exam)s?\b/i, 90],
    [/\bexams?\b/i, 90],
    [/\bproblem\s+sets?|\bpsets?\b/i, 90],
    [/\bdrafts?\b/i, 120],
    [/\b(?:slides|decks?)\b/i, 90],
    [/\bmeal\s+prep\b/i, 90],
    [/\blabs?\b/i, 90],
    [/\breports?\b/i, 90],
    [/\bprojects?\b/i, 120],
    [/\b(?:tests?)\b/i, 60],
    [/\b(?:homework|hw|assignments?|worksheets?)\b/i, 60],
    [/\b(?:study\s+guides?|review)\b/i, 60],
    [/\b(?:applications?|apply|resume|cover\s+letter)\b/i, 60],
    [/\b(?:gym|workout|work\s+out|lift(?:ing)?)\b/i, 60],
    [/\bmeetings?\b/i, 60],
    [/\bstudy\b/i, 60],
    [/\b(?:notes|outline|lecture)\b/i, 45],
    [/\b(?:read|reading|readings)\b/i, 45],
    [/\b(?:groceries|grocery|shopping)\b/i, 45],
    [/\b(?:clean|tidy|vacuum|mop|declutter)\b/i, 45],
    [/\b(?:cook|dinner|lunch|breakfast)\b/i, 45],
    [/\b(?:budget|budgeting)\b/i, 45],
    [/\b(?:run|jog|hike|bike|swim)\b/i, 40],
    [/\b(?:flashcards|memorize|vocab)/i, 30],
    [/\b(?:discussion\s+posts?|reflections?|posts?)\b/i, 30],
    [/\blaundry\b/i, 30],
    [/\b(?:walk|yoga|stretch)\b/i, 30],
    [/\b(?:pick\s+up|drop\s+off|return|post\s+office|pharmacy|bank|haircut)\b/i, 30],
    [/\bquiz/i, 20],
    [/\b(?:emails?|inbox|reply|respond)\b/i, 20],
    [/\b(?:call|text|facetime)\b/i, 20],
    [/\bdishes\b/i, 20],
    [/\b(?:meditate|meditation)\b/i, 15],
    [/\b(?:pay|bills?|venmo)\b/i, 15],
    [/\b(?:trash|garbage|recycling)\b/i, 10]
  ];
  var UNIT_MIN = { page: 2.5, chapter: 40, problem: 6 };

  function median(list) {
    var s = list.slice().sort(function (a, b) { return a - b; }), mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // How long will this take? Your own history first, then a table by type, scaled by amount.
  function estimateFor(title, opts, ctx) {
    opts = opts || {}; ctx = ctx || {};
    var history = ctx.history || [];
    var matches = history.filter(function (h) { return h.actualMin >= 1 && similarity(title, h.title) >= 0.5; });
    var base = null, source = 'type';
    for (var i = 0; i < EST_TABLE.length; i++) if (EST_TABLE[i][0].test(title)) { base = EST_TABLE[i][1]; break; }
    if (base == null) base = 30;
    var q = opts.qty;
    if (q && q.n > 0) {
      if (UNIT_MIN[q.unit]) base = q.unit === 'chapter' && /\bstudy|review\b/i.test(title) ? q.n * 30 : q.n * UNIT_MIN[q.unit];
      else if (q.unit === 'item') base = base * q.n;
    }
    if (ctx.factor && ctx.factor > 0.5 && ctx.factor < 3) base = base * ctx.factor;
    if (matches.length >= 2) { base = median(matches.map(function (h) { return h.actualMin; })); source = 'history'; }
    else if (matches.length === 1) { base = (base + matches[0].actualMin) / 2; source = 'history'; }
    return { min: round5(base), source: source };
  }

  // ---------- One phrase → one task ----------
  function parseOne(text, forcedCat, ctx) {
    ctx = ctx || {};
    var s = ' ' + text + ' ';
    var original = String(text).trim();
    var c = takeCategory(s); s = c.rest;
    var d = takeDuration(s); s = d.rest;
    var p = takePriority(s); s = p.rest;
    if (/\btonight\b/i.test(s) && !/\b(?:due|by)\b/i.test(s)) { /* "tonight" means today */ }
    var u = takeDue(s); s = u.rest;
    var qty = findQty(s);
    var ct = cleanTitle(s);
    var title = ct.title;
    var cat = c.cat || forcedCat || '';
    var priority = p.pri || 'med';
    // An exam you have to study for, due within two days, is urgent.
    if (!p.pri && ct.kind && u.due) {
      var days = Math.round((parseISO(u.due) - today()) / DAY);
      if (days <= 2) priority = 'high';
    }
    var task = {
      title: title, estMin: d.min, estGuess: false, priority: priority, due: u.due,
      category: cat || classify(title, ctx), catAuto: !cat, skip: false, dup: false, reason: '', qty: qty, kind: ct.kind
    };
    if (d.min == null) {
      var e = estimateFor(title, { qty: qty }, ctx);
      task.estMin = e.min; task.estGuess = true; task.estSource = e.source;
    }
    // Is this actually a task?
    var low = title.toLowerCase(), first = low.split(/\s+/)[0] || '';
    var looksLikeTask = d.min != null || TASK_NOUN_RE.test(title) || ACTION_SET[first] || ACTION_SET[stem(first)] ||
      Object.keys(catScores(title, ctx)).length > 0 || !!c.cat || !!ct.kind;
    if (!title || !/[a-z0-9À-ž]/i.test(title)) { task.skip = true; task.reason = 'empty'; }
    else if (NOT_TASK.test(original) && !ct.kind && d.min == null && !TASK_NOUN_RE.test(title)) { task.skip = true; task.reason = 'Not a task'; }
    else if (!looksLikeTask && wordCount(title) <= 4) { task.skip = true; task.reason = 'Not sure this is a task'; }
    return task;
  }

  // ---------- A whole brain dump → list of tasks ----------
  var HEADER_SKIP = /^(?:due|urgent|important|asap|note|notes|reminder|todo|to\s*do|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|also|ps)$/i;
  function parseDump(text, ctx) {
    ctx = ctx || {};
    var out = [], header = '';
    String(text).split(/\n+/).forEach(function (rawLine) {
      var line = rawLine.replace(/^\s*(?:[-*•·]|\d+[.)]|\[\s?\])\s+/, '').trim();
      if (!line) { header = ''; return; }
      var hm = line.match(/^([A-Za-zÀ-ž][\wÀ-ž &\-]{0,24}):\s*(.*)$/);
      var lineCat = header;
      if (hm && !/^\d/.test(hm[2]) && !HEADER_SKIP.test(hm[1].trim()) && !/^due\b/i.test(hm[1])) {
        if (!hm[2]) { header = catName(CAT_ALIAS[hm[1].toLowerCase()] || hm[1]); return; }
        lineCat = catName(CAT_ALIAS[hm[1].toLowerCase()] || hm[1]);
        line = hm[2];
      } else if (hm && HEADER_SKIP.test(hm[1].trim())) {
        line = hm[1] + ' ' + hm[2];   // "urgent: pay rent" → "urgent pay rent"
      } else if (hm && /^due\b/i.test(hm[1])) {
        line = hm[2] + ' ' + hm[1];   // "due thursday: essay" → "essay due thursday"
      }
      var parts = [];
      line.split(/;|\.\s+(?=[A-Za-z])|\.$/).forEach(function (sentence) {
        sentence = sentence.replace(/\band\s+a\s+half\b/gi, 'and_a_half');
        var bits = sentence.split(/,\s*(?:(?:and|then|also|plus)\s+)?|\s+(?:and\s+then|then\s+also|and\s+(?:i\s+)?also|(?:i\s+)?also|plus|after\s+that|then)\s+/i);
        var merged = [];
        bits.forEach(function (b) {
          b = b.trim();
          if (!b) return;
          // "…, which takes 20 min", "…, that's due friday" and "…, milk" belong to the previous task.
          var trailing = /^(?:which|that|that's|it'?ll|it\s+will|it'?s|should|probably|maybe|due|by)\b/i.test(b);
          var restWords = wordCount(takeDuration(' ' + b + ' ').rest);
          var numberOnly = /^\d+\b/.test(b) && restWords <= 2;   // "chapters 3, 4"
          if (merged.length && (trailing || numberOnly || restWords === 0 || (restWords === 1 && !hasDuration(b)))) merged[merged.length - 1] += ', ' + b;
          else merged.push(b);
        });
        merged.forEach(function (chunk) {
          var andParts = chunk.split(/\s+and\s+/i);
          var acc = andParts[0];
          for (var i = 1; i < andParts.length; i++) {
            var right = andParts[i];
            // "chapters 3 and 4": a number on the right keeps it together.
            var keep = /^\d/.test(right) || /^(?:a\s+half)\b/i.test(right);
            if (!keep && (hasDuration(acc) || (wordCount(acc) >= 2 && wordCount(right) >= 2))) { parts.push(acc); acc = right; }
            else acc += ' and ' + right;
          }
          parts.push(acc);
        });
        parts = parts.map(function (x) { return x.replace(/and_a_half/g, 'and a half'); });
      });
      parts.forEach(function (p) {
        var t = parseOne(p, lineCat, ctx);
        if (t.reason !== 'empty') out.push(t);
      });
    });
    // Duplicates: against open tasks, and within this same input.
    var seen = (ctx.openTitles || []).slice();
    out.forEach(function (t) {
      if (t.skip) return;
      for (var i = 0; i < seen.length; i++) {
        var a = seen[i].toLowerCase().trim(), b = t.title.toLowerCase().trim();
        if (a === b || similarity(seen[i], t.title) >= 0.8) { t.dup = true; t.reason = 'Already on your list'; break; }
      }
      if (!t.dup) seen.push(t.title);
    });
    return out;
  }

  // Breaks for a stretch of work: 10 minutes after every 50.
  function breaksFor(workMin) { return Math.floor(Math.max(0, workMin - 1) / 50) * 10; }

  var api = {
    CATS: CATS, parseDuration: parseDuration, parseDump: parseDump, parseOne: parseOne, classify: classify,
    learn: learn, estimateFor: estimateFor, similarity: similarity, breaksFor: breaksFor, catName: catName,
    fmt: fmt, iso: iso, parseISO: parseISO, today: today, addDays: addDays, capFirst: capFirst, pad: pad,
    wordsOf: wordsOf, stem: stem
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TempoParse = api;
})(typeof window !== 'undefined' ? window : this);
