/**
 * Handrail — screen capture.
 *
 * Replaces `src/services/capture.service.js`, which had two defects the arrow
 * spike exposed and which are fixed here:
 *
 *  1. It matched a capture source to a display by comparing thumbnail SIZES.
 *     Two monitors with the same aspect ratio defeat that completely and it
 *     silently captures the wrong screen. Matching is on `display_id` now.
 *  2. It requested `display.size`, which is DIP. On a 2x panel that captures at
 *     half resolution and throws away exactly the detail a vision model needs
 *     to resolve a small toolbar button. It asks for native pixels now.
 *
 * Two capture qualities exist on purpose. Locating a control for an arrow needs
 * native resolution; checking whether a step is finished does not, and a
 * downscaled frame is what makes step-watching affordable. See PRODUCT.md
 * § Step completion.
 */

const { desktopCapturer, screen } = require('electron');

/** Long edge, in pixels, for the cheap completion-check capture. */
const CHECK_LONG_EDGE = 1024;

/**
 * Which display an overlay window is on.
 *
 * The window's CENTRE is the test. Using its top-left hands back the wrong
 * display whenever the overlay straddles a boundary, which it will, because
 * users park it near screen edges.
 */
function displayForWindow(win) {
  if (!win || win.isDestroyed()) return screen.getPrimaryDisplay();
  const b = win.getBounds();
  return screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  });
}

function nativeSize(display) {
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
}

/**
 * Pick the capture source for a display, and say HOW it was picked.
 *
 * Pure, and exported, so the matching rules can be tested without Electron —
 * this is the code that decides which monitor the model is shown, and it had no
 * test at all.
 *
 * `matched` is the important part:
 *   'display_id' — certain. The compositor named the display.
 *   'size'       — a guess. Two monitors of the same aspect ratio defeat it.
 *   'fallback'   — not a match at all. Just the first source there was.
 *
 * The caller has to be able to tell those apart. The ask path checks the
 * aspect ratio and disables pointing on a mismatch, but the watch tick used to
 * check nothing — so with an empty `display_id` every step check for a task on
 * the second monitor silently judged the primary screen instead.
 */
function selectSource(sources, display, requested) {
  const wanted = String(display.id);
  const byId = sources.find((s) => String(s.display_id) === wanted);
  if (byId) return { source: byId, matched: 'display_id' };

  // Kept because `display_id` is empty on some Linux compositors, but this is
  // the behaviour that used to be the bug.
  const bySize = sources.find((s) => {
    const size = s.thumbnail.getSize();
    return size.width === requested.width && size.height === requested.height;
  });
  if (bySize) return { source: bySize, matched: 'size' };

  return { source: sources[0], matched: 'fallback' };
}

/**
 * Capture one display.
 *
 * `quality: 'full'` for locating controls, `'check'` for completion checks.
 * Returns { buffer, size, display, matched } — `size` is the actual captured
 * pixel size, which the caller needs because desktopCapturer may clamp what it
 * was asked for, and `matched` is how confident the display match was.
 */
async function captureDisplay(display, quality = 'full') {
  const native = nativeSize(display);

  let requested = native;
  if (quality === 'check') {
    const scale = Math.min(1, CHECK_LONG_EDGE / Math.max(native.width, native.height));
    requested = {
      width: Math.round(native.width * scale),
      height: Math.round(native.height * scale),
    };
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: requested,
  });
  if (!sources.length) throw new Error('No screen sources available');

  const { source, matched } = selectSource(sources, display, requested);

  const image = source.thumbnail;
  if (!image || image.isEmpty()) throw new Error('Screen capture returned an empty image');

  return { buffer: image.toPNG(), size: image.getSize(), display, matched };
}

/**
 * Does the captured image actually represent this display?
 *
 * An aspect-ratio mismatch is the cheap, reliable tell that we captured the
 * wrong screen. It matters because every arrow coordinate is a fraction of the
 * display's bounds — if the image is not that display, every arrow is silently
 * wrong rather than obviously broken.
 */
function captureMatchesDisplay(size, display) {
  if (!size || !size.width || !size.height) return false;
  const imageAspect = size.width / size.height;
  const displayAspect = display.bounds.width / display.bounds.height;
  return Math.abs(imageAspect - displayAspect) / displayAspect <= 0.01;
}

module.exports = { captureDisplay, displayForWindow, captureMatchesDisplay, nativeSize, selectSource };
