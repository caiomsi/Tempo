/* Tempo parser tests. Run: node test/parse.test.js */
'use strict';
var assert = require('assert');
var P = require('../js/parse.js');

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
function one(text, ctx) {
  var out = P.parseDump(text, ctx).filter(function (t) { return !t.skip; });
  assert.strictEqual(out.length, 1, 'expected 1 task from "' + text + '", got ' + JSON.stringify(out.map(function (t) { return t.title; })));
  return out[0];
}
function titles(text, ctx) { return P.parseDump(text, ctx).filter(function (t) { return !t.skip && !t.dup; }).map(function (t) { return t.title; }); }
function weekday(name) {
  var idx = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(name);
  var t = P.today(), diff = (idx - t.getDay() + 7) % 7;
  return P.iso(P.addDays(t, diff));
}

// ---------- Getting the real task ----------
test('quiz for business class', function () {
  var t = one('I have to do a quiz for my business class, which would take about 15 minutes');
  assert.strictEqual(t.title, 'Business class quiz'); assert.strictEqual(t.estMin, 15); assert.strictEqual(t.category, 'School');
});
test('lab report for physics, gonna take', function () {
  var t = one('finish the lab report for physics which is gonna take like 2 hours');
  assert.strictEqual(t.title, 'Physics lab report'); assert.strictEqual(t.estMin, 120);
});
test('essay for english with due date', function () {
  var t = one('work on my essay for english 3 hours by thursday');
  assert.strictEqual(t.title, 'English essay'); assert.strictEqual(t.due, weekday('thursday'));
});
test('SAT practice test keeps acronym', function () { assert.strictEqual(one('take the practice test for the SAT 1.5h').title, 'SAT practice test'); });
test('go to the gym', function () { assert.strictEqual(one('go to the gym for an hour').title, 'Gym'); });
test('keeps meaningful verbs', function () {
  assert.deepStrictEqual(titles('I gotta make dinner, take out the trash, and call my mom real quick'), ['Make dinner', 'Take out trash', 'Call mom']);
});

// ---------- Context: statements become tasks ----------
test('I have a chem test on friday → study task', function () {
  var t = one('I have a chem test on friday');
  assert.strictEqual(t.title, 'Study for chem test'); assert.strictEqual(t.due, weekday('friday')); assert.strictEqual(t.estMin, 90);
});
test('test in a subject', function () { assert.strictEqual(one('i have a test in biology tomorrow').title, 'Study for biology test'); });
test('exam soon is high priority', function () { assert.strictEqual(one('I have a calc quiz tomorrow').priority, 'high'); });
test('X is due day', function () {
  var t = one('the history essay is due thursday');
  assert.strictEqual(t.title, 'History essay'); assert.strictEqual(t.due, weekday('thursday'));
});
test('due day: X', function () { assert.strictEqual(one('due friday: spanish worksheet').title, 'Spanish worksheet'); });
test('trailing clause joins previous task', function () {
  var out = titles("finish the presentation for marketing, that's due friday, and call grandma");
  assert.deepStrictEqual(out, ['Marketing presentation', 'Call grandma']);
});
test('tonight / after school removed', function () { assert.strictEqual(one('do laundry tonight after school').title, 'Do laundry'); });
test('urgent: prefix is priority, not a category', function () {
  var t = one('urgent: pay the electric bill');
  assert.strictEqual(t.priority, 'high'); assert.strictEqual(t.category, 'Money'); assert.strictEqual(t.title, 'Pay electric bill');
});

// ---------- Not tasks ----------
test('moods are skipped', function () {
  var all = P.parseDump("I'm so tired, this week is crazy, study for the calc quiz 2 hours");
  assert.deepStrictEqual(all.filter(function (t) { return !t.skip; }).map(function (t) { return t.title; }), ['Study for calc quiz']);
  assert.strictEqual(all.filter(function (t) { return t.skip; }).length, 2);
});
test('ugh is skipped', function () { assert.strictEqual(P.parseDump('ugh').filter(function (t) { return !t.skip; }).length, 0); });

// ---------- Quantities ----------
test('chapters 3 and 4 not split', function () {
  var t = one('read chapters 3 and 4 for history');
  assert.ok(/chapters 3 and 4/i.test(t.title), t.title); assert.strictEqual(t.estMin, 80);
});
test('pages range estimate', function () { assert.strictEqual(one('read pages 40-60 for english').estMin, 55); });
test('problems count estimate', function () { assert.strictEqual(one('do 10 math problems').estMin, 60); });
test('two essays doubles', function () { assert.strictEqual(one('write two essays').estMin, 300); });

