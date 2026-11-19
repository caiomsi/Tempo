/* Tempo timer tests. Run: node test/timers.test.js */
'use strict';
var assert = require('assert');
var T = require('../js/timers.js');

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
var MIN = 60000, HOUR = 3600000;
var NOW = new Date(2026, 5, 10, 14, 10, 0).getTime();   // 2:10pm local
function at(h, m, addDays) { var d = new Date(NOW); d.setHours(h, m || 0, 0, 0); if (addDays) d.setDate(d.getDate() + addDays); return d.getTime(); }

// ---------- parseInput ----------
test('bare number is minutes', function () { assert.strictEqual(T.parseInput('25', NOW), 25 * MIN); });
test('25m / 25 min / 25 minutes', function () {
  ['25m', '25 m', '25 min', '25 minutes'].forEach(function (s) { assert.strictEqual(T.parseInput(s, NOW), 25 * MIN, s); });
});
test('seconds', function () { assert.strictEqual(T.parseInput('90s', NOW), 90000); assert.strictEqual(T.parseInput('45 sec', NOW), 45000); });
test('hours', function () { assert.strictEqual(T.parseInput('1h', NOW), HOUR); assert.strictEqual(T.parseInput('2 hours', NOW), 2 * HOUR); });
test('1h30 and 1h 30m', function () {
  assert.strictEqual(T.parseInput('1h30', NOW), 90 * MIN);
  assert.strictEqual(T.parseInput('1h 30m', NOW), 90 * MIN);
  assert.strictEqual(T.parseInput('1h30m', NOW), 90 * MIN);
});
test('h:mm and h:mm:ss', function () {
  assert.strictEqual(T.parseInput('1:30', NOW), 90 * MIN);
  assert.strictEqual(T.parseInput('1:30:00', NOW), 90 * MIN);
  assert.strictEqual(T.parseInput('0:45:00', NOW), 45 * MIN);
});
test('spoken forms', function () {
  assert.strictEqual(T.parseInput('an hour', NOW), HOUR);
  assert.strictEqual(T.parseInput('half an hour', NOW), 30 * MIN);
});
test('until a clock time', function () {
  assert.strictEqual(T.parseInput('until 6pm', NOW), at(18) - NOW);
  assert.strictEqual(T.parseInput('6:30pm', NOW), at(18, 30) - NOW);
  assert.strictEqual(T.parseInput('till 18:00', NOW), at(18) - NOW);
});
test('clock time already passed rolls to tomorrow', function () { assert.strictEqual(T.parseInput('until 1pm', NOW), at(13, 0, 1) - NOW); });
test('rejects nonsense, zero and over 24h', function () {
  ['', 'abc', '0', '0m', '25h', '1500', 'until banana'].forEach(function (s) { assert.strictEqual(T.parseInput(s, NOW), null, s); });
  assert.strictEqual(T.parseInput(null, NOW), null);
});

