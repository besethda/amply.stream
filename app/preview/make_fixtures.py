#!/usr/bin/env python3
"""Generate mock artist fixtures: manifests, art, audio (m4a). Waves are made by make_waves.mjs."""
import json, math, os, subprocess, sys, wave, hashlib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
SR = 32000
PAY = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

# kind: arch (sun/arches), blobs, waves, rings, grid
CATALOG = [
 dict(host="hollowcoast.example", name="Hollow Coast",
  bio="Recorded in a converted lifeboat station on the Norfolk coast. Everything here is original and self-released. Slow guitars, tape hiss and the sea leaking in through the walls.",
  avatar=("#c8663a", "#1c1410", "rings"), banner=("#d9763f", "#14100d", "waves"), paid=True,
  links=[("Bandcamp","https://hollowcoast.bandcamp.com"),("Instagram","https://instagram.com/hollowcoast")],
  releases=[
   dict(id="longwave", title="Longwave", date="2026-10-24", accent="#e0652c", deep="#2a1a12", kind="waves", tracks=[
     ("signal-fade","Signal Fade",46,0,"Am"),("north-sea-static","North Sea Static",52,1,"Dm"),("lifeboat-station","Lifeboat Station",40,2,"Am"),
     ("low-tide-radio","Low Tide Radio",58,3,"Em"),("salt-and-copper","Salt and Copper",44,4,"Dm"),("longwave","Longwave",50,5,"Am")]),
   dict(id="tideline-ep", title="Tideline EP", date="2025-08-14", accent="#3f8fb5", deep="#0f2230", kind="arch", tracks=[
     ("tideline","Tideline",48,6,"Em"),("grey-water","Grey Water",42,7,"Am"),("harbour-lights","Harbour Lights",54,8,"Dm"),("driftwood","Driftwood",36,9,"Em")]),
   dict(id="foghorn", title="Foghorn", date="2026-06-02", accent="#b9a37a", deep="#26211a", kind="rings", single=True, tracks=[
     ("foghorn","Foghorn",56,10,"Cm")]),
  ]),
 dict(host="mira-vale.example", name="Mira Vale",
  bio="Bedroom pop from Leeds. Synths, soft drum machines and diary entries set to a four-on-the-floor.",
  avatar=("#f06fa6", "#2a0f24", "blobs"), banner=("#ff8ab8", "#35123a", "blobs"), paid=False,
  links=[("Instagram","https://instagram.com/miravale")],
  releases=[
   dict(id="neon-diary", title="Neon Diary", date="2026-11-07", accent="#ff4f9a", deep="#2c0b25", kind="blobs", tracks=[
     ("pink-hour","Pink Hour",44,11,"C"),("night-bus","Night Bus",50,12,"Am"),("group-chat","Group Chat",38,13,"G"),
     ("static-heart","Static Heart",54,14,"Em"),("2am-in-leeds","2am in Leeds",48,15,"F"),("glitter-and-rain","Glitter and Rain",42,16,"C"),
     ("sunday-reset","Sunday Reset",46,17,"Am"),("dial-tone","Dial Tone",40,18,"G")]),
   dict(id="soft-focus-ep", title="Soft Focus EP", date="2025-04-18", accent="#9d7bff", deep="#1a1233", kind="arch", tracks=[
     ("soft-focus","Soft Focus",45,19,"F"),("lavender-haze-ish","Lavender Haze-ish",50,20,"Am"),("polaroid","Polaroid",40,21,"C")]),
   dict(id="saturday-single", title="Saturday", date="2026-09-12", accent="#ffc04a", deep="#33210a", kind="rings", single=True, tracks=[
     ("saturday","Saturday",41,22,"G")]),
  ]),
 dict(host="the-quiet-hours.example", name="The Quiet Hours",
  bio="Four-piece from Glasgow making unhurried, wintry songs for late evenings. Piano, brushed drums, a borrowed cello.",
  avatar=("#6aa7a0", "#0d1d1f", "arch"), banner=("#7fb8ae", "#0b1a1d", "arch"), paid=True,
  links=[("Website","https://thequiethours.example"),("Ko-fi","https://ko-fi.com/thequiethours")],
  releases=[
   dict(id="winter-rooms", title="Winter Rooms", date="2026-01-30", accent="#5fb3a8", deep="#0c2224", kind="arch", tracks=[
     ("candle-end","Candle End",58,23,"Dm"),("frost-on-the-glass","Frost on the Glass",52,24,"Am"),("the-long-stair","The Long Stair",46,25,"Em"),
     ("snowed-in","Snowed In",60,26,"Dm"),("hearth","Hearth",38,27,"Am")]),
   dict(id="paper-lanterns", title="Paper Lanterns", date="2024-11-22", accent="#e2a14b", deep="#2b1d0b", kind="blobs", tracks=[
     ("paper-lanterns","Paper Lanterns",50,28,"C"),("kettle-song","Kettle Song",42,29,"G"),("ferry-home","Ferry Home",54,30,"Em"),("small-hours","Small Hours",44,31,"Am")]),
  ]),
 dict(host="ostra.example", name="OSTRA",
  bio="Electronic producer. Club-shaped music for headphones: sub bass, broken drums, and the occasional melody.",
  avatar=("#8cf06a", "#0a1a0c", "grid"), banner=("#9cff7a", "#0b160c", "grid"), paid=False,
  links=[("SoundCloud","https://soundcloud.com/ostra-example")],
  releases=[
   dict(id="signal-path", title="Signal Path", date="2026-08-21", accent="#a3ff5c", deep="#0e1f0b", kind="grid", tracks=[
     ("input-gain","Input Gain",48,32,"Fm"),("patch-bay","Patch Bay",56,33,"Cm"),("sidechain","Sidechain",44,34,"Gm"),
     ("headroom","Headroom",52,35,"Fm"),("low-pass","Low Pass",40,36,"Cm"),("clip-light","Clip Light",50,37,"Dm")]),
   dict(id="afterimage", title="Afterimage", date="2025-10-03", accent="#ff5a3c", deep="#2a0e08", kind="waves", tracks=[
     ("afterimage","Afterimage",46,38,"Am"),("retina-burn","Retina Burn",42,39,"Em"),("ghost-frame","Ghost Frame",58,40,"Dm")]),
  ]),
]