// ---------- Estimates ----------
test('guessed estimate is flagged', function () {
  var t = one('buy groceries'); assert.strictEqual(t.estGuess, true); assert.strictEqual(t.estMin, 45);
  assert.strictEqual(one('buy groceries 20 min').estGuess, false);
});
test('history beats the table', function () {
  var ctx = { history: [{ title: 'Biology lab report', actualMin: 150 }, { title: 'Chem lab report', actualMin: 170 }] };
  var t = one('write the lab report', ctx);
  assert.strictEqual(t.estMin, 160); assert.strictEqual(t.estSource, 'history');
});
test('personal factor scales table estimates', function () { assert.strictEqual(one('essay', { factor: 1.2 }).estMin, 180); });
test('breaks: 10m per 50m', function () {
  assert.strictEqual(P.breaksFor(45), 0); assert.strictEqual(P.breaksFor(100), 10); assert.strictEqual(P.breaksFor(190), 30);
});

// ---------- Duplicates ----------
test('duplicate of an open task', function () {
  var all = P.parseDump('buy groceries, call mom', { openTitles: ['Buy groceries'] });
  assert.strictEqual(all[0].dup, true); assert.strictEqual(all[1].dup, false);
});
test('duplicate within the same input', function () {
  var all = P.parseDump('study for calc quiz, study for the calc quiz');
  assert.strictEqual(all.filter(function (t) { return t.dup; }).length, 1);
});

// ---------- Categories & learning ----------
test('headers set category', function () {
  var all = P.parseDump('Work:\n- fix bug on landing page 2h\n- reply to emails');
  assert.ok(all.every(function (t) { return t.category === 'Work' && !t.catAuto; }));
});
test('learning moves similar wording', function () {
  var learnMap = {};
  P.learn(learnMap, 'Robotics club build', 'Personal'); P.learn(learnMap, 'Robotics club build', 'Personal');
  assert.strictEqual(P.classify('robotics meeting prep', { learn: learnMap }), 'Personal');
});
test('psychology discussion post is School', function () { assert.strictEqual(one('complete the discussion post for psychology, 30 minutes').category, 'School'); });

// ---------- Durations in fields ----------
test('parseDuration forms', function () {
  assert.strictEqual(P.parseDuration('1h30'), 90); assert.strictEqual(P.parseDuration('1h30m'), 90);
  assert.strictEqual(P.parseDuration('90m'), 90); assert.strictEqual(P.parseDuration('1.5'), 90);
  assert.strictEqual(P.parseDuration('1:15'), 75); assert.strictEqual(P.parseDuration('~45m'), 45);
});

// ---------- Session end times ----------
function at(h, m, dayOffset) { var d = new Date(2026, 9, 12 + (dayOffset || 0), h, m || 0, 0, 0); return d.getTime(); }
var NOW = at(14, 10);   // 2:10 PM
test('6pm today', function () { assert.strictEqual(P.parseEndTime('6pm', NOW), at(18)); });
test('6:30 pm with until', function () { assert.strictEqual(P.parseEndTime('until 6:30 pm', NOW), at(18, 30)); });
test('bare 6 means the next 6 o\'clock (6pm)', function () { assert.strictEqual(P.parseEndTime('6', NOW), at(18)); });
test('bare 3 at 2:10pm means 3pm', function () { assert.strictEqual(P.parseEndTime('till 3', NOW), at(15)); });
test('24-hour input', function () { assert.strictEqual(P.parseEndTime('16:45', NOW, true), at(16, 45)); });
test('time already passed rolls to tomorrow', function () { assert.strictEqual(P.parseEndTime('1am', NOW), at(1, 0, 1)); });
test('24h earlier than now rolls to tomorrow', function () { assert.strictEqual(P.parseEndTime('09:00', NOW, true), at(9, 0, 1)); });
test('not a time', function () { assert.strictEqual(P.parseEndTime('2h', NOW), null); assert.strictEqual(P.parseEndTime('25:00', NOW), null); assert.strictEqual(P.parseEndTime('13pm', NOW), null); });

console.log(passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
