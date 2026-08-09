# Handrail — working notes for AI agents

Read `CONTEXT.md` first. It carries the session handoff: what runs, what is
broken, and the traps. `DECISIONS.md` is append-only and records why things are
the way they are — do not re-litigate a line that is already in it.

## What this is

An Electron desktop overlay that screenshots the user's screen, asks a vision
model what to do, and draws an arrow at the real control on the real screen.
Aimed at people who can follow an instruction but cannot diagnose why step 4
failed.

Fork of OpenCluely (Apache-2.0). Commit `7909792` is the pristine upstream
import; everything after it is original work, so `git diff 7909792..HEAD` is the
portfolio artifact.

## Rules that have bitten us

- **Never import from `spike/` inside `src/`.** `spike/` is not packaged. Doing
  it crashes the packaged app on boot with an unexplained error dialog, and
  `npm start` will not catch it because `spike/` exists in the repo.
- **The renderer sends its own `capture` flag** on every `ask`. Changing capture
  in the store alone leaves main and the renderer disagreeing.
- **The renderer mints `turnId`,** not main. Main starts emitting immediately
  and a fast answer beats the IPC round trip.
- **Model output must never reach `innerHTML`.** Everything in the transcript is
  built with `createElement` and `textContent`.
- **The API key never crosses the bridge** after setup — only a masked hint.
- **Screenshots never cross the bridge** at all.

## Verify before claiming

```bash
npm test                        # 30 unit tests, no Electron needed
npx electron scripts/smoke.js   # 49 checks against the real main process
node scripts/package-win.js --install   # rebuild and reinstall the real app
```

`scripts/smoke.js` writes screenshots to `%TEMP%\handrail-smoke` — look at them.
This project's standing instruction is to verify visually rather than assert.

## Style

- Single-line bullet points in replies to the user. Plain language, no jargon.
- Update `CONTEXT.md` and `DECISIONS.md` when a decision is made, not at the end.
- Flag unnecessary complexity. Complexity means breakage.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
