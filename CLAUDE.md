# CLAUDE.md

Tempo is a **personal productivity app**, not a marketing site. Live at **https://tempo.caiomsi.com**
(GitHub Pages, repo `caiomsi/Tempo`; data still stays in each browser). See the root `../CLAUDE.md` for shared
conventions.

## What it does

- **Left panel (the chronograph):** an analog watch face built by `buildChrono(svg)`,
  which returns an `update(state)` fed by `chronoState(m, cur)`.
  - Big dial: the total time left in the period's hour budget. The hour hand is on a
    0–budget scale (numerals drawn per budget), plus a minute hand, a once-a-second
    second hand, and an `h:mm:ss` readout window ("+h:mm OVER" past the budget).
  - Left sub-dial: a stopwatch for the current task (running, or else up next).
  - Right sub-dial: that task's % complete against its estimate, with a filling arc.
  - Colours come from the `--ch-*` tokens: a white face in light mode and a black face
    in dark mode. `sv()` routes `var()` colours through `style`, because SVG
    attributes can't take `var()`.
  - Below it: the status badge, time left vs. work planned, the current task, pace,
    and estimate accuracy.
- **Pop-out mini timer** (the button next to Edit, or `p`): in Chrome and Edge,
  Document Picture-in-Picture opens a small always-on-top window (`setupMiniWindow`,
  `MINI_HTML`, `.mini*` CSS) with the dial plus Start/Pause/Done. Elsewhere, such as
  Safari, `drawMiniCanvas` paints the timer onto a canvas, which floats as a
  video-PiP; its play/pause button toggles the task timer through `mediaSession`.
  The pop-out builds the same chronograph with `buildChrono`; the canvas fallback draws a simplified one.
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
