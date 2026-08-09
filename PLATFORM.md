# Platform parity — Windows / macOS

Overlay apps diverge sharply per-OS. This file tracks what differs, what's done,
and what will bite at ship time.

---

## Feature parity matrix

| Capability | Windows | macOS | Status |
|---|---|---|---|
| Capture exclusion | `WDA_EXCLUDEFROMCAPTURE` | `NSWindowSharingNone` | Both via Electron `setContentProtection()` — one call site, `window.manager.js:628` |
| Always-on-top overlay | ✅ | ✅ | Electron handles |
| Click-through | ✅ | ✅ | Electron `setIgnoreMouseEvents` |
| Global hotkeys | ✅ | ⚠️ Needs Accessibility permission | Untested on macOS |
| Screen capture | ✅ | ⚠️ Needs Screen Recording permission | Untested on macOS |
| Microphone | ✅ | ⚠️ Needs Microphone permission | Untested on macOS |
| System audio capture | Native | ❌ Requires a loopback driver (BlackHole/Soundflower) | **Unsolved on macOS** |
| Process-name masking | ✅ ("Terminal") | Untested | — |
| Code signing | Optional (SmartScreen warning) | **Required** (Gatekeeper blocks) | See below |

---

## macOS permissions

Usage-description strings are **already present** in `package.json` → `build.mac.extendInfo`:

- `NSMicrophoneUsageDescription`
- `NSCameraUsageDescription`
- `NSScreenCaptureUsageDescription`

These must be revised — they currently reference Whisper and OpenCluely.
The OS shows these strings to the user in the permission prompt, so they are
user-facing copy and need the same care as UI copy.

Note `build.mac.hardenedRuntime` is currently `false` and
`gatekeeperAssess` is `false`. **Hardened Runtime must be `true` for
notarization to succeed.**

---

## The macOS distribution problem

Upstream ships **no macOS build at all** — its README tells macOS users to run
from source, because an unsigned build is blocked by Gatekeeper as "damaged."
That is the problem Handrail has to solve to be credible as a product.

### Options, worst to best

| Option | User experience | Cost |
|---|---|---|
| Run from source | Clone, install Node, run a script. Technical users only. | Free |
| Unsigned `.dmg` | Gatekeeper blocks it. Right-click→Open bypass is unreliable on recent macOS; some cases need a `xattr -cr` terminal command. Unacceptable for non-technical users. | Free |
| Signed only (Developer ID) | Fewer warnings but still flagged on first open. | $99/yr |
| **Signed + notarized + stapled** | **Double-click, it opens. No warnings.** | $99/yr |

**For a product aimed at non-technical users, only the last option is viable.**
Every other path requires the user to do something a non-technical person
cannot reasonably be asked to do — which contradicts the entire product thesis.

### What signed + notarized actually requires

1. Active Apple Developer Program membership (**already held**)
2. A **Developer ID Application** certificate — issued instantly from the developer portal or Xcode; no waiting period
3. An **app-specific password** or App Store Connect API key for `notarytool`
4. `hardenedRuntime: true` plus an entitlements plist
5. electron-builder config to sign and notarize during `build:mac`
6. Notarization submission — typically minutes, not days
7. Stapling the ticket to the `.dmg` so it validates offline

**There is no additional approval wait once the account is active.** The delay
people remember is initial enrolment (especially Organization accounts needing a
D-U-N-S number). That's already done.

### Account tiers — clarification

- **Individual** — $99/yr. Sufficient. Ships under a personal name.
- **Organization** — $99/yr, needs D-U-N-S, weeks to enrol. Ships under a company name.
- **Enterprise** — $299/yr. **Not applicable** — it's for internal-only in-house
  distribution and explicitly forbids public distribution. Not a "pro" tier.

There is no premium tier that buys faster notarization.

### Entitlements likely needed

```xml
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.device.audio-input
com.apple.security.cs.disable-library-validation
```

(Electron generally needs the first three; the last is often required for
native modules.)

---

## Build machine constraint

**macOS builds must be produced on macOS.** Code signing and notarization
require Apple's toolchain (`codesign`, `notarytool`) which do not run on Windows.

Options:
- A Mac (any Apple Silicon Mac will do)
- **GitHub Actions `macos-latest` runner** — free for public repos, with the
  certificate and app-specific password stored as encrypted secrets

Since Handrail will be open source and public, **GitHub Actions is the natural
answer** — it also means reproducible releases and no dependency on having a Mac
to hand. Upstream already uses Actions for its Windows/Linux builds, so the
workflow scaffolding exists to adapt.

---

## Open platform questions

- [ ] System-audio capture on macOS — loopback driver requirement is unsolved and may need to be a documented limitation
- [ ] Whether to also code-sign on Windows (removes SmartScreen warning; separate cert, ~$100-400/yr)
- [ ] Apple Silicon vs Intel — build both, or arm64 only?
- [ ] Test all macOS permission flows on real hardware before claiming support