def hexrgb(h): h=h.lstrip("#"); return np.array([int(h[i:i+2],16) for i in (0,2,4)], dtype=np.float32)
def seed_of(s): return int(hashlib.md5(s.encode()).hexdigest()[:8], 16)

# ── images ─────────────────────────────────────────────────────────────────
def make_image(w, h, accent, deep, kind, seed, title=None):
    rng = np.random.default_rng(seed)
    a, d = hexrgb(accent), hexrgb(deep)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ang = rng.uniform(0.3, 1.2)
    t = (xx/w*math.cos(ang) + yy/h*math.sin(ang)); t = (t - t.min())/(t.max()-t.min())
    t = t[..., None]
    img = d*(1-t) + (d*0.4 + a*0.6)*t
    base = Image.fromarray(np.clip(img,0,255).astype(np.uint8))
    m = min(w, h)
    layer = Image.new("RGB", (w, h), (0,0,0))
    dr = ImageDraw.Draw(layer)
    def lighten(c, k): return tuple(int(min(255, c_*(1-k)+255*k)) for c_ in c)
    A = tuple(int(x) for x in a); D = tuple(int(x) for x in d)
    if kind == "rings":
        cx, cy = w*rng.uniform(.35,.65), h*rng.uniform(.4,.6)
        for i in range(9):
            r = m*(0.09+0.07*i)
            col = tuple(int(x) for x in (a*(0.35+0.08*i) + d*(0.4-0.03*i)))
            dr.ellipse([cx-r,cy-r,cx+r,cy+r], outline=col, width=max(2,int(m*0.012)))
        dr.ellipse([cx-m*.08,cy-m*.08,cx+m*.08,cy+m*.08], fill=lighten(A,.35))
        layer = layer.filter(ImageFilter.GaussianBlur(m*0.004))
    elif kind == "blobs":
        for i in range(9):
            cx, cy = rng.uniform(0,w), rng.uniform(0,h); r = m*rng.uniform(.12,.36)
            mix = rng.uniform(0,1)
            col = tuple(int(x) for x in (a*mix + d*(1-mix)*0.6 + 255*0.12*rng.random()))
            dr.ellipse([cx-r,cy-r,cx+r,cy+r], fill=col)
        layer = layer.filter(ImageFilter.GaussianBlur(m*0.07))
    elif kind == "arch":
        sx, sy = w*rng.uniform(.4,.6), h*rng.uniform(.55,.7)
        r = m*0.28
        dr.ellipse([sx-r,sy-r,sx+r,sy+r], fill=lighten(A,.3))
        for i, hh in enumerate([0.55, 0.7, 0.85]):
            col = tuple(int(x) for x in (d*(0.6+0.3*i) + a*0.1*i))
            pts = [(0,h)]
            for x in range(0, w+20, 20):
                pts.append((x, h*hh + math.sin(x/w*(2.5+i)+rng.uniform(0,6))*m*0.05*(i+1)))
            pts.append((w,h)); dr.polygon(pts, fill=col)
        layer = layer.filter(ImageFilter.GaussianBlur(m*0.006))
    elif kind == "waves":
        n = 14
        for i in range(n):
            y0 = h*(0.1+0.8*i/n); k = i/n
            col = tuple(int(x) for x in (d*(1-k)+a*k))
            pts=[(0,h)]
            ph = rng.uniform(0,6)
            for x in range(0, w+8, 8):
                pts.append((x, y0 + math.sin(x/w*math.pi*(2+k*3)+ph)*m*0.05*(1+k)))
            pts.append((w,h)); dr.polygon(pts, fill=col)
        layer = layer.filter(ImageFilter.GaussianBlur(m*0.003))
    elif kind == "grid":
        n = 6; cell = m/n
        for gy in range(int(h/cell)+1):
            for gx in range(int(w/cell)+1):
                if rng.random() < 0.55:
                    k = rng.random()
                    col = tuple(int(x) for x in (d*(1-k)+a*k))
                    x0, y0 = gx*cell, gy*cell
                    if rng.random()<.5: dr.rectangle([x0+3,y0+3,x0+cell-3,y0+cell-3], fill=col)
                    else: dr.ellipse([x0+3,y0+3,x0+cell-3,y0+cell-3], fill=col)
        layer = layer.filter(ImageFilter.GaussianBlur(m*0.002))
    L = np.asarray(layer).astype(np.float32); B = np.asarray(base).astype(np.float32)
    mask = (L.sum(axis=2, keepdims=True) > 8).astype(np.float32)
    out = B*(1-mask*0.9) + L*(mask*0.9) + B*0*mask
    out = np.where(mask>0, L*0.9+B*0.1, B)
    # vignette + glow
    vx = (xx/w-.5)**2 + (yy/h-.5)**2
    out *= (1 - 0.55*vx[...,None])
    out += rng.normal(0, 7, (h, w, 1))  # grain
    out = np.clip(out, 0, 255).astype(np.uint8)
    return Image.fromarray(out)

