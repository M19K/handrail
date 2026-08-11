/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
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
/**
 * Rescale a 0–1 box into the 0–1000 space.
 *
 * The prompt says "not 0-1 floats" and models return them anyway. This is the
 * one rescale that can be done without guessing: a genuine 0–1000 box whose
 * four edges are all ≤ 1 would be a single pixel in the top-left corner, which
 * is never a real control. Percentages are deliberately NOT handled — 0–100 is
 * indistinguishable from a real box in the top tenth of the screen, and a wrong
 * arrow is worse than no arrow.
 */
function rescaleUnitBox(box) {
  const edges = [box.ymin, box.xmin, box.ymax, box.xmax];
  if (!edges.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) return box;
  if (edges.every((v) => v === 0)) return box;
  return {
    ymin: box.ymin * NORM_MAX,
    xmin: box.xmin * NORM_MAX,
    ymax: box.ymax * NORM_MAX,
    xmax: box.xmax * NORM_MAX,
  };
}

function parseBox(raw) {
  if (!raw) return null;

  // {left, top, right, bottom} and {x0, y0, x1, y1} — two shapes that other
  // model families return in place of the requested array. Handled here rather
  // than in the prompt because widening the parser costs nothing and cannot
  // regress, whereas adding another line to the prompt competes for the
  // model's attention with everything else already in it.
  const named = raw && Number.isFinite(raw.left) && Number.isFinite(raw.top)
    && Number.isFinite(raw.right) && Number.isFinite(raw.bottom)
    ? [raw.top, raw.left, raw.bottom, raw.right]
    : raw && Number.isFinite(raw.x0) && Number.isFinite(raw.y0)
      && Number.isFinite(raw.x1) && Number.isFinite(raw.y1)
      ? [raw.y0, raw.x0, raw.y1, raw.x1]
      : null;
  if (named) {
    const [ymin, xmin, ymax, xmax] = named;
    return rescaleUnitBox({
      ymin: Math.min(ymin, ymax),
      xmin: Math.min(xmin, xmax),
      ymax: Math.max(ymin, ymax),
      xmax: Math.max(xmin, xmax),
    });
  }

  // [ymin, xmin, ymax, xmax] — the requested form.
  const arr = Array.isArray(raw)
    ? raw
    : raw.box_2d || raw.bbox || raw.box || raw.rect || raw.bounds;
  if (Array.isArray(arr) && arr.length === 4 && arr.every(Number.isFinite)) {
    const [ymin, xmin, ymax, xmax] = arr;
    return rescaleUnitBox({
      ymin: Math.min(ymin, ymax),
      xmin: Math.min(xmin, xmax),
      ymax: Math.max(ymin, ymax),
      xmax: Math.max(xmin, xmax),
    });
  }

  // {x, y, width, height} — top-left plus extent.
  if (
    raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) &&
    Number.isFinite(raw.width) && Number.isFinite(raw.height)
  ) {
    return rescaleUnitBox({
      ymin: raw.y,
      xmin: raw.x,
      ymax: raw.y + raw.height,
      xmax: raw.x + raw.width,
    });
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
 * Arrow drawing constants. Here rather than in CSS because the WINDOW has to be
 * sized around the result, and only the main process can do that.
 */
const ARROW = {
  length: 150,   // tail-to-tip
  tipGap: 14,    // never touch the control being pointed at
  bow: 34,       // perpendicular offset of the curve's control point
  head: 17,
  spread: 0.42,  // radians, half-angle of the head
};

/** Space reserved for the instruction chip at the tail. Generous on purpose. */
const LABEL = { width: 340, height: 104 };

/** Breathing room so strokes and shadows are not clipped by the window edge. */
const REGION_PAD = 24;

/**
 * Work out the arrow's shape AND the smallest window that can contain it.
 *
 * The window size is the point of this function. The arrow used to be drawn on
 * a transparent pane covering the entire display, which means the compositor
 * blends a full-screen layer on every frame — on integrated graphics that is
 * enough to make the whole machine feel like it is dragging, which is exactly
 * what happened. Covering ~400x300 instead of 2880x1800 is roughly a 40x
 * reduction in blended area.
 *
 * All inputs and outputs are display-local DIP. `region` is where to put the
 * window; `tip`, `tail` and `ctrl` are already relative to that region, so the
 * renderer draws in its own coordinate space and knows nothing about displays.
 */
function arrowLayout(target, displaySize) {
  const approach = chooseApproach(target, displaySize);
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;

  let tip;
  let tail;
  let bow;

  switch (approach) {
    case 'left':
      tip = [target.left - ARROW.tipGap, cy];
      tail = [tip[0] - ARROW.length, cy];
      bow = [0, -ARROW.bow];
      break;
    case 'right':
      tip = [target.left + target.width + ARROW.tipGap, cy];
      tail = [tip[0] + ARROW.length, cy];
      bow = [0, -ARROW.bow];
      break;
    case 'top':
      tip = [cx, target.top - ARROW.tipGap];
      tail = [cx, tip[1] - ARROW.length];
      bow = [ARROW.bow, 0];
      break;
    default:
      tip = [cx, target.top + target.height + ARROW.tipGap];
      tail = [cx, tip[1] + ARROW.length];
      bow = [ARROW.bow, 0];
      break;
  }

  const ctrl = [(tip[0] + tail[0]) / 2 + bow[0], (tip[1] + tail[1]) / 2 + bow[1]];

  // The label hangs off the tail, on the far side from the target.
  const label = labelBox(tail, approach);

  // Union of everything that gets drawn. The target itself is deliberately NOT
  // included — nothing is drawn on it any more, and including it would inflate
  // the window back toward full-screen for a control near a display edge.
  const xs = [tip[0], tail[0], ctrl[0], label.left, label.left + label.width];
  const ys = [tip[1], tail[1], ctrl[1], label.top, label.top + label.height];

  let left = Math.min(...xs) - REGION_PAD;
  let top = Math.min(...ys) - REGION_PAD;
  let right = Math.max(...xs) + REGION_PAD;
  let bottom = Math.max(...ys) + REGION_PAD;

  // Clamp to the display. A window placed partly off-screen gets moved back by
  // the OS, which would silently shift every coordinate inside it.
  left = Math.max(0, Math.floor(left));
  top = Math.max(0, Math.floor(top));
  right = Math.min(displaySize.width, Math.ceil(right));
  bottom = Math.min(displaySize.height, Math.ceil(bottom));

  const region = { x: left, y: top, width: right - left, height: bottom - top };

  return {
    approach,
    region,
    tip: [tip[0] - left, tip[1] - top],
    tail: [tail[0] - left, tail[1] - top],
    ctrl: [ctrl[0] - left, ctrl[1] - top],
    head: ARROW.head,
    spread: ARROW.spread,
  };
}

/**
 * Which side to approach from — whichever has the most room.
 *
 * Otherwise the tail runs off the display, or the label lands on top of the
 * very control it is describing.
 */
function chooseApproach(target, displaySize) {
  const space = {
    left: target.left,
    right: displaySize.width - (target.left + target.width),
    top: target.top,
    bottom: displaySize.height - (target.top + target.height),
  };
  return Object.keys(space).reduce((a, b) => (space[b] > space[a] ? b : a));
}

/** Where the instruction chip sits relative to the tail, before clamping. */
function labelBox(tail, approach) {
  switch (approach) {
    case 'left':
      return { left: tail[0] - LABEL.width, top: tail[1] - LABEL.height / 2, ...LABEL };
    case 'right':
      return { left: tail[0], top: tail[1] - LABEL.height / 2, ...LABEL };
    case 'top':
      return { left: tail[0] - LABEL.width / 2, top: tail[1] - LABEL.height, ...LABEL };
    default:
      return { left: tail[0] - LABEL.width / 2, top: tail[1], ...LABEL };
  }
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
  ARROW,
  LABEL,
  arrowLayout,
  chooseApproach,
  ASPECT_TOLERANCE,
  parseBox,
  isBoxSane,
  assertCaptureMatchesDisplay,
  boxToScreenRect,
  displayForWindowBounds,
  nativeCaptureSize,
};
