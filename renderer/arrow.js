/**
 * Handrail — the pointer.
 *
 * Draws one marker on a transparent pane covering a whole display. Geometry
 * arrives already converted to display-local DIP by the main process, which is
 * also CSS pixels inside a window positioned at the display's origin — see
 * spike/arrow/geometry.js for why that makes DPI a non-issue.
 *
 * Rules enforced here, from design/tokens.css and design/screens-v1.html § 04:
 *   - the mint stroke is never drawn without its dark casing
 *   - the tip stops short of the control, so it never covers what it points at
 *   - the arrow approaches from whichever side has room
 *   - one arrow at a time
 */

'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const stage = document.getElementById('stage');

const css = getComputedStyle(document.documentElement);
const num = (name, fallback) => {
  const raw = parseFloat(css.getPropertyValue(name));
  return Number.isFinite(raw) ? raw : fallback;
};

const ARROW_LENGTH = num('--arrow-length', 150);
const TIP_GAP = num('--arrow-tip-gap', 14);
const HEAD = num('--arrow-head-length', 17);
const SPREAD = num('--arrow-head-spread', 0.42);
const RING_INSET = num('--ring-inset', -3);
const RING_RADIUS = num('--ring-radius', 7);

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Which side to approach from.
 *
 * Whichever has the most room — otherwise the tail runs off the display, or
 * the label lands on top of the very control it is describing.
 */
function chooseApproach(r, w, h) {
  const space = {
    left: r.left,
    right: w - (r.left + r.width),
    top: r.top,
    bottom: h - (r.top + r.height),
  };
  return Object.keys(space).reduce((a, b) => (space[b] > space[a] ? b : a));
}

function geometry(r, approach) {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  switch (approach) {
    case 'left':
      return { tip: [r.left - TIP_GAP, cy], tail: [r.left - TIP_GAP - ARROW_LENGTH, cy], bow: [0, -34] };
    case 'right':
      return { tip: [r.left + r.width + TIP_GAP, cy], tail: [r.left + r.width + TIP_GAP + ARROW_LENGTH, cy], bow: [0, -34] };
    case 'top':
      return { tip: [cx, r.top - TIP_GAP], tail: [cx, r.top - TIP_GAP - ARROW_LENGTH], bow: [34, 0] };
    default:
      return { tip: [cx, r.top + r.height + TIP_GAP], tail: [cx, r.top + r.height + TIP_GAP + ARROW_LENGTH], bow: [34, 0] };
  }
}

function escapeText(node, value) {
  node.textContent = String(value == null ? '' : value);
}

function draw(payload) {
  stage.replaceChildren();
  if (!payload || !payload.local) return;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const r = payload.local;

  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  svg.style.cssText = 'position:absolute;inset:0';
  stage.append(svg);

  // --- ring ---
  const ringAttrs = {
    x: r.left + RING_INSET,
    y: r.top + RING_INSET,
    width: r.width - RING_INSET * 2,
    height: r.height - RING_INSET * 2,
    rx: RING_RADIUS,
  };
  svg.append(el('rect', { ...ringAttrs, class: 'ring-casing' }));
  svg.append(el('rect', { ...ringAttrs, class: 'ring-stroke' }));
  svg.append(el('rect', { ...ringAttrs, class: 'ring-pulse' }));

  // --- arrow ---
  const approach = chooseApproach(r, w, h);
  const { tip, tail, bow } = geometry(r, approach);
  const ctrl = [(tip[0] + tail[0]) / 2 + bow[0], (tip[1] + tail[1]) / 2 + bow[1]];

  const shaft = `M ${tail[0]} ${tail[1]} Q ${ctrl[0]} ${ctrl[1]} ${tip[0]} ${tip[1]}`;
  const angle = Math.atan2(tip[1] - ctrl[1], tip[0] - ctrl[0]);
  const head =
    `M ${tip[0] - HEAD * Math.cos(angle - SPREAD)} ${tip[1] - HEAD * Math.sin(angle - SPREAD)} ` +
    `L ${tip[0]} ${tip[1]} ` +
    `L ${tip[0] - HEAD * Math.cos(angle + SPREAD)} ${tip[1] - HEAD * Math.sin(angle + SPREAD)}`;

  // Casing first, both paths, then the stroke on top. Drawing them interleaved
  // lets the casing of the head cut across the shaft's bright stroke.
  for (const cls of ['arrow-casing', 'arrow-stroke']) {
    svg.append(el('path', { class: cls, d: shaft }));
    svg.append(el('path', { class: cls, d: head }));
  }

  // --- label ---
  if (payload.instruction || payload.label) {
    const label = document.createElement('div');
    label.className = 'label';

    const text = document.createElement('p');
    escapeText(text, payload.instruction || payload.label);
    label.append(text);

    if (payload.instruction && payload.label) {
      const sub = document.createElement('span');
      escapeText(sub, payload.label);
      label.append(sub);
    }

    stage.append(label);

    // Measure, then place, so the chip never hangs off the display edge.
    const box = label.getBoundingClientRect();
    let x = tail[0];
    let y = tail[1];

    if (approach === 'left')        { x -= box.width;      y -= box.height / 2; }
    else if (approach === 'right')  {                      y -= box.height / 2; }
    else if (approach === 'top')    { x -= box.width / 2;  y -= box.height + 6; }
    else                            { x -= box.width / 2;  y += 6; }

    label.style.left = `${Math.max(12, Math.min(w - box.width - 12, x))}px`;
    label.style.top = `${Math.max(12, Math.min(h - box.height - 12, y))}px`;
  }
}

window.handrailArrow.onDraw(draw);
