/* Tempo sync: accounts + saving to Supabase, merging edits from several devices.
   The merge is plain data in, data out, so Node tests can load it (module.exports). */
(function (root) {
  'use strict';

  var SUPABASE_URL = 'https://yjvkfzbjiivsktyfronh.supabase.co';
  // Publishable key: safe in the page; row-level security limits each account to its own row.
  var SUPABASE_KEY = 'sb_publishable_SsbashzZpRwVfgMCU5T1jQ_OXtvS3WW';
  var SAVE_DELAY = 1500;

  // ---------- Merge ----------
  function stamp(o) { return (o && o.updatedAt) || 0; }
  function logKey(l) { return l.start + ':' + l.end; }

  function mergeLogs(a, b) {
    // A hand-edited "time logged" resets a task's logs; respect the newest reset.
    var resetA = a.logsResetAt || 0, resetB = b.logsResetAt || 0;
    var reset = Math.max(resetA, resetB);
    var seen = {}, out = [];
    [a, b].forEach(function (t) {
      var fromReset = (t.logsResetAt || 0) === reset;
      (t.logs || []).forEach(function (l) {
        if (!fromReset && l.start < reset) return;   // older logs the reset replaced
        var k = logKey(l);
        if (!seen[k]) { seen[k] = true; out.push(l); }
      });
    });
    out.sort(function (x, y) { return x.start - y.start; });
    return { logs: out, logsResetAt: reset || undefined };
  }

  function mergeList(la, lb, deleted, isTask) {
    var map = {}, order = [];
    (la || []).forEach(function (o) { map[o.id] = { a: o }; order.push(o.id); });
    (lb || []).forEach(function (o) {
      if (map[o.id]) map[o.id].b = o; else { map[o.id] = { b: o }; order.push(o.id); }
    });
    var out = [];
    order.forEach(function (id) {
      var e = map[id], pick;
      if (!e.a) pick = e.b; else if (!e.b) pick = e.a; else pick = stamp(e.b) > stamp(e.a) ? e.b : e.a;
      pick = JSON.parse(JSON.stringify(pick));
      if (isTask && e.a && e.b) {
        var ml = mergeLogs(e.a, e.b);
        pick.logs = ml.logs;
        if (ml.logsResetAt) pick.logsResetAt = ml.logsResetAt;
      }
      if (deleted[id] && deleted[id] >= stamp(pick)) return;
      out.push(pick);
    });
    return out;
  }

  // Merge two Tempo documents. The newer edit of each item wins; deletions stick unless
  // the item was edited after it was deleted; time logs from both devices are kept.
  function mergeDocs(local, remote) {
    local = local || {}; remote = remote || {};
    var deleted = {};
    [local.deleted, remote.deleted].forEach(function (d) {
      Object.keys(d || {}).forEach(function (id) { deleted[id] = Math.max(deleted[id] || 0, d[id]); });
    });
    var tasks = mergeList(local.tasks, remote.tasks, deleted, true);
    var periods = mergeList(local.periods, remote.periods, deleted, false);
    var ra = local.runningAt || 0, rb = remote.runningAt || 0;
    var running = rb > ra ? remote.running : local.running;
    if (running && !tasks.some(function (t) { return t.id === running.taskId; })) running = null;
    var learn = {};
    [local.learn, remote.learn].forEach(function (L) {
      Object.keys(L || {}).forEach(function (w) {
        var row = learn[w] || (learn[w] = {});
        Object.keys(L[w]).forEach(function (c) { row[c] = Math.max(row[c] || 0, L[w][c]); });
      });
    });
    return { periods: periods, tasks: tasks, running: running || null, runningAt: Math.max(ra, rb), learn: learn, deleted: deleted };
  }

  // ---------- Client ----------
  var client = null, user = null, base = 0, timer = null, channel = null, busy = false;
  var hooks = { getDoc: null, applyDoc: null, onStatus: null, onRecovery: null };
  var status = 'off';

  function setStatus(s) { status = s; if (hooks.onStatus) hooks.onStatus(s, user); }

  function init(opts) {
    hooks = Object.assign(hooks, opts || {});
    if (!root.supabase || !root.supabase.createClient) { setStatus('unavailable'); return false; }
    client = root.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'tempo-auth' }
    });
    client.auth.onAuthStateChange(function (event, session) {
      if (event === 'PASSWORD_RECOVERY' && hooks.onRecovery) hooks.onRecovery();
      var next = session && session.user ? session.user : null;
      var changed = (next && next.id) !== (user && user.id);
      user = next;
      if (!user) { base = 0; unsubscribe(); setStatus('signed-out'); return; }
      if (changed) {
        // Defer: Supabase recommends not awaiting other calls inside this callback.
        setTimeout(function () { subscribe(); pull(true); }, 0);
      }
    });
    root.addEventListener('online', function () { if (user) pull(); });
    root.addEventListener('offline', function () { if (user) setStatus('offline'); });
    return true;
  }

  function doc() { return hooks.getDoc ? hooks.getDoc() : {}; }

  // One operation at a time. A queued follow-up runs when the current one finishes:
  // 'pull' (fetch + merge + save if needed) beats 'push' (just save).
  var queued = null;
  function run(kind, first) {
    if (!client || !user) return Promise.resolve();
    if (busy) { if (queued !== 'pull') queued = kind; return Promise.resolve(); }
    busy = true;
    setStatus('saving');
    var job = kind === 'pull' ? doPull(first) : push(doc());
    return job
      .then(function (r) { if (r === 'stale') queued = 'pull'; else setStatus('synced'); })
      .catch(function () { setStatus(navigator.onLine === false ? 'offline' : 'error'); })
      .then(function () {
        busy = false;
        if (queued) { var k = queued; queued = null; run(k); }
      });
  }

  // Read the account's copy, merge it with this device, save back if they differ.
  function doPull(first) {
    return client.from('tempo_state').select('data, version').eq('user_id', user.id).maybeSingle()
      .then(function (res) {
        if (res.error) throw res.error;
        var local = doc();
        if (!res.data) { base = 0; return push(local); }
        var merged = mergeDocs(local, res.data.data);
        base = res.data.version;
        hooks.applyDoc(merged, { first: !!first });
        if (JSON.stringify(merged) !== JSON.stringify(mergeDocs({}, res.data.data))) return push(merged);
      });
  }

  // Save; resolves 'stale' when another device saved first (then we pull and merge).
  function push(d) {
    return client.rpc('save_state', { p_data: d, p_base_version: base }).then(function (res) {
      if (res.error) throw res.error;
      if (res.data == null) return 'stale';
      base = res.data;
    });
  }

  function pull(first) { return run('pull', first); }
  function schedule() {
    if (!client || !user) return;
    clearTimeout(timer);
    setStatus('saving');
    timer = setTimeout(function () { run('push'); }, SAVE_DELAY);
  }

  function subscribe() {
    unsubscribe();
    if (!client || !user) return;
    channel = client.channel('tempo-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tempo_state', filter: 'user_id=eq.' + user.id }, function (payload) {
        var row = payload.new;
        if (!row || !row.version || row.version <= base || busy) return;
        base = row.version;
        hooks.applyDoc(mergeDocs(doc(), row.data), { remote: true });
        setStatus('synced');
      })
      .subscribe();
  }
  function unsubscribe() { if (channel && client) { client.removeChannel(channel); channel = null; } }

  function redirect() { return root.location ? root.location.origin + root.location.pathname : undefined; }
  function signUp(email, password) { return client.auth.signUp({ email: email, password: password, options: { emailRedirectTo: redirect() } }); }
  function signIn(email, password) { return client.auth.signInWithPassword({ email: email, password: password }); }
  function signOut() { unsubscribe(); return client.auth.signOut(); }
  function resetPassword(email) { return client.auth.resetPasswordForEmail(email, { redirectTo: redirect() }); }
  function updatePassword(password) { return client.auth.updateUser({ password: password }); }

  var api = {
    mergeDocs: mergeDocs, init: init, pull: pull, schedule: schedule,
    signUp: signUp, signIn: signIn, signOut: signOut, resetPassword: resetPassword, updatePassword: updatePassword,
    get user() { return user; }, get status() { return status; }, get ready() { return !!client; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TempoSync = api;
})(typeof window !== 'undefined' ? window : this);
