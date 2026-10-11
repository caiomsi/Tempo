# CLAUDE.md

Tempo is a **personal productivity app**, not a marketing site. Live at **https://tempo.caiomsi.com**
(GitHub Pages, repo `caiomsi/Tempo`; data still stays in each browser). See the root `../CLAUDE.md` for shared
conventions.

## What it does

- **Left panel (the dial):** a big countdown of the time left in the period's hour
  budget (the budget minus time worked), ticking live while any task timer runs. The
  thick outer ring is the time left and drains as you work, with a knob at its end.
  The thin inner ring is the planned work still to do, drawn red past the point where
  it no longer fits. There are hour ticks around the edge and the status badge sits on
  the dial face. Below it: the current or next task, pace, and estimate accuracy.
- **Pop-out mini timer** (the button next to Edit, or `p`): in Chrome and Edge,
  Document Picture-in-Picture opens a small always-on-top window (`setupMiniWindow`,
  `MINI_HTML`, `.mini*` CSS) with the dial plus Start/Pause/Done. Elsewhere, such as
  Safari, `drawMiniCanvas` paints the timer onto a canvas, which floats as a
  video-PiP; its play/pause button toggles the task timer through `mediaSession`.
  `dialData(m)` is the math shared by the main dial and the mini timer.
- **Right panel ("board"):** a plain-language brain-dump input with dictation, and
  the tasks grouped by **category**.
- The cutoff is computed globally. Open tasks are ranked by priority, then `order`,
  and once their summed remaining time passes the time left, every task from that
  point down is marked "won't fit".

## How it runs

Plain static HTML/CSS/JS, with no build step. Open `index.html` directly, or run
`python3 -m http.server` in this folder and visit `localhost:8000`. Dictation (Web
Speech API) needs `localhost` or https, not `file://`.

## Structure

```
index.html     shell: clock panel, board, focus overlay, dialogs (period, task, close, help)
css/style.css  paper/ink tokens + per-category colours (--c-school … --c-other), light/dark
js/main.js     everything, as one IIFE
```

## js/main.js map

- **Parsing:** `parseDump(text)` splits on lines, `;`, sentences, commas, then on "and"
  only when both sides look like real tasks. One-word fragments merge back into the
  previous task. `parseOne` pulls out the category (`#tag`, "for school"), duration
  (`takeDuration`: "2h", "45 min", "an hour and a half", "a couple hours"), priority
  ("urgent", "if I have time", `!high`) and due date ("by friday", "tomorrow",
  `@10/17`), then `cleanTitle` strips lead-ins like "I need to" and `condense` boils the phrase down to the task. It drops filler, determiners and weak verbs (do/finish/take) before a `TASK_NOUN`, and reorders "quiz for my business class" into "Business class quiz". A line `School:` sets
  the category for the lines under it.
- **Categorizer:** `classify(title)` scores against the `CAT_WORDS` keywords (phrases
  use `_`) plus `state.learn`. `learn(title, cat)` runs whenever the person forces or
  changes a category (`#tag`, the edit dialog, or dragging into another group).
- **Metrics:** `metrics(p)` returns used, remaining, left, cutIds, pace and so on.
  `accuracy()` needs 3 or more finished, timed tasks.
- `window.__tempo` exposes `parseDump`, `classify` and `parseDuration` for test
  harnesses.

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

Run `node --check js/main.js`. For the parser, load `main.js` in Node with stubbed
`document`, `localStorage` and `addEventListener`, then call `window.__tempo.parseDump`.
For the UI, use headless Chrome `--dump-dom` with an injected assertion script (see the
site-verification notes in memory).
