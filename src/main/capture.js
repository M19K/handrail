/*
 * Copyright 2026 Maaz Kazi
 * SPDX-License-Identifier: Apache-2.0
 *
 * Original work, part of Handrail. See NOTICE.
 */
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
 * Long edge for the ANSWER capture.
 *
 * The answer pass does not need native resolution — it needs to know what
 * application is open and what state it is in. Locating a control for the arrow
 * DOES need native detail, and that is a separate capture at `full`.
 *
 * This is most of the latency fix. A native 1920x1080 PNG is about 1MB; the
 * same frame at 1600px as JPEG is roughly a tenth of that, and on a 2x display
 * the saving is four times larger again because native there is 3840 wide.
 */
const ANSWER_LONG_EDGE = 1600;

/** JPEG quality for the two lossy tiers. High enough to read UI text. */
const JPEG_QUALITY = 72;

/**
 * Paint `rects` black in a raw BGRA bitmap, in place.
 *
 * WHY THIS EXISTS, instead of the content-protection toggle it replaces:
 *
 * Handrail used to hide itself from its own screenshot by turning macOS content
 * protection ON immediately before each capture and OFF immediately after. That
 * works, but content protection is also what removes a window from a SCREEN
 * SHARE — so on a Google Meet call, with stealth deliberately switched off, the
 * overlay blinked out and back on every single question. Maaz saw it flickering
 * for a colleague while his own screen looked perfectly static, which is
 * exactly the signature of this: content protection does not affect the local
 * display, only what other processes can capture.
 *
 * Masking the pixels is deterministic, costs about ten milliseconds, works the
 * same on both platforms, and never touches a window property that something
 * else is observing. The user's stealth setting is now the ONLY thing that
 * drives content protection, set once, never toggled.
 *
 * Pure and exported so the geometry can be tested without a screen.
 */
function maskRegions(bitmap, size, rects) {
  if (!bitmap || !size || !Array.isArray(rects) || !rects.length) return bitmap;
  const { width, height } = size;

  for (const r of rects) {
    if (!r) continue;
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(width, Math.ceil(r.x + r.width));
    const y1 = Math.min(height, Math.ceil(r.y + r.height));
    if (x1 <= x0 || y1 <= y0) continue;

    for (let y = y0; y < y1; y += 1) {
      // 4 bytes per pixel. Fill the row span in one call rather than per pixel.
      const start = (y * width + x0) * 4;
      bitmap.fill(0, start, start + (x1 - x0) * 4);
    }
  }
  return bitmap;
}

/**
 * A window's bounds expressed in the captured image's pixel space.
 *
 * Window bounds are DIP across the whole desktop; the image is one display at
 * whatever size we asked for. Both differences have to be removed, and the
 * scale is derived from the image rather than assumed from `scaleFactor`,
 * because the answer tier deliberately captures smaller than native.
 *
 * Returns null when the window does not overlap this display at all.
 */
function rectInImage(winBounds, display, imageSize) {
  if (!winBounds || !display || !imageSize) return null;
  const db = display.bounds;
  if (!db.width || !db.height) return null;

  const sx = imageSize.width / db.width;
  const sy = imageSize.height / db.height;

  const rect = {
    x: (winBounds.x - db.x) * sx,
    y: (winBounds.y - db.y) * sy,
    width: winBounds.width * sx,
    height: winBounds.height * sy,
  };

  if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return null;
  if (rect.x >= imageSize.width || rect.y >= imageSize.height) return null;
  return rect;
}

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
async function captureDisplay(display, quality = 'full', maskWindows = []) {
  const native = nativeSize(display);

  const longEdge = quality === 'check' ? CHECK_LONG_EDGE
    : quality === 'answer' ? ANSWER_LONG_EDGE
      : null;

  let requested = native;
  if (longEdge) {
    const scale = Math.min(1, longEdge / Math.max(native.width, native.height));
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

  let image = source.thumbnail;
  if (!image || image.isEmpty()) throw new Error('Screen capture returned an empty image');

  const size = image.getSize();

  // Blank out Handrail's own windows rather than hiding them with content
  // protection — see maskRegions() for why that toggle had to go.
  const rects = (maskWindows || [])
    .map((bounds) => rectInImage(bounds, display, size))
    .filter(Boolean);
  if (rects.length) {
    const { nativeImage } = require('electron');
    const masked = maskRegions(image.toBitmap(), size, rects);
    image = nativeImage.createFromBitmap(masked, size);
  }

  // PNG only where the detail is load-bearing. The arrow's locate pass reads
  // small controls out of this and JPEG ringing around thin UI text is exactly
  // the wrong trade there; the answer pass has no such need.
  const buffer = quality === 'full' ? image.toPNG() : image.toJPEG(JPEG_QUALITY);

  return { buffer, size, display, matched, mimeType: quality === 'full' ? 'image/png' : 'image/jpeg' };
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

module.exports = {
  maskRegions,
  rectInImage, captureDisplay, displayForWindow, captureMatchesDisplay, nativeSize, selectSource };
