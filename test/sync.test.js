/* Tempo sync merge tests. Run: node test/sync.test.js */
'use strict';
var assert = require('assert');
var S = require('../js/sync.js');

var failures = 0, passed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + e.message); }
}
function task(id, extra) { return Object.assign({ id: id, periodId: 'w', title: id, estMin: 30, logs: [], updatedAt: 100 }, extra || {}); }

test('edits on two devices to different tasks are both kept', function () {
  var a = { tasks: [task('t1', { title: 'A edit', updatedAt: 200 }), task('t2')] };
  var b = { tasks: [task('t1'), task('t2', { title: 'B edit', updatedAt: 300 })] };
  var m = S.mergeDocs(a, b);
  assert.strictEqual(m.tasks.find(function (t) { return t.id === 't1'; }).title, 'A edit');
  assert.strictEqual(m.tasks.find(function (t) { return t.id === 't2'; }).title, 'B edit');
});
test('newer edit of the same task wins', function () {
  var m = S.mergeDocs({ tasks: [task('t1', { title: 'old', updatedAt: 1 })] }, { tasks: [task('t1', { title: 'new', updatedAt: 2 })] });
  assert.strictEqual(m.tasks[0].title, 'new');
});
test('new tasks from either side are added', function () {
  var m = S.mergeDocs({ tasks: [task('a')] }, { tasks: [task('b')] });
  assert.deepStrictEqual(m.tasks.map(function (t) { return t.id; }).sort(), ['a', 'b']);
});
test('deletion sticks', function () {
  var m = S.mergeDocs({ tasks: [], deleted: { t1: 500 } }, { tasks: [task('t1', { updatedAt: 100 })] });
  assert.strictEqual(m.tasks.length, 0); assert.strictEqual(m.deleted.t1, 500);
});
test('edit after deletion brings it back', function () {
  var m = S.mergeDocs({ tasks: [], deleted: { t1: 500 } }, { tasks: [task('t1', { updatedAt: 900 })] });
  assert.strictEqual(m.tasks.length, 1);
});
test('time logged on both devices is kept', function () {
  var a = { tasks: [task('t1', { logs: [{ start: 1, end: 2 }], updatedAt: 10 })] };
  var b = { tasks: [task('t1', { logs: [{ start: 1, end: 2 }, { start: 5, end: 9 }], updatedAt: 5 })] };
  assert.strictEqual(S.mergeDocs(a, b).tasks[0].logs.length, 2);
});
test('hand-edited time replaces older logs', function () {
  var a = { tasks: [task('t1', { logs: [{ start: 1000, end: 2000 }], logsResetAt: 1000, updatedAt: 10 })] };
  var b = { tasks: [task('t1', { logs: [{ start: 1, end: 500 }], updatedAt: 5 })] };
  var logs = S.mergeDocs(a, b).tasks[0].logs;
  assert.deepStrictEqual(logs, [{ start: 1000, end: 2000 }]);
});
test('newest timer start/stop wins', function () {
  var a = { tasks: [task('t1')], running: null, runningAt: 50 };
  var b = { tasks: [task('t1')], running: { taskId: 't1', start: 60 }, runningAt: 60 };
  assert.strictEqual(S.mergeDocs(a, b).running.taskId, 't1');
  assert.strictEqual(S.mergeDocs(b, { tasks: [task('t1')], running: null, runningAt: 70 }).running, null);
});
test('running timer on a deleted task is dropped', function () {
  var m = S.mergeDocs({ tasks: [], deleted: { t1: 99 }, running: { taskId: 't1', start: 1 }, runningAt: 9 }, { tasks: [task('t1', { updatedAt: 1 })] });
  assert.strictEqual(m.running, null);
});
test('learned categories combine', function () {
  var m = S.mergeDocs({ learn: { robot: { Personal: 2 } } }, { learn: { robot: { Personal: 1, Work: 1 } } });
  assert.deepStrictEqual(m.learn.robot, { Personal: 2, Work: 1 });
});
test('merge is idempotent', function () {
  var a = { tasks: [task('t1', { logs: [{ start: 1, end: 2 }] })], periods: [{ id: 'w', updatedAt: 1 }] };
  var once = S.mergeDocs(a, a);
  assert.deepStrictEqual(S.mergeDocs(once, once), once);
});

console.log(passed + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
