/**
 * Arrow spike — coordinate geometry.
 *
 * The whole point of this module is that it is PURE. No Electron, no network.
 * It takes a normalised bounding box from the vision model plus a plain display
 * descriptor and returns where to draw. That makes the riskiest part of the
 * spike — the coordinate chain — testable without a screen or an API key.
 *
 * THE COORDINATE CHAIN, and why scaleFactor never appears in it
 * -------------------------------------------------------------
 * The model is asked for boxes normalised to 0..1000 (Gemini's native
 * `box_2d` convention: [ymin, xmin, ymax, xmax]). Normalised coordinates are
 * resolution-independent by definition — they describe a fraction of the image,
 * whatever that image's pixel dimensions happened to be.
 *
 * So we never need to know:
 *   - the physical pixel size of the capture
 *   - the display's DPI scale factor
 *   - whether the capture got downscaled on the way to the model
 *
 * We only need the display's DIP bounds, because Electron positions windows in
 * DIP and CSS pixels inside a window are DIP too. One multiply, done:
 *
 *     screenX_dip = display.bounds.x + (xNorm / 1000) * display.bounds.width
 *
 * The one assumption this rests on is that the captured image covers exactly
 * the display and nothing else — same aspect ratio, no letterboxing, no crop.
 * `assertCaptureMatchesDisplay()` below checks that explicitly rather than
 * trusting it, because if it is ever false every arrow is silently wrong.
 */

const NORM_MAX = 1000;

/**
 * Aspect-ratio tolerance between the captured image and the display it claims
 * to represent. 1% absorbs odd resolutions that do not divide evenly (e.g. a
 * 1366x768 panel) without letting a genuinely letterboxed capture through.
 */
const ASPECT_TOLERANCE = 0.01;

/**
 * Normalise whatever shape the model returned into [ymin, xmin, ymax, xmax].
 *
 * The prompt asks for `box_2d`, but models drift — they return `bbox`, or an
 * {x,y,width,height} object, or a bare point when they cannot find an extent.
 * Accepting the common variants here is cheaper than fighting the model, and
 * the spike is trying to measure coordinate ACCURACY, not format compliance.
 *
 * Returns null if the input cannot be read as a box.
 */
function parseBox(raw) {
  if (!raw) return null;

  // [ymin, xmin, ymax, xmax] — the requested form.
  const arr = Array.isArray(raw) ? raw : raw.box_2d || raw.bbox || raw.box;
  if (Array.isArray(arr) && arr.length === 4 && arr.every(Number.isFinite)) {
    const [ymin, xmin, ymax, xmax] = arr;
    return {
      ymin: Math.min(ymin, ymax),
      xmin: Math.min(xmin, xmax),
      ymax: Math.max(ymin, ymax),
      xmax: Math.max(xmin, xmax),
    };
  }

  // {x, y, width, height} — top-left plus extent.
  if (
    raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) &&
    Number.isFinite(raw.width) && Number.isFinite(raw.height)
  ) {
    return {
      ymin: raw.y,
      xmin: raw.x,
      ymax: raw.y + raw.height,
      xmax: raw.x + raw.width,
    };
  }

  // A bare point — give it a small nominal extent so downstream code has a box.
  const px = Number.isFinite(raw.x) ? raw.x : raw.cx;
  const py = Number.isFinite(raw.y) ? raw.y : raw.cy;
  if (Number.isFinite(px) && Number.isFinite(py)) {
    return { ymin: py, xmin: px, ymax: py, xmax: px };
  }

  return null;
}

/** True if every edge sits inside the normalised space, with the box non-inverted. */
function isBoxSane(box) {
  if (!box) return false;
  const edges = [box.ymin, box.xmin, box.ymax, box.xmax];
  if (!edges.every(Number.isFinite)) return false;
  if (edges.some(v => v < 0 || v > NORM_MAX)) return false;
  return box.xmax >= box.xmin && box.ymax >= box.ymin;
}

/**
 * Verify the capture actually represents the whole display.
 *
 * Electron's desktopCapturer clamps `thumbnailSize`, and on a multi-monitor
 * setup the source-to-display match is a heuristic (see capture.service.js).
 * Either can hand back an image that is not the display we think it is. An
 * aspect-ratio mismatch is the cheap, reliable tell.
 *
 * Returns { ok, reason?, imageAspect?, displayAspect? } — never throws, because
 * the caller may want to draw anyway and flag it rather than abort.
 */
