# Platform parity — Windows / macOS

Overlay apps diverge sharply per-OS. This file tracks what differs, what's done,
and what will bite at ship time.

**macOS ran for the first time on 2026-08-09**, against the published
`Handrail-0.1.3-arm64.dmg` and then against a local rebuild, on a Mac mini M4
running macOS 26.5.2. Rows marked verified were watched on screen. Rows still
marked untested are genuinely untested — see "Still untested" at the bottom.

---

## Feature parity matrix

| Capability | Windows | macOS | Status |
|---|---|---|---|
| Capture exclusion | `WDA_EXCLUDEFROMCAPTURE` | `NSWindowSharingNone` | Both via `setContentProtection()` — `src/main/windows.js:196` and `:231`. **Verified on macOS**: the overlay is genuinely absent from a screen capture, and reappears when the setting is turned off |
| Always-on-top overlay | ✅ | ✅ | **Verified on macOS** — draws over the frontmost window |
| Click-through | ✅ | ✅ | Electron `setIgnoreMouseEvents` |
| Global hotkeys | ✅ | ✅ **no Accessibility permission needed** | **Verified on macOS.** ⌘⇧H and ⌘⇧⎋ both register; ⌘⇧H beats Finder's own Go→Home while Handrail runs |
| Screen capture | ✅ | ⚠️ Needs Screen Recording permission **and a restart after granting it** | **Verified on macOS.** macOS binds the decision at process launch, so granting it mid-session does nothing until Handrail restarts. Onboarding detects this and offers a Restart button |
| Menu bar / tray icon | Colour mark, 32px | **Template image, alpha only** | Different artwork, not a different size — see "The tray icon" |
| Dock presence | Taskbar entry | **None** (`LSUIElement`) | **Verified.** No Dock icon, no app-switcher entry, so the menu bar icon and ⌘⇧H are the *only* ways back |
| API key at rest | DPAPI, scoped to the **user** | Keychain, scoped to the **code signature** | Not the same guarantee — see "The keychain" |
| Microphone | n/a | n/a | **Cut from v1** with speech. The Info.plist keys are deleted at build time |
| System audio capture | Native | ❌ Requires a loopback driver (BlackHole/Soundflower) | **Unsolved**, and moot while speech is cut |
| Process-name masking | ✅ ("Terminal") | Untested | — |
| Code signing | Optional (SmartScreen warning) | **Ad-hoc signed**; Developer ID + notarisation still needed | See below |

---

## macOS permissions

`package.json` → `build.mac.extendInfo` declares exactly one usage string:

- `NSScreenCaptureUsageDescription` — the only hardware Handrail touches.

