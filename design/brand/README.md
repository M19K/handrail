# Handrail — mark usage

Chosen 2026-08-08. Variation **C4 with the grip**.

A handrail drawn in one continuous stroke: flat, then turning down into its own
post — the terminal you actually grab at the bottom of a staircase. The mint
grip is the person on it.

---

## Canonical geometry

Everything is drawn on a **24 × 24 grid**. These two values are the mark; any
file that disagrees with them is wrong.

```
rail   M3 9h11.5c3 0 4.5 1.6 4.5 4.5V20
grip   circle cx=8 cy=9 r=3.4
```

- `stroke-width` **2.6** at 24px and above, **3** at 20px and below
- `stroke-linecap` and `stroke-linejoin` both **round** — the rail is a tube,
  and mitred ends would read as a bracket
- Rail takes `currentColor` at **42% opacity**; the grip is always `#2FD9A8`

---

## Files

| File | Use |
|---|---|
| `mark.svg` | Default. Two-tone, 24px grid, rail inherits `currentColor`. |
| `mark-mono.svg` | Single colour. Favicons, recolouring trays, print, and anywhere the mark sits on mint. |
| `mark-16.svg` | **20px and below.** Not a scaled `mark.svg` — see below. |
| `app-icon.svg` | 1024 master for `.ico` / `.icns` / PNG set. |
| `wordmark.svg` | Horizontal lockup with the name. |

### Why there is a separate 16px file

At 16px the 2.6 stroke lands between pixels and the 3.4 grip loses its edge, so
the mark goes soft exactly where it is used most — tray, taskbar, favicon, the
collapsed pill. `mark-16.svg` thickens both and nudges the grip left to keep it
clear of the curve. **Use it. Do not scale the 24px file down.**

---

## The grip is a variable

Its position along the flat section is meaningful, not decorative. In the
product it is a working progress indicator: the grip slides right as steps
complete.

| State | `cx` |
|---|---|
| Idle / brand use | `8` |
| Step 1 of *n* | `5` |
| Midpoint | `9.75` |
| Final step | `14.5` |

Travel is bounded by the flat section only — `cx ∈ [5, 14.5]`. The grip never
enters the curve, because a hand does not grip a corner.

Animate with `--dur-normal` / `--ease-out` from `tokens.css`. It moves when a
step is confirmed complete, never on a timer.

---

## Clear space and minimum size

- **Clear space:** 4 grid units (⅙ of the mark's width) on every side. Nothing
  crosses it, including the wordmark's own text.
- **Minimum size:** 16px. Below that use the grip alone as a dot — the rail is
  no longer legible and a smudge is worse than an abstraction.
- **Lockup gap:** the wordmark's text starts at `x=33` on the 24-unit grid,
  i.e. a gap of 9 units. Specified as a ratio so the lockup survives scaling.

---

## Don't

- Don't scale `mark.svg` below 20px — use `mark-16.svg`.
- Don't recolour the grip. Mint is the signature and it is the same colour as
  the on-screen arrow; changing it breaks the connection between the logo and
  the product's headline feature.
- Don't outline the grip. Filled is what keeps the mark asymmetric, and
  asymmetry is what stops it reading as a bracket.
- Don't add a second grip. One hand, one position.
- Don't set the rail at full opacity in the two-tone version — the grip has to
  win, or the mark becomes a corner glyph with a dot on it.
- Don't rotate or mirror. The rail descends to the right because reading order
  does; mirrored, it reads as an exit rather than a route.

---

## Generating packaged icons

`app-icon.svg` is the master. The packaged formats are a build step:

```bash
npx electron-icon-builder --input=design/brand/app-icon.svg --output=build
```

Windows wants `.ico` at 16/24/32/48/64/128/256, macOS wants `.icns`, Linux
wants the PNG set. Regenerate whenever the master changes; never hand-edit a
packaged icon.
