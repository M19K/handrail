# Handrail — Product Specification

> Product decisions from the design session on 2026-08-01. This is the source of
> truth for what Handrail does and how it behaves. `CONTEXT.md` covers project
> state; this file covers the product itself.

---

## The thesis

**The best way to learn something is by doing it.** Handrail sits transparently
over the app you're actually using and walks you through the real thing —
telling you what to click, where it is, and what to do next.

**Flagship use case: operating complex software.** Adobe Premiere Pro, After
Effects, Fusion, Unreal Engine, Excel. Today a non-technical person must go find
a tutorial, watch it, then try to map it onto their screen. Handrail collapses
that: open the app, state the task, and be guided through it live.

Secondary: installations, terminal commands, debugging, "what does this article
mean", any question where the screen is the context.

---

## Interaction model

### Three UI states
1. **Collapsed pill** — minimal footprint, effectively invisible
2. **Expanded bar** — input + quick actions. **This is the default on launch.**
3. **Expanded answer** — scrollable response panel with code blocks and copy buttons

Overlay **expands into sections / side panels** for everything else — settings,
API key, thread history. There is no separate dashboard app.

### Screen capture
- **On by default.** Every prompt captures the screen, because the assumption is
  the question is about what's on screen.
- **Toggle to disable** must exist — saves cost, and users need the control.
- **Rejected:** letting the model decide whether to capture. Too unpredictable.
- **Full screen only.** No region select, no window picker. Simplicity over options.
- **Multi-monitor:** captures whichever monitor the overlay is currently on.
  Move the overlay to change what it sees. Intuitive, no configuration.
- A clear **"screenshot captured"** indicator (Cluely-style) tells the user it
  happened. **No thumbnail preview** — full screen capture makes it redundant.

