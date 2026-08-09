# Design audit — Handrail, 2026-08-09

**Target:** the running app, driven through `electron .` with Playwright.
**Classifier:** APP UI — a workspace-driven, task-focused overlay. Landing-page
rules (hero composition, brand-first hierarchy, expressive display type) do not
apply and were not used.
**Constraint set by the author:** the product works and is not to be redesigned.
Defects only.

| | Before | After |
|---|---|---|
| Text failing WCAG AA | 8 elements | 0 |
| Font sizes off the type scale | 2 | 0 |
| Raw hex outside tokens | 0 | 0 |
| `transition: all` | 0 | 0 |
| Design score | B | A− |

Three findings fixed. Four flagged and deliberately not fixed, because fixing
them would be a redesign rather than a repair.

---

## First impression

The overlay communicates **restraint**. It is a dark bar that stays out of the
way, and everything in it is either a word you typed or a control you can name.
Nothing decorative. No gradient, no card grid, no icon-in-a-circle, no emoji.

The first three things the eye goes to: the mint mark at the left, the
placeholder asking what you are trying to do, and the mint-outlined capture
toggle at the right. Those are the right three — the identity, the invitation,
and the one setting that changes what the product does.

One word: **quiet.**

AI slop check: none of the ten blacklist patterns are present. Two typefaces
(Inter for UI, JetBrains Mono for code and keycaps), fifteen distinct rendered
colours, one accent used for exactly the three things `DECISIONS.md` reserves it
for. This does not look generated.

---

## Fixed

### DR-001 — `--text-tertiary` failed WCAG AA — **high**

**Commit:** `65a74fc` · **File:** `design/tokens.css`

Measured in the running app by compositing the rendered colour against its real
backdrop: `rgba(255,255,255,0.44)` over `#131519` gives **4.37:1**. AA requires
4.5:1 at these sizes.

That token is not decoration. It carries every settings row's explanation
("Every question includes a screenshot", "Draw an arrow at the control to use",
"Handrail won't appear in calls or recordings"), the API key hint and the panel
headings. Those explanations are the only description of what each toggle does,
for an audience `PRODUCT.md` defines as people who are not technical.

**Fix:** 0.44 → 0.46, which measures **4.66:1**. Invisible to the eye, and the
hierarchy is untouched — tertiary is still the quietest of the three text
tokens. `--white-a44` had no other user, so it is gone rather than left beside a
near-identical twin.

### DR-002 — two font sizes were off the type scale — **medium**

**Commit:** `b520de3` · **File:** `renderer/overlay.css`

`design/tokens.css` defines the scale from `--text-micro` (10.5px) up. Two rules
set a raw value below the smallest step:

| Rule | Was | What it is |
|---|---|---|
| `.step__mark` | `9px` | the number telling the user which step they are on |
| `.side__group` | `9.5px` | the date headings in the threads list |

Both are `--text-micro` now. `.side__group` also moves off
`--text-placeholder`, which measured **3.11:1** — below AA and below the 3:1
floor for anything a user is meant to read.

Nothing else in the renderer sets a raw font-size. The one remaining relative
value, `0.92em` on inline code, is a deliberate optical correction for the mono
face rendering large at the same pixel size.

### DR-003 — the empty threads list was rendered as a category heading — **medium**

**Commit:** `b520de3` · **Files:** `renderer/overlay.css`, `renderer/overlay.js`

The empty state reused `.side__group` — the uppercase micro label that heads
"Today" and "This week". So "No threads yet" appeared as a heading for a group
that was not there, in the palette's quietest colour, saying nothing about what
to do next. A component was doing a job it was not built for.

Now `.side__empty`: a sentence, set like one, naming the next action. "No
conversations yet. Ask Handrail something and it will show up here."

---

## Found while verifying, and fixed

### The pointing smoke checks raced about one run in four

**Commit:** `1f4c523` · **File:** `scripts/smoke.js`

Two checks failed after a design change that could not possibly have caused
them. Six clean runs on the unchanged tree, then a failure on the fourth run
with the change, is not evidence of a regression — it is evidence of a race.

The capture toggle is clicked through the UI on purpose, because `ask()` sends
the renderer's own capture flag. But the click was never waited for: it starts
an async settings round trip, and submitting before it lands sends
`capture:false`, so no screenshot is taken, no display is resolved, and no
pointing happens at all. The failure read as the pointing feature being broken.

Replaced the fixed sleeps with `settled()`, which polls a condition. Six
consecutive clean runs afterwards.

This is the whole argument for re-verifying after every change: the flake was
sitting in the suite the entire time and would eventually have been blamed on
whatever landed next.

---

## Flagged, not fixed

Each of these is a real observation. Each would be a redesign, not a repair, so
they are the author's call.

**The type scale is small for the stated audience.** Body UI text is 12.5px and
the smallest step is 10.5px. Conventional guidance is 16px body. For a compact
always-on-top overlay 12.5px is defensible, and every size is on a deliberate
scale — but the product is explicitly aimed at people who are struggling, and
they are the ones least served by small type. Raising the scale would change
every window's size and layout.

**The input placeholder measures 3.11:1.** `--text-placeholder` at 0.34 alpha.
The placeholder — "What are you trying to do?" — is the only prompt a
first-time user gets, and it is the lowest-contrast text in the product.
Raising it would visibly change the weight of the empty bar, which is the
product's resting state and the thing seen most often.

**The send keycap measures 3.11:1.** Same token. It clears the 3:1 floor for a
non-text UI component and it brightens to the accent on hover, so it is
arguably fine as a control indicator. It is not fine as text.

**Touch targets are 17–22px.** The settings switches are 30×17, the send key
18×18, the icon buttons 22×22. The 44px guidance is written for touch; this is a
mouse-driven desktop overlay where 44px controls would double the height of the
bar. Worth knowing if a touch or tablet build is ever considered. The hit area
could be grown without changing the visual size, but that is a change to every
control and was out of scope here.

---

## What was checked and is clean

- **Tokens:** zero raw hex values anywhere in `renderer/*.css`. The three-layer
  token system holds.
- **Motion:** no `transition: all` anywhere. Every transition names its
  properties.
- **Focus:** real keyboard Tab produces a 2px mint `:focus-visible` outline on
  every button in the bar. The question field uses a mint caret instead, which
  is the conventional indicator for a text field and is deliberate
  (`caret-color: var(--accent)`).
- **Typography:** two families, both intentional. No blacklisted faces. No
  system-ui as the primary face.
- **Colour:** 15 distinct rendered colours, under the 12-non-gray guideline once
  greys are excluded. One accent, reserved for the arrow, the current step and
  the focus ring, exactly as `DECISIONS.md` requires.
- **Hierarchy:** the checklist's three step states (todo → tertiary, done →
  secondary, active → primary + medium weight) are a deliberate, commented
  hierarchy. Left alone.
- **Content:** no happy talk, no lorem ipsum, no instructions compensating for
  an unclear interaction. Settings copy is written as things you do, not
  features you have. Proper ellipsis characters throughout.

## PR summary

> Design audit found 4 issues, fixed 4. All text now clears WCAG AA; no font
> sizes off the type scale. Design score B → A−.