# ── audio ──────────────────────────────────────────────────────────────────
NOTES = {"C":0,"Cm":0,"Dm":2,"D":2,"Em":4,"E":4,"F":5,"Fm":5,"G":7,"Gm":7,"A":9,"Am":9}
def midi(n): return 440.0*2**((n-69)/12)

def synth(seconds, key, seed, mood):
    rng = np.random.default_rng(seed)
    n = int(seconds*SR); t = np.arange(n)/SR
    minor = key.endswith("m")
    root = 48 + NOTES[key]
    scale = [0,2,3,5,7,8,10] if minor else [0,2,4,5,7,9,11]
    bpm = [68,76,84,92,104,118,124,128][seed%8] if mood!="slow" else 70
    beat = 60/bpm
    # progression degrees
    prog = [[0,2,4],[5,0,2],[3,5,0],[4,6,1]] if seed%2 else [[0,2,4],[3,5,0],[5,0,2],[4,6,1]]
    bar = beat*4
    def chord_freqs(deg, octv=0):
        return [midi(root+12*octv+scale[(deg+i) % 7]+ (12 if (deg+i)>=7 else 0)) for i in range(3)]
    # sections: intro (quiet) / verse / chorus / verse / chorus / outro, by fraction
    secs = [(0,.14,"intro"),(.14,.4,"verse"),(.4,.65,"chorus"),(.65,.8,"verse"),(.8,.95,"chorus"),(.95,1,"outro")]
    env = {k: np.zeros(n, np.float32) for k in ("pad","bass","kick","hat","lead")}
    lv = {"intro":dict(pad=.5,bass=0,kick=0,hat=0,lead=0),"verse":dict(pad=.6,bass=.7,kick=.7,hat=.25,lead=0),
          "chorus":dict(pad=.8,bass=1,kick=1,hat=.7,lead=.9),"outro":dict(pad=.4,bass=0,kick=0,hat=0,lead=0)}
    for a,b,name in secs:
        i0,i1 = int(a*n), int(b*n)
        for k in env: env[k][i0:i1] = lv[name][k]
    # smooth section changes
    def box(x, w):
        c = np.cumsum(np.pad(x, (w//2+1, w//2), mode="edge"), dtype=np.float64)
        return ((c[w:] - c[:-w]) / w)[:len(x)].astype(np.float32)
    for k in env: env[k] = box(box(env[k], int(SR*0.4)), int(SR*0.4))
    out = np.zeros(n, np.float32)
    nb = int(seconds/bar)+1
    for bi in range(nb):
        s0 = int(bi*bar*SR); s1 = min(n, int((bi+1)*bar*SR))
        if s0>=n: break
        deg = prog[bi%4]
        seg = t[s0:s1]-t[s0]
        L = len(seg)
        # pad: detuned saws-ish (sum of few harmonics) w/ slow swell
        pad = np.zeros(L, np.float32)
        for f in chord_freqs(deg[0]*0+deg[0]):
            for dt in (-0.004, 0.004):
                ff = f*(1+dt)
                pad += (np.sin(2*np.pi*ff*seg) + .35*np.sin(2*np.pi*2*ff*seg) + .15*np.sin(2*np.pi*3*ff*seg)).astype(np.float32)
        swell = np.minimum(1, seg/0.5) * np.minimum(1, (bar-seg)/0.4)
        out[s0:s1] += 0.045*pad*swell*env["pad"][s0:s1]
        # bass: root of chord each beat pair
        bf = midi(root-12+scale[deg[0]])
        for q in range(4):
            q0 = int(q*beat*SR); q1 = min(L, int((q+1)*beat*SR))
            if q0>=L: break
            tt = seg[q0:q1]-seg[q0]
            e = np.exp(-tt*3.5)
            b_ = np.sin(2*np.pi*bf*tt)+.3*np.sin(2*np.pi*2*bf*tt)
            out[s0+q0:s0+q1] += (0.28*b_*e).astype(np.float32)*env["bass"][s0+q0:s0+q1]
            # kick
            ke = np.exp(-tt*14); fk = 45+90*np.exp(-tt*28)
            ph = 2*np.pi*np.cumsum(fk)/SR
            out[s0+q0:s0+q1] += (0.55*np.sin(ph)*ke).astype(np.float32)*env["kick"][s0+q0:s0+q1]
            # hats on off-beats (8ths)
            h0 = q0+int(beat*SR/2); h1 = min(L, h0+int(0.06*SR))
            if h0<L and h1>h0:
                hn = rng.normal(0,1,h1-h0).astype(np.float32)
                hn = np.diff(hn, prepend=0)  # crude highpass
                he = np.exp(-np.arange(h1-h0)/SR*70)
                out[s0+h0:s0+h1] += 0.18*hn*he*env["hat"][s0+h0:s0+h1]
        # lead: arpeggio 8ths
        for q in range(8):
            q0 = int(q*beat*SR/2); q1 = min(L, int((q+1)*beat*SR/2))
            if q0>=L: break
            tt = seg[q0:q1]-seg[q0]
            d = deg[(q*3+bi)%3]
            lf = midi(root+12+scale[d%7])
            e = np.exp(-tt*6)
            l_ = np.sin(2*np.pi*lf*tt)+.4*np.sin(2*np.pi*2*lf*tt)+.2*np.sin(2*np.pi*3*lf*tt)
            out[s0+q0:s0+q1] += (0.10*l_*e).astype(np.float32)*env["lead"][s0+q0:s0+q1]
    # light delay for space
    dly = int(beat*0.75*SR); wet = np.zeros_like(out); wet[dly:] = out[:-dly]*0.28
    out += wet
    fade = np.minimum(1, np.minimum(t/0.3, (seconds-t)/1.5))
    out *= fade
    out /= max(1e-6, np.abs(out).max())/0.85
    return out

def write_wav(path, x):
    pcm = (np.clip(x,-1,1)*32767).astype("<i2")
    with wave.open(path,"wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

def probe_duration(path):
    r = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",path],capture_output=True,text=True)
    return float(r.stdout.strip())

def main():
    os.makedirs(OUT, exist_ok=True)
    for ar in CATALOG:
        host = ar["host"]; base = f"https://{host}"
        d = os.path.join(OUT, host); os.makedirs(os.path.join(d,"art"), exist_ok=True); os.makedirs(os.path.join(d,"audio"), exist_ok=True)
        s = seed_of(host)
        a, dp, k = ar["avatar"]; make_image(400,400,a,dp,k,s+1).save(os.path.join(d,"art","avatar.jpg"), quality=88)
        a, dp, k = ar["banner"]; make_image(1600,600,a,dp,k,s+2).save(os.path.join(d,"art","banner.jpg"), quality=86)
        releases = []
        for r in ar["releases"]:
            cp = os.path.join(d,"art",f"{r['id']}.jpg")
            make_image(600,600,r["accent"],r["deep"],r["kind"],seed_of(r["id"])).save(cp, quality=88)
            tracks = []
            for (tid,title,secs,sd,key) in r["tracks"]:
                if tid in [x["id"] for x in ar["releases"]]: tid += "-track"   # ids are unique across a manifest
                m4a = os.path.join(d,"audio",f"{tid}.m4a")
                if not os.path.exists(m4a):
                    wavp = m4a + ".tmp.wav"
                    write_wav(wavp, synth(secs, key, sd, "std"))
                    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",wavp,"-c:a","aac","-b:a","96k",m4a],check=True)
                    os.remove(wavp)
                dur = max(1, round(probe_duration(m4a)))
                tr = dict(id=tid, title=title, duration=dur, url=f"{base}/audio/{tid}.m4a", waves=f"{base}/audio/{tid}.waves")
                tracks.append(tr)
            rel = dict(id=r["id"], title=r["title"], date=r["date"], art=f"{base}/art/{r['id']}.jpg",
                       colors=dict(accent=r["accent"], deep=r["deep"]), tracks=tracks)
            releases.append(rel)
        # paid artists: make the last track of the first release and the whole last release paid; the rest free
        if ar["paid"]:
            for ri, rel in enumerate(releases):
                for ti, tr in enumerate(rel["tracks"]):
                    paid = (ri == len(releases)-1 and len(releases)>1 and ar["host"]=="hollowcoast.example") or (ri==0 and ti==len(rel["tracks"])-1)
                    if not paid: tr["free"] = True
        manifest = dict(amply=1, updated="2026-11-10T12:00:00Z",
            artist=dict(name=ar["name"], bio=ar["bio"], image=f"{base}/art/avatar.jpg", banner=f"{base}/art/banner.jpg",
                        links=[dict(label=l,url=u) for l,u in ar["links"]]),
            content=dict(explicit=False), licence=dict(type="amply-personal-1"), releases=releases)
        if ar["paid"]:
            manifest["payment"] = [dict(type="solana-usdc", address=PAY, ratePerMinute=0.005, settleAt=1.0)]
        with open(os.path.join(d,"manifest.json"),"w") as f: json.dump(manifest, f, indent=2)
        print("done", host, file=sys.stderr)

main()
