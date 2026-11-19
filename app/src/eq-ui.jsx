/**
 * The equaliser, as the listener sees it: the curve they hear, a handle on
 * each band to drag, and presets for the usual shapes.
 */
import { useRef, useState } from "preact/hooks";
import { BANDS, RANGE, PRESETS, responseAt, presetOf, clampGain } from "./eq.js";

const W = 600, H = 200, TOP = 14, BOTTOM = 14;
const F_MIN = 30, F_MAX = 18000;
const xOf = (f) => (Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN)) * W;
const yOf = (db) => TOP + ((RANGE - db) / (2 * RANGE)) * (H - TOP - BOTTOM);
const dbAtY = (y) => RANGE - ((y - TOP) / (H - TOP - BOTTOM)) * 2 * RANGE;
const label = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(1)}k` : String(f));

export function Equalizer({ eq }) {
  const [s, setS] = useState(eq.get);
  const [drag, setDrag] = useState(null);       // band index while dragging
  const svg = useRef(null);
  const set = (patch) => setS(eq.set(patch));
  const gains = s.gains;

  const setBand = (i, db) => {
    const next = gains.slice();
    next[i] = clampGain(db);
    set({ gains: next, preset: presetOf(next), on: true });
  };
  const yFromEvent = (e) => {
    const r = svg.current.getBoundingClientRect();
    return ((e.clientY - r.top) / r.height) * H;
  };
  // The nearest band to where the pointer went down, by frequency.
  const bandAt = (e) => {
    const r = svg.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    BANDS.forEach((f, i) => { if (Math.abs(xOf(f) - x) < Math.abs(xOf(BANDS[best]) - x)) best = i; });
    return best;
  };

  // The curve: what all seven filters do together, across the range.
  const pts = [];
  for (let k = 0; k <= 120; k++) {
    const f = F_MIN * Math.pow(F_MAX / F_MIN, k / 120);
    pts.push([xOf(f), yOf(Math.max(-RANGE - 2, Math.min(RANGE + 2, responseAt(f, gains))))]);
  }
  const line = pts.map(([x, y], k) => `${k ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${W},${yOf(0)}L0,${yOf(0)}Z`;

  return (
    <section class={`eq${s.on ? " on" : ""}`}>
      <div class="eq-head">
        <b>Equalizer</b>
        <button role="switch" aria-checked={s.on} class={`switch${s.on ? " on" : ""}`} onClick={() => set({ on: !s.on })} aria-label="Equalizer">
          <i />
        </button>
      </div>

      <div class="eq-graph">
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="eq-svg"
          onPointerDown={(e) => {
            const i = bandAt(e);
            svg.current.setPointerCapture?.(e.pointerId);
            setDrag(i); setBand(i, dbAtY(yFromEvent(e)));
          }}
          onPointerMove={(e) => { if (drag != null) setBand(drag, dbAtY(yFromEvent(e))); }}
          onPointerUp={() => setDrag(null)} onPointerCancel={() => setDrag(null)}>
          <defs>
            <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--orange)" stop-opacity=".38" />
              <stop offset=".5" stop-color="var(--orange)" stop-opacity=".06" />
              <stop offset="1" stop-color="var(--orange)" stop-opacity=".38" />
            </linearGradient>
          </defs>
          {[-RANGE, -RANGE / 2, 0, RANGE / 2, RANGE].map((db) => (
            <line key={db} x1="0" x2={W} y1={yOf(db)} y2={yOf(db)} class={db === 0 ? "eq-zero" : "eq-grid"} />
          ))}
          {BANDS.map((f) => <line key={f} x1={xOf(f)} x2={xOf(f)} y1={TOP} y2={H - BOTTOM} class="eq-grid v" />)}
          <path d={area} class="eq-area" fill="url(#eq-fill)" />
          <path d={line} class="eq-line" />
        </svg>
        {/* Handles as HTML over the graph, so they stay round however it stretches. */}
        {BANDS.map((f, i) => (
          <span key={f} class={`eq-knob${drag === i ? " held" : ""}`} role="slider" tabIndex={0}
            aria-label={`${label(f)} Hz`} aria-valuemin={-RANGE} aria-valuemax={RANGE} aria-valuenow={gains[i]}
            aria-valuetext={`${gains[i] > 0 ? "+" : ""}${gains[i]} dB`}
            style={`left:${(xOf(f) / W) * 100}%;top:${(yOf(gains[i]) / H) * 100}%`}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 3 : 0.5;
              if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); setBand(i, gains[i] + step); }
              if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); setBand(i, gains[i] - step); }
              if (e.key === "0" || e.key === "Delete" || e.key === "Backspace") setBand(i, 0);
            }}>
            {drag === i && <em>{gains[i] > 0 ? "+" : ""}{gains[i]}</em>}
          </span>
        ))}
        <span class="eq-db top" aria-hidden="true">+{RANGE}</span>
        <span class="eq-db zero" aria-hidden="true">0</span>
        <span class="eq-db bottom" aria-hidden="true">−{RANGE}</span>
      </div>
      <div class="eq-freqs" aria-hidden="true">
        {BANDS.map((f) => <span key={f} style={`left:${(xOf(f) / W) * 100}%`}>{label(f)}</span>)}
      </div>

      <div class="eq-presets" role="radiogroup" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.id} role="radio" aria-checked={s.on && s.preset === p.id}
            class={`eq-preset${s.on && s.preset === p.id ? " on" : ""}`}
            onClick={() => set({ gains: p.gains, preset: p.id, on: true })}>
            <PresetShape gains={p.gains} />{p.name}
          </button>
        ))}
        {s.preset === "custom" && <span class="eq-preset on custom" role="radio" aria-checked="true"><PresetShape gains={gains} />Custom</span>}
      </div>
    </section>
  );
}

/** A preset's shape, tiny, beside its name. */
function PresetShape({ gains }) {
  const w = 24, h = 14;
  const d = gains.map((g, i) => `${i ? "L" : "M"}${((i / (gains.length - 1)) * w).toFixed(1)},${(h / 2 - Math.max(-1, Math.min(1, g / 6)) * (h / 2 - 1.5)).toFixed(1)}`).join("");
  return <svg class="eq-mini" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><path d={d} /></svg>;
}

/** Light or dark, as two small pictures of the app. */
export function Appearance({ themeName, onTheme }) {
  return (
    <div class="look-pick" role="radiogroup" aria-label="Appearance">
      {["dark", "light"].map((t) => (
        <button key={t} role="radio" aria-checked={themeName === t} class={`look${themeName === t ? " on" : ""}`}
          onClick={() => themeName !== t && onTheme()}>
          <span class={`look-pic ${t}`} aria-hidden="true">
            <i class="lp-side" /><i class="lp-a" /><i class="lp-b" /><i class="lp-c" /><i class="lp-bar" />
          </span>
          <span class="look-name"><span class="look-dot" />{t === "dark" ? "Dark" : "Light"}</span>
        </button>
      ))}
    </div>
  );
}
