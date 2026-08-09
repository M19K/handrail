/**
 * Handrail — the pointer.
 *
 * Draws one arrow. The window it lives in is sized to just the arrow and its
 * label, not the whole display, and every coordinate arrives already relative
 * to that window — see src/main/geometry.js § arrowLayout.
 *
 * Two things this deliberately does NOT do, both from real use:
 *
 *   - It does not ring or outline the control. A marker drawn on top of the
 *     thing you are being asked to click competes with it, clutters the screen,
 *     and adds nothing the arrow has not already said.
 *   - It does not animate. A pulsing stroke on an always-on-top layer forces
 *     the compositor to recomposite continuously, and on integrated graphics
 *     that is enough to make the whole machine feel like it is dragging.
 *
 * Rules that remain, from design/screens-v1.html § 04:
 *   - the mint stroke is never drawn without its dark casing
 *   - the tip stops short of the control, so it never covers what it points at
 *   - one arrow at a time
 */

'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const stage = document.getElementById('stage');

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function draw(payload) {
  stage.replaceChildren();
  if (!payload || !payload.layout) return;

  const { tip, tail, ctrl, head, spread, approach } = payload.layout;
  const w = window.innerWidth;
  const h = window.innerHeight;

  const svg = el('svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  svg.style.cssText = 'position:absolute;inset:0';
  stage.append(svg);

  const shaft = `M ${tail[0]} ${tail[1]} Q ${ctrl[0]} ${ctrl[1]} ${tip[0]} ${tip[1]}`;

  // Head angled along the incoming tangent (control point -> tip), so it stays
  // aligned with the curve however the arrow approaches.
  const angle = Math.atan2(tip[1] - ctrl[1], tip[0] - ctrl[0]);
  const headPath =
    `M ${tip[0] - head * Math.cos(angle - spread)} ${tip[1] - head * Math.sin(angle - spread)} ` +
    `L ${tip[0]} ${tip[1]} ` +
    `L ${tip[0] - head * Math.cos(angle + spread)} ${tip[1] - head * Math.sin(angle + spread)}`;

  // Casing for both paths first, then both strokes. Interleaving them would let
  // the head's casing cut a dark notch across the shaft's bright stroke.
  for (const cls of ['arrow-casing', 'arrow-stroke']) {
    svg.append(el('path', { class: cls, d: shaft }));
    svg.append(el('path', { class: cls, d: headPath }));
  }

  if (!payload.instruction && !payload.label) return;

  const label = document.createElement('div');
  label.className = 'label';

  const text = document.createElement('p');
  text.textContent = String(payload.instruction || payload.label || '');
  label.append(text);

  if (payload.instruction && payload.label) {
    const sub = document.createElement('span');
    sub.textContent = String(payload.label);
    label.append(sub);
  }

  stage.append(label);

  // Measure, then place. The window was sized against a generous reservation
  // for the label, so this only has to position within space already allowed.
  const box = label.getBoundingClientRect();
  let x = tail[0];
  let y = tail[1];

  if (approach === 'left')        { x -= box.width;      y -= box.height / 2; }
  else if (approach === 'right')  {                      y -= box.height / 2; }
  else if (approach === 'top')    { x -= box.width / 2;  y -= box.height + 6; }
  else                            { x -= box.width / 2;  y += 6; }

  label.style.left = `${Math.max(4, Math.min(w - box.width - 4, x))}px`;
  label.style.top = `${Math.max(4, Math.min(h - box.height - 4, y))}px`;
}

window.handrailArrow.onDraw(draw);
