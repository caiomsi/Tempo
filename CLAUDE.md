# CLAUDE.md

Tempo is a **personal productivity app**, not a marketing site. Live at **https://tempo.caiomsi.com**
(GitHub Pages, repo `caiomsi/Tempo`). It **has Node tests + CI**: run `node test/parse.test.js`
and `node test/sync.test.js` before pushing. Accounts and sync use **Supabase project `tempo`**
(`yjvkfzbjiivsktyfronh`, MSI Studio org, us-east-1). See the root `../CLAUDE.md` for shared
conventions.

## What it does

- **Left panel (the clock):** the original Tempo ring, built by `buildChrono(svg)`, which
  returns `update({ left, budget, label, sub })`. Caio asked to return to it on 2026-10-13
  after trying a chronograph, a square macOS-style face and a one-pointer face.
  - A thin `--accent` ring on a `--line` track empties as time is used, and turns `--bad` past the budget.
  - Inside it: the label (LEFT TO WORK / SESSION LEFT / TO FINISH / OVER BUDGET), the
    H:MM:SS countdown, and "of 20h · 3h worked".
  - The ring breathes while a task timer runs. `sv()` routes `var()` colours through `style`.
  - Below it: the status badge, time left vs. work planned, the current task, pace,
    and estimate accuracy.
- **Pop-out mini timer** (the button next to Edit, or `p`): in Chrome and Edge,
  Document Picture-in-Picture opens a small always-on-top window (`setupMiniWindow`,
  `MINI_HTML`, `.mini*` CSS) with the dial plus Start/Pause/Done. Elsewhere, such as
  Safari, `drawMiniCanvas` paints the timer onto a canvas, which floats as a
  video-PiP; its play/pause button toggles the task timer through `mediaSession`.
  The pop-out builds the same ring with `buildChrono`; the canvas fallback paints the ring itself.
- **Clock-only mode** (the expand button by the clock, `c`, double-clicking the clock, or the
  menu): a full-screen overlay `#clockmode` with its own `buildChrono` plus the time left.
  - Controls fade after 2.5s idle, and it requests full screen plus a screen wake lock where
    allowed.
  - Esc, `c`, or leaving full screen closes it. `renderClockMode` runs from `renderClock`.
- **Right panel ("board"):** a plain-language brain-dump input with dictation, and
  the tasks grouped by **category**.
- The cutoff is computed globally. Open tasks are ranked by priority, then `order`,
  and once their summed remaining time passes the time left, every task from that
  point down is marked "won't fit".

- **Theme:** the top-bar button is a sun/moon toggle (`t`). It follows the system until
  the first click, and the menu offers "Match system theme" to go back.

## How it runs

Plain static HTML/CSS/JS, with no build step. Open `index.html` directly, or run
`python3 -m http.server` in this folder and visit `localhost:8000`. Dictation (Web
Speech API) needs `localhost` or https, not `file://`.

## Structure

```
index.html            shell: clock panel, board, focus overlay, dialogs (week, task, close, session, end-session, auth, help)
css/style.css         paper/ink tokens + per-category colours (--c-*) + chronograph tokens (--ch-*), light/dark
js/parse.js           TempoParse: plain language → tasks, categorizer, time estimates. Pure, no DOM (Node-testable)
js/sync.js            TempoSync: Supabase auth + saving + mergeDocs (pure, Node-testable)
js/main.js            the app (one IIFE): state, render, chronograph, sessions, preview, pop-out, focus
test/*.test.js        plain-Node tests (assert); .github/workflows/test.yml runs them on push
favicon.svg, apple-touch-icon.png, img/  logo mark, app icons, og-image (rendered from the SVGs with headless Chrome)
manifest.webmanifest  add-to-home-screen on phones
```

## Study sessions vs weeks

Periods have `kind: 'week' | 'session'`.
- A session has `startedAt` and `budgetMin`. A `null` budgetMin means Tempo estimates the
  length: work plus breaks, using `TP.breaksFor` (10 min per 50 min of work).
- A session also has `breaks`, `parentId` (the week it came from, or null for a standalone
  session) and `linkIds`.
- Linked week tasks keep their week `periodId`, so time worked in the session counts toward
  the week too.
- New tasks added inside a week-tied session go onto the week and are linked to the session.
- Sessions always start now. The dialog takes an **"Ends at"** time (`<input type=time>`)
  or a length, and "until 6pm" typed in the length box also works.
  - `sessionEnd()` turns either into minutes, using `TP.parseEndTime`: a bare "6" means the
    next 6 o'clock, and a time that has already passed rolls to tomorrow.
  - `budgetMin` is counted from the moment the session starts, so the countdown ends
    exactly at the chosen time.