### Window behaviour
- Draggable via a **proper grip affordance** (Pluely's dotted handle), not
  "drag the logo and hope"
- **X to close** the overlay entirely
- Remembers position between sessions

---

## Task model

**Hybrid — both modes, chosen intelligently:**

- **Quick question:** "What is this article about?" → answer, no ceremony
- **Guided task:** "Set up Unreal Engine and configure X, Y, Z" → step tracking

**The checklist UI appears only when the task is genuinely multi-step.** This
requires intent classification on the prompt — the hard part, and the thing that
makes the product feel smart rather than noisy. Most real prompts are generic
("how do I do this?"), so defaulting to a checklist would be wrong most of the
time.

Accepted tradeoff: more to build, in exchange for maximum value to
non-technical users — provided it's polished.

---

## Step completion — how Handrail knows you've done it

**Decided 2026-08-08. Hybrid, but weighted heavily toward watching.**

The governing assumption: **the user will not click "done".** Someone who is
struggling through Premiere is not going to stop and do bookkeeping for us.
Manual ticking exists as an escape hatch, not as the mechanism. Handrail holds
the user's hand — that means it works out where they are by looking.

### Each step carries its own done-condition

The plan-time model call that produces the steps also produces, for each step, a
short **visual criterion** — what the screen looks like once this step is
complete ("the Razor tool is highlighted in the toolbar").

This is the load-bearing decision. It turns verification from an open-ended
"where are we in this process?" into a cheap, targeted yes/no. We never re-derive
the plan just to check a box.

### When Handrail looks

Never on a timer. Polling is expensive, wasteful and slightly creepy.

1. **Local change gate — free.** Downscaled frames compared locally. If the
   screen has not materially changed, nothing happens and nothing is spent.
2. **Quiet debounce — free.** Wait until the screen has been stable for ~1.2s.
   The user has stopped moving; checking mid-drag would read half an action.
3. **Targeted check — one small call.** Ask only whether the *current* step's
   criterion is met. Downscaled capture: a yes/no needs far less resolution than
   locating a control for an arrow.
4. **Rate cap.** At most one check every ~4s regardless of activity.

Result: a user reading the screen and not touching anything costs nothing at all.

### What happens on each outcome

| Outcome | Behaviour |
|---|---|
| Step complete | Tick it, advance, move the arrow. This is the second demo moment after the arrow — the checklist advancing on its own. |
| Not yet | Silence. Never nag. |
| User did something wrong | Say so gently and correct — **this is the most valuable case and the reason the product exists.** |
| User has gone off-plan entirely | Offer to re-plan from what's on screen now. Never silently rewrite the plan. |
| Three failed checks in a row | Stop checking, surface the manual tick. Failing quietly beats failing loudly and repeatedly. |

### Guardrails

- **Advancing is always soft.** The user can step back; no state is destroyed by
  a wrong call.
- **Manual tick is always present**, just never required.
- **Watching is visible and switchable** in settings — it costs the user money
  and sees their screen, so hiding it would be indefensible.

### Cost

Roughly one small vision call per completed step, plus occasional misfires. On
`google/gemini-2.5-flash` with a downscaled frame this is a fraction of a cent
per step. The local gate is what keeps it there.

---

## Indicators

The arrow drawn on the real screen, plus its message. Called an indicator.

**When one appears.** Whenever the reply tells the user to touch something that
is visibly on screen — a checklist step or an ordinary answer. It is not tied to
checklists; a plain reply saying "right-click the tab and choose Show in system
explorer" gets an indicator too.

**One at a time.** Two arrows is a diagram, not an instruction.

**How it goes away**, in the order it usually happens:

| Trigger | Why |
|---|---|
| The user clicks its X | Guidance you have finished with is guidance in the way |
| The step it belongs to completes | It is pointing at something already done |
| The next question is asked | It belongs to the previous answer |
| The overlay is collapsed or quit | An arrow stranded on screen with Handrail gone is the worst failure this product has |
| 45 seconds | A backstop, not the intended route. Long enough to act on while actually doing the thing |

**The X is the only clickable thing on the pane.** Everything else stays
click-through, because the user has to be able to click the control the arrow is
pointing at. The window accepts clicks only while the cursor is over the label.

---

## Visual cues (v1.1, architect for it now)

Drawing arrows/highlights **on the actual screen** at the actual button. This is
the strongest differentiator in the product — "click the button in the top right"
is what every chatbot says; pointing at it is what nobody does.

Vision models can return bounding boxes, and the transparent always-on-top
overlay is already 80% of the mechanism. **Scoped out of v1 to protect the
timeline, but the architecture must not foreclose it.**

---

## Threads

- Behave like Claude/ChatGPT chats — one per subject or task
- **New thread created by default** on restart when the user starts typing
- Serve two purposes: separating use cases, and escaping a maxed-out context window
- **Auto-titled** from the first prompt
- User can **rename** and **delete**
- **Persist across restarts**, stored **locally** (markdown or equivalent)
- **Search across thread names** (basic; not full-text initially)
- **Cross-thread memory** desirable if not too costly to build

---

## Onboarding

- Driven by an API key. Aim for the **least possible friction**.
- **Ideal (unresolved):** no key at all — model pre-plugged, user simply pays.
  See "Open problems" below; this conflicts with being open source.
- **Fallback:** a single API key field that **auto-detects the provider** from
  the key format (OpenAI `sk-`, Anthropic `sk-ant-`, OpenRouter `sk-or-`).
  One box, no dropdown, no provider selection.
- **Idea worth pursuing:** ship a small allowance of free tokens on a pre-loaded
  model so Handrail can **demonstrate itself by walking the user through getting
  their own key.** The onboarding *is* the product demo. (Funding question open.)
- Onboarding may live in a **one-time real window**, or as a **side panel on the
  overlay**. Leaning one-time window; UI call not yet made.

### Empty state
Generic prompts that convey purpose:
- "What would you like help with?"
- "What are you trying to set up?"
- "What would you like to install?"

---

## Privacy

Must be stated plainly during onboarding, because it's a genuine differentiator:

> Everything stays on your machine — screenshots, API keys, threads, history.
> The only thing that leaves your computer is the request to the AI provider.

- No telemetry
- No local redaction of sensitive on-screen content (decided against for v1)

---

## Invisibility

**Kept in full.** Not the product's purpose, but genuinely useful and already
built. Handrail can be used the way Cluely and Pluely are — the difference is it
does not record meetings.

---

## File attachment

**Purpose: supplying reference material for the current task.**

Canonical example: the user has Cursor's documentation as a PDF and is working
in Cursor. Handrail reads the doc, sees the screen, and guides them through the
task using *their* documentation.

Attach = additional context for the task at hand, working alongside screen
capture. Not a general file manager.

---

## Design direction

**Take from Cluely:** the collapsed pill, compact command bar, expand-on-answer
panel, copy buttons, overall restraint.

**Take from Pluely:** the drag grip affordance, thread-history side panel,
file attach.

**Reject from Pluely:** navigational sprawl. Its Home icon, Dashboard button and
gear all lead to the same place — three affordances, one destination.

**Governing principle:** don't bombard the user with options. Keep the screen
clutter-free. Every added control must earn its place.

---

## Open problems

1. **The API key paradox.** "No key, model pre-plugged, user just pays" requires
   a hosted proxy that holds a key and bills users — that's a business with
   payment processing, abuse prevention, and running costs, not a portfolio
   project. An open-source app also cannot ship a working key. Same problem
   applies to the free-token onboarding demo: someone has to pay for those
   tokens. **Realistic v1: BYO key, made as painless as possible.**
2. **Intent classification** — how reliably can we decide "checklist vs. plain
   answer" from a prompt?
3. **Step completion** — in guided mode, how does Handrail know a step is done?
   Does it watch the screen, or does the user confirm?
4. **Cross-thread memory** — scope and storage design not yet determined.