function assertCaptureMatchesDisplay(imageSize, displayBounds) {
  if (!imageSize || !imageSize.width || !imageSize.height) {
    return { ok: false, reason: 'capture has no dimensions' };
  }
  if (!displayBounds || !displayBounds.width || !displayBounds.height) {
    return { ok: false, reason: 'display has no bounds' };
  }

  const imageAspect = imageSize.width / imageSize.height;
  const displayAspect = displayBounds.width / displayBounds.height;
  const drift = Math.abs(imageAspect - displayAspect) / displayAspect;

  if (drift > ASPECT_TOLERANCE) {
    return {
      ok: false,
      reason:
        `capture aspect ${imageAspect.toFixed(4)} does not match display aspect ` +
        `${displayAspect.toFixed(4)} (${(drift * 100).toFixed(1)}% drift) — the ` +
        `captured image is probably not this display`,
      imageAspect,
      displayAspect,
    };
  }

  return { ok: true, imageAspect, displayAspect };
}

/**
 * Normalised box -> absolute screen geometry, in DIP.
 *
 * `display` needs only `.bounds` ({x, y, width, height} in DIP) — exactly what
 * Electron's `screen.getAllDisplays()` gives. `scaleFactor` is deliberately
 * unused; see the header.
 *
 * Returns both:
 *   - `screen`  — absolute virtual-desktop coordinates, for hit-testing and logs
 *   - `local`   — coordinates relative to the display origin, which is what an
 *                 overlay window positioned at `display.bounds` uses as CSS px
 */
function boxToScreenRect(box, display) {
  const b = display.bounds;
  const sx = b.width / NORM_MAX;
  const sy = b.height / NORM_MAX;

  const localLeft = box.xmin * sx;
  const localTop = box.ymin * sy;
  const width = (box.xmax - box.xmin) * sx;
  const height = (box.ymax - box.ymin) * sy;

  return {
    screen: {
      left: b.x + localLeft,
      top: b.y + localTop,
      width,
      height,
      centerX: b.x + localLeft + width / 2,
      centerY: b.y + localTop + height / 2,
    },
    local: {
      left: localLeft,
      top: localTop,
      width,
      height,
      centerX: localLeft + width / 2,
      centerY: localTop + height / 2,
    },
  };
}

/**
 * Pick the display an overlay window currently sits on.
 *
 * PRODUCT.md: capture happens on "whichever monitor the overlay is on". The
 * overlay's centre point is the right test — using its top-left would hand the
 * wrong display back whenever the window straddles a boundary.
 *
 * Pure, so it takes the display list rather than calling `screen` itself.
 */
function displayForWindowBounds(winBounds, displays) {
  if (!displays || displays.length === 0) return null;
  if (!winBounds) return displays[0];

  const cx = winBounds.x + winBounds.width / 2;
  const cy = winBounds.y + winBounds.height / 2;

  const containing = displays.find(d => {
    const b = d.bounds;
    return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
  });
  if (containing) return containing;

  // Centre is in dead space between or outside monitors — fall back to nearest
  // by centre-to-centre distance so we always return something usable.
  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const dx = d.bounds.x + d.bounds.width / 2 - cx;
    const dy = d.bounds.y + d.bounds.height / 2 - cy;
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

/**
 * Full-resolution capture size for a display.
 *
 * `display.size` is DIP. On a 150%-scaled 1080p panel that is 1280x720, and
 * capturing at that size throws away a third of the linear detail — which is
 * exactly the detail a vision model needs to resolve a small toolbar button.
 * Multiplying back up by scaleFactor asks desktopCapturer for native pixels.
 *
 * This is the ONE place scaleFactor legitimately matters: capture fidelity,
 * not coordinate math.
 */
function nativeCaptureSize(display) {
  const scale = display.scaleFactor || 1;
  return {
    width: Math.round(display.size.width * scale),
    height: Math.round(display.size.height * scale),
  };
}

module.exports = {
  NORM_MAX,
  ASPECT_TOLERANCE,
  parseBox,
  isBoxSane,
  assertCaptureMatchesDisplay,
  boxToScreenRect,
  displayForWindowBounds,
  nativeCaptureSize,
};
