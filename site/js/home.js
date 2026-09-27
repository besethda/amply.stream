// The homepage hero's waveform: the listening app's "boxes" look, drawn in
// Amply orange behind the phone. Nothing is playing, so the levels are made
// up: a slow swell across the width with a beat running through it. Still
// (one frame) for anyone who asks for less motion, and paused off screen.

const canvas = document.querySelector(".hero-wave");
const video = document.querySelector(".phone video");
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (still && video) { video.removeAttribute("autoplay"); video.pause(); }

if (canvas) {
  const g = canvas.getContext("2d");
  const CELL = 16;          // css px per column, box and gap
  const FILL = 0.74;        // of each cell, the box
  const ROWS = 7;           // boxes a column can light above the line
  const REFLECT = 3;        // and below it, fainter
  const BPM = 112;
  const ORANGE = { h: 23, s: 0.92 };
  let cols = 0, cell = 0, dpr = 1, colours = [], seeds = [];

  const rgb = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return `${f(0)},${f(8)},${f(4)}`;
  };

  // Up each column, from a deep shade at the line to a pale top; across, the
  // hue leans one way at the bass end and the other at the treble. As the app.
  const size = () => {
    dpr = Math.min(2, devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    cols = Math.max(12, Math.round(w / CELL));
    cell = canvas.width / cols;
    colours = Array.from({ length: cols }, (_, c) => {
      const across = (c / (cols - 1) - 0.5) * 28;
      return Array.from({ length: ROWS }, (_, r) => {
        const up = r / (ROWS - 1);
        return rgb(ORANGE.h - 20 + 50 * up + across, ORANGE.s * (1 - 0.3 * up), 0.34 + 0.54 * Math.pow(up, 1.1));
      });
    });
    seeds = Array.from({ length: cols }, (_, c) => Math.sin(c * 12.9898) * 43758.5453 % 1);
  };

  const level = (c, t) => {
    const x = c / (cols - 1);
    const beat = (t * BPM) / 60, ph = beat % 1;
    const kick = Math.exp(-ph * 5) * Math.exp(-((x - 0.2) ** 2) / 0.02);           // the bass end jumps on the beat
    const snare = (Math.floor(beat) % 2) * Math.exp(-ph * 7) * Math.exp(-((x - 0.55) ** 2) / 0.03);
    const swell = 0.35 + 0.25 * Math.sin(t * 0.7 + x * 5) + 0.15 * Math.sin(t * 1.9 - x * 11 + seeds[c] * 6);
    const shape = 0.55 + 0.45 * Math.sin(Math.PI * x);                               // lower at both ends
    return Math.max(0.06, Math.min(1, (swell + kick * 0.6 + snare * 0.45) * shape));
  };

  const draw = (now) => {
    const t = now / 1000, w = canvas.width, h = canvas.height, mid = h * 0.62;
    const box = cell * FILL, gap = cell - box, r = Math.min(3 * dpr, box / 3);
    g.clearRect(0, 0, w, h);
    for (let c = 0; c < cols; c++) {
      const lit = level(c, t) * ROWS, x = c * cell + gap / 2;
      for (let k = 0; k < ROWS; k++) {
        const a = Math.min(1, lit - k);
        if (a <= 0.02) break;
        const at = [[mid - (k + 1) * cell + gap / 2, a]];
        if (k < REFLECT) at.push([mid + gap / 2 + k * cell, a * 0.35 * (1 - k / REFLECT / 1.5)]);
        for (const [y, alpha] of at) {
          g.fillStyle = `rgba(${colours[c][k]},${alpha})`;
          g.beginPath(); g.roundRect ? g.roundRect(x, y, box, box, r) : g.rect(x, y, box, box); g.fill();
        }
      }
    }
  };

  let raf = 0, seen = true;
  const loop = (now) => { draw(now); raf = seen ? requestAnimationFrame(loop) : 0; };
  size();
  if (still) draw(4200);
  else {
    new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      if (seen && !raf) raf = requestAnimationFrame(loop);
    }).observe(canvas);
    raf = requestAnimationFrame(loop);
  }
  addEventListener("resize", () => { size(); if (still) draw(4200); });
}