- `sessionMetrics()` counts only logs after `startedAt`.
  - With a set length, the session counts down in real time.
  - Auto sessions show the time left to finish.

## Sync

- localStorage is always the working copy, and the app works signed out.
- `save()` stamps `updatedAt` on every task or period that changed, using a snapshot diff in
  `stampChanges`. It records deletions in `state.deleted` and stamps `runningAt` when the
  timer starts or stops.
- `TempoSync.mergeDocs` picks the newer item by id. Deletions stick unless the item was edited
  later. Time logs from both sides are combined, and `logsResetAt` honours a hand-edited
  logged time.
- The database has one row per user, `public.tempo_state` (data jsonb, version), with RLS
  limiting each user to their own row.
  - Saves go through the `save_state(p_data, p_base_version)` RPC, which only writes if the
    version matches.
  - A stale save returns null, so the client pulls, merges and retries.
  - Realtime updates are on for this table.
- Settings (theme) and `activePeriodId` are per-device and never synced.
- Supabase's built-in email only delivers to members of the org. Anyone else needs custom
  SMTP set up (Resend) before their confirmation and reset emails will arrive.

## js/main.js map

- **Parsing (js/parse.js):** `parseDump(text, ctx)` splits on lines, `;`, sentences, commas, then on "and"
  only when both sides look like real tasks. One-word fragments merge back into the
  previous task. `parseOne` pulls out the category (`#tag`, "for school"), duration
  (`takeDuration`: "2h", "45 min", "an hour and a half", "a couple hours"), priority
  ("urgent", "if I have time", `!high`) and due date ("by friday", "tomorrow",
  `@10/17`), then `cleanTitle` strips lead-ins like "I need to" and `condense` boils the phrase down to the task. It drops filler, determiners and weak verbs (do/finish/take) before a `TASK_NOUN`, and reorders "quiz for my business class" into "Business class quiz". A line `School:` sets
  the category for the lines under it.
- **Context and estimates:**
  - `inferTask` turns "I have a chem test friday" into "Study for chem test".
  - `NOT_TASK` / `ACTION_VERBS` mark things that aren't tasks as `skip`.
  - Duplicates (Jaccard ≥ 0.8 against `ctx.openTitles`) are marked `dup`.
  - `findQty` reads pages, chapters and problems.
  - When no time is given, `estimateFor` first uses the median of your similar finished
    tasks (`ctx.history`). Otherwise it uses `EST_TABLE`, scaled by quantity and
    `ctx.factor`. The result is flagged `estGuess` and shown as "~45m".
- **Categorizer:** `classify(title, ctx)` scores against the `CAT_WORDS` keywords (phrases
  use `_`) plus `state.learn`. `learn(title, cat)` runs whenever the person forces or
  changes a category (`#tag`, the edit dialog, or dragging into another group).
- **Metrics:** `metrics(p)` returns used, remaining, left, cutIds, pace and so on.
  `accuracy()` needs 3 or more finished, timed tasks.
- **Preview:** `buildPreview` / `renderPreview` keep your edits to each row (`ui.edits`,
  keyed by the row's original wording) while you keep typing.
- `window.__tempo` exposes `state`, `metrics`, `setupMiniWindow` and `applySyncedDoc` for
  the headless test harnesses.

## Data (localStorage `tempo:v1`)

```
{ periods: [{ id, name, start, end, budgetMin, closed }], activePeriodId,
  tasks: [{ id, periodId, title, estMin, priority, due, category, notes, done, carried,
            doneAt, order, logs: [{ start, end }] }],
  running: { taskId, start } | null,  learn: { word: { Category: weight } },
  settings: { theme, pomodoro } }
```

`normalize()` migrates the old `tag` field to `category`. Closing a period copies the
open tasks into the new period with their remaining estimate (minimum 15m) and marks
the originals `carried`.

## Verifying

- Run `node test/parse.test.js` and `node test/sync.test.js` (CI runs both on push).
- For the UI, inject an assertion script into a copy of `index.html` and run headless Chrome
  with `--dump-dom`.
- For anything that waits on the network (sync), drive Chrome in real time over CDP instead,
  because `--virtual-time-budget` snapshots the page before requests finish.
- To test sync, use a throwaway confirmed user created in SQL (`auth.users` +
  `auth.identities`), and delete it afterwards.
