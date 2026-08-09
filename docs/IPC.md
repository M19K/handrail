# Handrail — IPC contract

The boundary between the main process and the renderer. One bridge, namespaced,
promise-based. Nothing else crosses.

## What this replaces

Upstream exposed **two** bridges — `window.electronAPI` (≈90 methods) and
`window.api` (a second, overlapping channel allowlist) — with fifteen separate
`onXxx` event listeners. Most of it was speech and interview machinery.

Both are deleted. The replacement is below and it is deliberately small: a
surface this size can be held in your head, and an overlay with a small surface
is an overlay that is hard to break.

---

## Design rules

1. **One bridge.** `window.handrail`. If it isn't on that object the renderer
   cannot do it.
2. **One event stream.** Everything that happens during a turn arrives on
   `onTurn` as a tagged object. Fifteen listeners became one `switch`.
3. **Commands return promises; events push.** No command has a matching
   `onCommandFinished` event, and no event needs to be requested.
4. **The renderer owns no truth.** It renders what it is told and reports what
   the user did. Threads, steps, keys and settings live in the main process.
5. **Namespaced, not prefixed.** `handrail.threads.list()`, not
   `handrail.getThreadList()`.

---

## Commands

### Turns

```js
handrail.ask({ text, capture, turnId }) // -> { turnId }
handrail.cancel(turnId)                // -> void
```

The renderer mints `turnId` and must set its own in-flight id **before**
calling. Main starts emitting immediately, and a fast answer beats the IPC
round trip — an id that only arrived in the reply would cause  and
 to be dropped as stale, leaving the bar spinning forever.

`capture` defaults to the user's setting. A turn is the entire unit of work:
capture, classify, answer or plan, and any subsequent step-watching.

### Steps

```js
handrail.completeStep(taskId, index)   // -> void   the manual escape hatch
handrail.reopenStep(taskId, index)     // -> void   undo a wrong auto-advance
```

Both exist because auto-advance can be wrong in either direction. See
`PRODUCT.md` § Step completion.

### Threads

```js
handrail.threads.list()                // -> [{ id, title, updatedAt }]
handrail.threads.open(id)              // -> { id, title, turns: [...] }
handrail.threads.create()              // -> { id }
handrail.threads.rename(id, title)     // -> void
handrail.threads.remove(id)            // -> void
```

### Settings

```js
handrail.settings.get()                // -> { capture, pointing, stealth, model, keyHint }
handrail.settings.set(patch)           // -> settings   partial patch, returns the result
```

`keyHint` is a masked tail (`sk-or-v1-••••2f9c`). **The key itself never crosses
the bridge after setup.** A renderer that cannot read the key cannot leak it.

### Window

```js
handrail.window.setState(state)        // 'collapsed' | 'bar' | 'answer'
handrail.window.resize({ w, h })       // renderer measures, main resizes
handrail.window.beginDrag()            // hands off to the OS move loop
handrail.window.close()                // hide to collapsed
handrail.window.quit()                 // actually exit
```

`resize` exists because the three states differ enormously in height. The
alternative — one large transparent window with click-through hit-testing —
means tracking the cursor to decide what is clickable, which is fragile and
costs a lot to get right on both platforms.

### Setup (onboarding window only)

```js
handrail.setup.validateKey(key)        // -> { valid, provider, error? }
handrail.setup.saveKey(key)            // -> void
handrail.setup.requestScreenAccess()   // -> { granted }
handrail.setup.complete()              // -> void
handrail.setup.openExternal(url)       // -> void
```

`validateKey` runs in main and makes a real request. Provider is inferred from
the key's shape — that is what lets onboarding have one field and no dropdown.

---

## Events

```js
const off = handrail.onTurn(event => { ... })   // returns an unsubscribe
```

Every event carries `type`. Exhaustive:

| `type` | Payload | Meaning |
|---|---|---|
| `capture` | `{ turnId }` | Screenshot taken. Renderer shows the indicator. |
| `thinking` | `{ turnId }` | Request in flight. |
| `chunk` | `{ turnId, text }` | Streamed token. Append. |
| `answer` | `{ turnId, markdown }` | Quick answer, complete. No steps. |
| `task` | `{ turnId, taskId, title, steps }` | Multi-step plan. Renderer shows the checklist. |
| `step` | `{ taskId, index, status }` | `active` · `done` · `wrong` · `offplan` |
| `point` | `{ rect }` or `{ rect: null }` | Arrow target in screen DIP, or hide. |
| `error` | `{ turnId, message, recoverable }` | Show it. `recoverable` decides whether to offer a retry. |
| `done` | `{ turnId }` | Turn finished. Nothing further will arrive for it. |

`steps[]` entries are `{ text, hint?, done }`. The `doneWhen` visual criterion
that drives auto-advance stays in main — the renderer has no use for it and
shipping it across would only invite the renderer to second-guess main.

### Why `point` is a turn event

The arrow is not a separate subsystem. It is part of answering, so it arrives on
the same stream and is cancelled by the same `cancel()`. Keeping it separate
would mean two lifecycles to keep in step, and a stale arrow left pointing at
nothing is the worst failure this product has.

---

## Not on the bridge, deliberately

- **The API key**, after setup. Only a masked hint comes back.
- **Screenshots.** They go straight from the capture service to the provider.
  The renderer never receives image data, so there is nothing for it to cache,
  log, or accidentally render.
- **Anything speech-related.** Voice is cut from v1.
- **Raw file paths.** Attachments are referred to by id.