Electron's stock Info.plist also carries `NSMicrophoneUsageDescription` and
`NSCameraUsageDescription`, both placeholder text written by Electron ("This app
needs access to the microphone"). Both shipped in 0.1.3, declaring intent to
reach hardware the product does not use. `extendInfo` can add keys but not
remove them, so `scripts/afterpack-mac.js` deletes them and
`src/main/packaging.test.js` fails if anyone re-adds them.

`build.mac.hardenedRuntime` is **`false`, deliberately.** Hardened Runtime turns
on library validation, which requires every loaded binary to share one Team ID.
An ad-hoc signature has no Team ID, so switching it on without a Developer ID
certificate produces an app that cannot load its own frameworks. It goes back to
`true` **at the same time** signing and notarisation arrive, not before. A test
pins this so the two cannot drift apart.

---

## The tray icon

macOS menu bar icons are **template images**: the OS discards the colour, keeps
only the alpha channel, and re-tints the silhouette per theme. That is the only
way an icon looks right in both a light and a dark menu bar.

0.1.3 called `setTemplateImage(true)` on the full app icon — a dark rounded
square that is 98% opaque. As a template that is a filled rectangle, so what
shipped was a solid blob with the mark invisible. Colour artwork cannot be a
template at any size.

`scripts/make-tray-icons.js` draws the mark as alpha only at 16px and 32px
(`@2x`, which `nativeImage` picks up automatically on Retina menu bars) from the
same geometry as `design/brand/app-icon.svg`. Regenerate with `npm run tray-icons`.

The artwork also has to be **inside** the packaged app: `build.files` ships
`assets/**/*`. It did not in 0.1.3, so the shipped mac app logged "no tray icon
on disk" and — with `LSUIElement` removing the Dock icon too — had no visible
presence anywhere in the system.

---

## The keychain

`safeStorage` does not mean the same thing on both platforms, and the difference
decides whether the app can start at all.

| | scope | survives an update? |
|---|---|---|
| Windows | DPAPI, bound to the **user** | yes |
| macOS | Keychain, ACL bound to the **code signature** | **no, while unsigned** |

An ad-hoc signature differs from build to build, so on macOS every update
presents a keychain item the running binary does not own. macOS answers that
with an authorisation prompt — and `LSUIElement` means there is no window for it
to attach to at boot, while `decryptString` is synchronous. Main blocks inside
it, before the overlay, the tray or the hotkey exist.

That is what 0.1.3 did: a live process, no window, no menu bar icon, no way in
and no way out but Force Quit. `src/main/store.js` now records which build wrote
the key and refuses to hand a foreign one to the OS, so the worst case is being
asked for the key again. Covered by `src/main/store.keyowner.test.js`.

**This goes away with a stable Developer ID signature**, and the rule can be
relaxed then.

---

## ASAR integrity — why the Electron version is not a free choice

electron-builder writes an `ElectronAsarIntegrity` hash into Info.plist and
Electron validates it at startup. Get that pairing wrong and the app **exits
inside dyld before a line of JavaScript runs**: no window, no log, no crash
report, no stdout. Nothing to debug from.

That is what 0.1.3 did with Electron 29.4.6 and electron-builder 26.15.3. The
hash was *correct* — recomputing SHA-256 over the asar header matched Info.plist
exactly — and the app still refused to boot, because the two tools disagreed on
what to hash. Deleting the key made the same bundle start instantly.

Fixed by moving to a current Electron rather than by disabling the check.
**Keep Electron and electron-builder roughly contemporary**, and run
`npm run verify:mac` on the artifact before publishing — it launches the built
bundle and fails if it cannot get far enough to write one line of its own log.
It is the only check in the repo that runs the packaged app; every other layer
runs against the repo, where all of this looks fine.

---

## Still untested on macOS

Honest gaps, not oversights:

- **Retina.** The test machine drives a 1920×1080 panel at `scaleFactor: 1`.
  `src/main/geometry.js` works in normalised 0–1000 coordinates and
  `src/main/capture.js` requests native pixels specifically so 2x displays
  behave — none of which has been confirmed on an actual 2x display.
- **Multi-monitor**, especially mixed scale factors.
- **The arrow landing on a real control from a real question.** The renderer is
  covered by smoke (`7-arrow.png`) but no live run has produced one, because the
  model returned no `target` on the questions tried.
- **Process-name masking.**
- **Intel (x64).** Built, never run — the same "built but never opened" state
  that produced everything above.

---

## The macOS distribution problem

Upstream ships **no macOS build at all** — its README tells macOS users to run
from source, because an unsigned build is blocked by Gatekeeper as "damaged."
That is the problem Handrail has to solve to be credible as a product.

### Options, worst to best

| Option | User experience | Cost |
|---|---|---|
| Run from source | Clone, install Node, run a script. Technical users only. | Free |
| **Genuinely unsigned `.dmg`** | **"Handrail is damaged and can't be opened", offering only Move to Trash.** No Open, right-click → Open shows the same dialog, and no "Open Anyway" row ever appears — that row is only offered for the unverified-developer verdict. The only way in is `xattr -cr` in Terminal. **This is what 0.1.3 shipped.** | Free |
| **Ad-hoc signed `.dmg`** ← current | "Apple could not verify..." → Done, then Privacy & Security → Open Anyway. Two clicks, once. Verified 2026-08-09. | Free |
| Signed only (Developer ID) | Fewer warnings but still flagged on first open. | $99/yr |
| **Signed + notarized + stapled** | **Double-click, it opens. No warnings.** | $99/yr |

The first two rows look like the same thing and are not. "Unsigned" and
"malformed" are different verdicts to Gatekeeper, and only one of them has a
route through the UI. A valid ad-hoc signature costs nothing and no Apple
account — `scripts/afterpack-mac.js` applies it, and fails the build if the
result does not verify, because a broken bundle that builds cleanly is exactly
how 0.1.3 got published.

**For a product aimed at non-technical users, only the last option is viable.**
Every other path requires the user to do something a non-technical person
cannot reasonably be asked to do — which contradicts the entire product thesis.

### What signed + notarized actually requires

1. Active Apple Developer Program membership — **status unconfirmed.** This file
   said "already held"; `CONTEXT.md` said enrolment was "deferred until funds
   allow". Both cannot be true, and which one is decides whether notarisation is
   a day of work or a purchase. Resolve before planning it.
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