// ---------- state ----------
test('newTimer defaults', function () {
  var t = T.newTimer({});
  assert.strictEqual(t.durationMs, 25 * MIN); assert.strictEqual(t.state, 'idle'); assert.strictEqual(t.face, 'dots');
  assert.strictEqual(T.remainingMs(t, NOW), 25 * MIN);
});
test('start, run, pause, resume', function () {
  var t = T.newTimer({ durationMs: 10 * MIN });
  T.start(t, NOW);
  assert.strictEqual(t.state, 'running'); assert.strictEqual(t.endsAt, NOW + 10 * MIN);
  assert.strictEqual(T.remainingMs(t, NOW + 3 * MIN), 7 * MIN);
  T.pause(t, NOW + 3 * MIN);
  assert.strictEqual(t.state, 'paused'); assert.strictEqual(t.leftMs, 7 * MIN);
  assert.strictEqual(T.remainingMs(t, NOW + 99 * MIN), 7 * MIN);
  T.start(t, NOW + 20 * MIN);
  assert.strictEqual(T.remainingMs(t, NOW + 22 * MIN), 5 * MIN);
});
test('keeps counting into overtime', function () {
  var t = T.newTimer({ durationMs: MIN });
  T.start(t, NOW);
  assert.strictEqual(T.remainingMs(t, NOW + 2 * MIN), -MIN);
  assert.strictEqual(t.state, 'running');
});
test('pausing in overtime keeps the negative time', function () {
  var t = T.newTimer({ durationMs: MIN });
  T.start(t, NOW); T.pause(t, NOW + 90000);
  assert.strictEqual(t.leftMs, -30000);
  T.start(t, NOW + 200000);
  assert.strictEqual(T.remainingMs(t, NOW + 210000), -40000);
});
test('reset', function () {
  var t = T.newTimer({ durationMs: 5 * MIN });
  T.start(t, NOW); t.chimed = true; T.reset(t);
  assert.strictEqual(t.state, 'idle'); assert.strictEqual(t.leftMs, 5 * MIN); assert.strictEqual(t.chimed, false);
});
test('setDuration resets to idle', function () {
  var t = T.newTimer({ durationMs: 5 * MIN });
  T.start(t, NOW); T.setDuration(t, 40 * MIN);
  assert.strictEqual(t.state, 'idle'); assert.strictEqual(t.durationMs, 40 * MIN); assert.strictEqual(T.remainingMs(t, NOW), 40 * MIN);
});

// ---------- fmt ----------
test('fmt countdown', function () {
  assert.strictEqual(T.fmt(24 * MIN + 59000), '0:24:59');
  assert.strictEqual(T.fmt(24 * MIN + 58500), '0:24:59');
  assert.strictEqual(T.fmt(HOUR + 5000), '1:00:05');
  assert.strictEqual(T.fmt(0), '0:00:00');
});
test('fmt overtime', function () { assert.strictEqual(T.fmt(-(72 * 1000)), '+0:01:12'); assert.strictEqual(T.fmt(-HOUR - 1000), '+1:00:01'); });
test('durLabel', function () {
  assert.strictEqual(T.durLabel(25 * MIN), '25m'); assert.strictEqual(T.durLabel(90 * MIN), '1h 30m');
  assert.strictEqual(T.durLabel(HOUR), '1h'); assert.strictEqual(T.durLabel(45000), '45s');
});

// ---------- storage ----------
function stub() { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, raw: m }; }
test('save and load round trip', function () {
  var s = stub(), a = T.newTimer({ name: 'Pasta', face: 'ring', durationMs: 10 * MIN }), b = T.newTimer({ face: 'flip' });
  T.start(a, NOW); T.start(b, NOW); T.pause(b, NOW + MIN); b.chimed = true;
  assert.ok(T.save(s, [a, b]));
  var back = T.load(s);
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].name, 'Pasta'); assert.strictEqual(back[0].state, 'running'); assert.strictEqual(back[0].endsAt, a.endsAt);
  assert.strictEqual(back[1].state, 'paused'); assert.strictEqual(back[1].leftMs, 24 * MIN); assert.strictEqual(back[1].chimed, true);
  assert.strictEqual(T.remainingMs(back[0], NOW + 4 * MIN), 6 * MIN);
});
test('load survives junk and missing storage', function () {
  var s = stub(); s.setItem(T.KEY, '{nope');
  assert.deepStrictEqual(T.load(s), []);
  s.setItem(T.KEY, JSON.stringify({ v: 2, timers: [] })); assert.deepStrictEqual(T.load(s), []);
  assert.deepStrictEqual(T.load(null), []);
  s.setItem(T.KEY, JSON.stringify({ v: 1, timers: [null, { durationMs: -5, state: 'running' }] }));
  var t = T.load(s); assert.strictEqual(t.length, 1); assert.strictEqual(t[0].durationMs, 25 * MIN); assert.strictEqual(t[0].state, 'idle');
});
test('load caps at four timers', function () {
  var s = stub(), list = []; for (var i = 0; i < 6; i++) list.push(T.newTimer({}));
  T.save(s, list); assert.strictEqual(T.load(s).length, 4);
});
test('save fails quietly', function () { assert.strictEqual(T.save({ setItem: function () { throw new Error('full'); } }, []), false); });

console.log(passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
