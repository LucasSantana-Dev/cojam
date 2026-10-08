// The modo palco pixel world, drawn with three.js at native resolution
// (orthographic camera, one world pixel = one canvas pixel) and upscaled by an
// integer factor in CSS with image-rendering: pixelated. Every position is
// rounded to whole pixels; sprites never rotate or move by sub-pixels.
//
// Ported from the owner-approved prototype (palco-handoff/prototype.html). The
// layout rules (worlds, framing, slots) live in lib/palco.ts; this file only
// draws. It is loaded client-side only, through the dynamic PalcoView chunk, so
// three.js never reaches the round 4 room bundle.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type MeshBasicMaterialParameters,
} from 'three';
import { SIDE_EXT, SPLIT, SPRITE_H, SPRITE_W, type Framing, type Slot, type WorldDef } from '@/lib/palco';
import { beatAt } from '@/lib/beatClock';
import { serverNow } from '@/lib/playbackSync';
import { CHARACTER_COUNT } from '@/lib/characters';

const SKY_H = 540;
const UP_W = 28; // arms-up frame: 28x58, 4 px wider each side, 10 rows of arms on top
const UP_EXTRA = 10;
const INK = '#0d0a17';

export interface SceneImages {
  stage: HTMLImageElement;
  front: Record<number, HTMLImageElement>;
  back: Record<number, HTMLImageElement>;
  up: Record<number, HTMLImageElement>;
}

const pad = (id: number) => String(id).padStart(2, '0');

function load(src: string): Promise<HTMLImageElement | null> {
  return new Promise((ok) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => ok(null);
    i.src = src;
  });
}

export async function loadSceneImages(world: WorldDef): Promise<SceneImages> {
  const stage = await load(world.src);
  if (!stage) throw new Error('palco: stage art failed to load');
  const out: SceneImages = { stage, front: {}, back: {}, up: {} };
  const ids = Array.from({ length: CHARACTER_COUNT }, (_, i) => i + 1);
  await Promise.all(
    ids.flatMap((id) => [
      load(`/palco/characters/${pad(id)}-front.png`).then((i) => { if (i) out.front[id] = i; }),
      load(`/palco/characters/${pad(id)}-back.png`).then((i) => { if (i) out.back[id] = i; }),
      load(`/palco/characters/${pad(id)}-up.png`).then((i) => { if (i) out.up[id] = i; }),
    ]),
  );
  return out;
}

export interface CrowdEntry {
  key: string;
  characterId: number;
  slot: Slot;
}

export interface BoothEntry {
  key: string;
  characterId: number;
}

export interface Anchor {
  // Stage-area CSS px: centre of the sprite and the top of the head.
  x: number;
  y: number;
  visible: boolean;
}

export interface FrameOut {
  people: Map<string, Anchor>;
  booths: [Anchor & { key: string | null }, Anchor & { key: string | null }];
}

// --- helpers -----------------------------------------------------------------

function texFrom(source: HTMLCanvasElement | HTMLImageElement): Texture {
  const t = source instanceof HTMLCanvasElement ? new CanvasTexture(source) : new Texture(source);
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function crop(img: CanvasImageSource, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h);
  return c;
}

type Sized = Mesh<PlaneGeometry, Material> & { userData: { size: [number, number] } };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const BAYER_GLSL = `float bayer(vec2 p){ int x=int(mod(p.x,4.)); int y=int(mod(p.y,4.)); int i=x+y*4;
  float m[16]; m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
  for(int k=0;k<16;k++){ if(k==i) return (m[k]+0.5)/16.; } return 0.; }`;
const BEAM_LOOK: Array<[[number, number, number], number, number]> = [
  [[0.55, 0.38, 1.0], 0.7, 0], [[0.85, 0.8, 1.0], 0.9, 1.7], [[0.85, 0.8, 1.0], 0.9, 3.1],
  [[0.55, 0.38, 1.0], 0.7, 4.4], [[0.95, 0.45, 0.85], 1.4, 0.4], [[0.95, 0.45, 0.85], 1.4, 2.2],
];
const FAR = [[0x2b, 0x20, 0x50], [0x9a, 0x82, 0xea]];
const NEAR = [[0x15, 0x0f, 0x29], [0x56, 0x42, 0x9a]];
const HAIR = ['round', 'afro', 'bun', 'cap', 'long', 'short'] as const;
const mix = (a: number[], b: number[], t: number) => '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface CharTex {
  backUp: Texture;
  backLegs: Texture;
  armsUp: Texture | null;
  armsLegs: Texture | null;
  front: Texture | null;
}

interface Person {
  key: string;
  characterId: number;
  slot: Slot;
  legs: Sized;
  up: Sized;
  legsA: Sized | null;
  upA: Sized | null;
  here: number;
  hereFrom: number;
  side: number;
  wootAt: number;
  wootH: number;
  style: number;
  phase: number;
}

interface Booth {
  def: WorldDef['booths'][number];
  mesh: Sized;
  who: BoothEntry | null;
  next: BoothEntry | null;
  rise: number;
  // Sink/rise animation: 'sink' until rise reaches 0, then swap and 'rise'.
  // Time based (not per frame), so a throttled tab still lands on time.
  mode: 'idle' | 'sink' | 'rise';
  t0: number;
  from: number;
  waveC?: HTMLCanvasElement;
  waveTex?: Texture;
  wave?: Sized;
}

interface RowPerson {
  x: number;
  hr: number;
  hair: (typeof HAIR)[number];
  sw: number;
  style: number;
  phase: number;
  arms: number;
  phone: boolean;
  lift: number;
}

interface Row {
  feet: number;
  h: number;
  body: string;
  rim: string;
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: Texture;
  mesh: Sized;
  people: RowPerson[];
}

// --- the scene ------------------------------------------------------------------

export class PalcoScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, 1, 0, -1, -100, 100);
  private readonly world: WorldDef;
  private readonly imgs: SceneImages;
  private framing: Framing | null = null;
  private motion = true;
  private raf = 0;
  private running = false;
  private seed = 7;
  private readonly t0 = performance.now();
  private readonly charTex = new Map<number, CharTex>();
  private readonly people = new Map<string, Person>();
  private readonly booths: Booth[] = [];
  private rows: Row[] = [];
  private lastHalf = -1;
  private lastSky = -1;
  private energy = 0;
  private lastBurst = -100;
  private readonly hearts: Array<{ m: Sized; x: number; y0: number; born: number }> = [];
  private readonly conf: Array<{ x: number; y: number; vx: number; vy: number; ph: number }> = [];
  private readonly confPos: Float32Array;
  private readonly confGeo = new BufferGeometry();
  private readonly skyC: HTMLCanvasElement;
  private readonly skyTex: Texture;
  private readonly topRow: Uint8ClampedArray;
  private readonly bands: number[][] = [[6, 5, 14], [9, 7, 20], [13, 9, 28], [17, 11, 36], [21, 13, 44]];
  private readonly stars: Array<{ x: number; y: number; b: number; big: boolean; p: number }>;
  private readonly waveC: HTMLCanvasElement;
  private readonly waveTex: Texture;
  private readonly wavePanels: Sized[] = [];
  private readonly beamMat: ShaderMaterial;
  private readonly beams: Array<{ a: number; s: number; sp: number; ph: number }>;
  private readonly lamps: Sized[] = [];
  private readonly heartTex: Texture;
  private readonly ground: Sized;
  private lastT = 0;
  private onFrame: ((out: FrameOut) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, world: WorldDef, imgs: SceneImages) {
    this.world = world;
    this.imgs = imgs;
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.scene.background = new Color(INK);
    const W = world.W;

    // Sky: dithered bands into the stage's own top row, stars and a moon.
    const SW = W + 2 * SIDE_EXT;
    this.skyC = document.createElement('canvas');
    this.skyC.width = SW;
    this.skyC.height = SKY_H;
    this.topRow = crop(imgs.stage, 0, 0, W, 1).getContext('2d')!.getImageData(0, 0, W, 1).data;
    let r = 0, g = 0, b = 0;
    for (let x = 0; x < W; x++) { r += this.topRow[x * 4]; g += this.topRow[x * 4 + 1]; b += this.topRow[x * 4 + 2]; }
    this.bands[this.bands.length - 1] = [Math.round(r / W), Math.round(g / W), Math.round(b / W)];
    this.stars = Array.from({ length: 120 }, () => ({ x: Math.floor(this.rnd() * SW), y: Math.floor(this.rnd() * (SKY_H - 30)), b: this.rnd(), big: this.rnd() < 0.08, p: this.rnd() * 6 }));
    this.drawSky(0);
    this.skyTex = texFrom(this.skyC);
    this.put(this.plane(this.skyTex, SW, SKY_H, 0), -SIDE_EXT, -SKY_H);

    // Stage plate, its edge columns carried past the sides, and the ground under it.
    this.put(this.plane(texFrom(imgs.stage), W, world.H, 1), 0, 0);
    this.put(this.plane(texFrom(crop(imgs.stage, 0, 0, 1, world.H)), SIDE_EXT, world.H, 1), -SIDE_EXT, 0);
    this.put(this.plane(texFrom(crop(imgs.stage, W - 1, 0, 1, world.H)), SIDE_EXT, world.H, 1), W, 0);
    const groundH = 700;
    const gC = document.createElement('canvas');
    gC.width = 4;
    gC.height = groundH;
    const gx = gC.getContext('2d')!;
    for (let y = 0; y < groundH; y++) { gx.fillStyle = y < 20 ? '#0f0e1d' : '#0b0a16'; gx.fillRect(0, y, 4, 1); }
    this.ground = this.plane(texFrom(gC), SW, groundH, 1);
    this.put(this.ground, -SIDE_EXT, world.H);

    // Booths: the DJ sprite sits behind a copy of the booth front (or a desk).
    for (const def of world.booths) {
      const booth: Booth = { def, mesh: this.plane(null, SPRITE_W, SPRITE_H, 4), who: null, next: null, rise: 0, mode: 'idle', t0: 0, from: 0 };
      booth.mesh.visible = false;
      if (def.desk) {
        const DW = 28, DH = 16;
        const x0 = def.x - 4, y0 = def.top + 28;
        const c = crop(imgs.stage, x0, y0, DW, 70);
        const dg = c.getContext('2d')!;
        dg.fillStyle = '#120c24'; dg.fillRect(0, 0, DW, DH);
        dg.fillStyle = '#2a1c50'; dg.fillRect(1, 1, DW - 2, DH - 2);
        dg.fillStyle = '#9a82ea'; dg.fillRect(0, 0, DW, 1);
        dg.fillStyle = '#4b3690'; dg.fillRect(3, 2, 6, 2); dg.fillRect(DW - 9, 2, 6, 2);
        dg.fillStyle = '#d9cffb'; dg.fillRect(5, 2, 2, 1); dg.fillRect(DW - 7, 2, 2, 1);
        this.put(this.plane(texFrom(c), DW, 70, 4.5), x0, y0);
        booth.waveC = document.createElement('canvas');
        booth.waveC.width = DW - 6;
        booth.waveC.height = 9;
        booth.waveTex = texFrom(booth.waveC);
        booth.wave = this.plane(booth.waveTex, DW - 6, 9, 4.6);
        this.put(booth.wave, x0 + 3, y0 + 5);
      } else if (def.cover) {
        const [cx, cy, cw, chh] = def.cover;
        this.put(this.plane(texFrom(crop(imgs.stage, cx, cy, cw, chh)), cw, chh, 4.5), cx, cy);
      }
      this.booths.push(booth);
    }

    // Sine-wave screens on the speaker stacks.
    this.waveC = document.createElement('canvas');
    this.waveC.width = 54;
    this.waveC.height = 21;
    this.waveTex = texFrom(this.waveC);
    for (const [x, y] of world.waves) {
      const m = this.plane(this.waveTex, 54, 21, 4.6);
      this.put(m, x, y);
      this.wavePanels.push(m);
    }

    // Light beams: Bayer-dithered cones in additive blending.
    this.beams = world.beams.map(([, , a, sp], i) => ({ a, s: sp, sp: BEAM_LOOK[i][1], ph: BEAM_LOOK[i][2] }));
    this.beamMat = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        origin: { value: world.beams.map(([x, y]) => new Vector2(x, y)) },
        ang: { value: world.beams.map((b) => b[2]) },
        spread: { value: world.beams.map((b) => b[3]) },
        len: { value: world.beams.map((b) => b[4]) },
        col: { value: world.beams.map((_, i) => new Vector3(...BEAM_LOOK[i][0])) },
        inten: { value: world.beams.map(() => 0) },
      },
      vertexShader: 'varying vec2 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = vec2(w.x, -w.y); gl_Position = projectionMatrix*viewMatrix*w; }',
      fragmentShader: `varying vec2 vW; uniform vec2 origin[6]; uniform float ang[6]; uniform float spread[6]; uniform float len[6]; uniform vec3 col[6]; uniform float inten[6]; ${BAYER_GLSL}
  void main(){ vec2 p = floor(vW)+0.5; vec3 acc = vec3(0.); float th = bayer(gl_FragCoord.xy);
    for(int i=0;i<6;i++){ vec2 d = p-origin[i]; float l = length(d); if(l<1.) continue;
      float a = atan(d.x, -d.y); float diff = abs(a-ang[i]);
      float k = (1.-smoothstep(spread[i]*0.35, spread[i], diff)) * (1.-clamp(l/len[i],0.,1.)) * inten[i];
      float q = floor(k*3.+th)/3.; acc += col[i]*q*0.42; }
    if(acc.r+acc.g+acc.b < 0.01) discard; gl_FragColor = vec4(acc,1.); }`,
    });
    const beamMesh = new Mesh(new PlaneGeometry(SW, 420), this.beamMat) as unknown as Sized;
    beamMesh.userData.size = [SW, 420];
    beamMesh.renderOrder = 30;
    this.scene.add(beamMesh);
    this.put(beamMesh, -SIDE_EXT, -170);

    // Lamp glows on the truss.
    const glowC = document.createElement('canvas');
    glowC.width = 9;
    glowC.height = 9;
    const gctx = glowC.getContext('2d')!;
    ([[4, '#3c2a78'], [3, '#7c5ad6'], [2, '#c9b8ff'], [1, '#ffffff']] as const).forEach(([rr, c]) => {
      gctx.fillStyle = c;
      for (let y = -rr; y <= rr; y++) for (let x = -rr; x <= rr; x++) if (x * x + y * y <= rr * rr + 1) gctx.fillRect(4 + x, 4 + y, 1, 1);
    });
    const glowTex = texFrom(glowC);
    for (const [x, y] of world.lamps) {
      const m = this.plane(glowTex, 9, 9, 3.5, { blending: AdditiveBlending });
      this.put(m, x, y);
      this.lamps.push(m);
    }

    // Hearts and confetti.
    const heartC = document.createElement('canvas');
    heartC.width = 7;
    heartC.height = 6;
    const hctx = heartC.getContext('2d')!;
    ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'].forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '#') { hctx.fillStyle = x === 1 && y === 1 ? '#ffd0e2' : '#ff5c9a'; hctx.fillRect(x, y, 1, 1); }
    }));
    this.heartTex = texFrom(heartC);
    const CONF = 70;
    this.confPos = new Float32Array(CONF * 3);
    const confCol = new Float32Array(CONF * 3);
    const colors = [[0.49, 0.3, 1.0], [0.84, 0.78, 1.0], [1.0, 0.36, 0.6], [1, 1, 1], [0.95, 0.75, 0.3]];
    for (let i = 0; i < CONF; i++) {
      confCol.set(colors[i % colors.length], i * 3);
      this.conf.push({ x: 0, y: -999, vx: 0, vy: 0, ph: this.rnd() * 6 });
      this.confPos[i * 3 + 1] = 9999;
    }
    this.confGeo.setAttribute('position', new BufferAttribute(this.confPos, 3));
    this.confGeo.setAttribute('color', new BufferAttribute(confCol, 3));
    const confMesh = new Points(this.confGeo, new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }));
    confMesh.renderOrder = 120;
    confMesh.frustumCulled = false;
    this.scene.add(confMesh);
  }

  // --- public API ---------------------------------------------------------------

  resize(f: Framing): void {
    this.framing = f;
    this.renderer.setSize(f.w, f.h, false);
    const canvas = this.renderer.domElement;
    canvas.style.width = `${f.w * f.scale}px`;
    canvas.style.height = `${f.h * f.scale}px`;
    canvas.style.left = `${f.ox}px`;
    this.camera.left = 0;
    this.camera.right = f.w;
    this.camera.top = 0;
    this.camera.bottom = -f.h;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(f.camLeft, -f.camTop, 10);
    this.buildRows(f.crowdBottom);
    this.lastHalf = -1;
  }

  setMotion(on: boolean): void {
    this.motion = on;
    if (!on) {
      for (const p of this.people.values()) p.here = 1;
      this.conf.forEach((c) => { c.y = -999; });
      this.hearts.splice(0).forEach((h) => this.drop(h.m));
    }
    this.lastHalf = -1;
  }

  setCrowd(entries: CrowdEntry[]): void {
    const now = this.now();
    const keep = new Set(entries.map((e) => e.key));
    for (const [key, p] of this.people) {
      if (!keep.has(key)) {
        [p.legs, p.up, p.legsA, p.upA].forEach((m) => m && this.drop(m));
        this.people.delete(key);
      }
    }
    entries.forEach((e, i) => {
      let p = this.people.get(e.key);
      if (p && p.characterId !== e.characterId) {
        [p.legs, p.up, p.legsA, p.upA].forEach((m) => m && this.drop(m));
        this.people.delete(e.key);
        p = undefined;
      }
      const dim = e.slot.row === 1;
      if (!p) {
        const tex = this.chars(e.characterId);
        const z = (dim ? 8 : 9) + i * 0.01;
        const tint = dim ? 0x6a6194 : 0xffffff;
        const fresh: Person = {
          key: e.key,
          characterId: e.characterId,
          slot: e.slot,
          legs: this.plane(tex.backLegs, SPRITE_W, SPRITE_H - SPLIT, z, { color: tint }),
          up: this.plane(tex.backUp, SPRITE_W, SPLIT, z + 0.005, { color: tint }),
          legsA: tex.armsLegs ? this.plane(tex.armsLegs, UP_W, SPRITE_H - SPLIT, z, { color: tint }) : null,
          upA: tex.armsUp ? this.plane(tex.armsUp, UP_W, SPLIT + UP_EXTRA, z + 0.005, { color: tint }) : null,
          here: this.motion ? 0 : 1,
          hereFrom: now,
          side: e.slot.x + SPRITE_W / 2 < this.world.W / 2 ? -1 : 1,
          wootAt: -10,
          wootH: 0,
          style: i % 3,
          phase: [0, 0.5, 0.25][i % 3],
        };
        this.people.set(e.key, fresh);
      } else if (p.slot.row !== e.slot.row) {
        const tint = new Color(e.slot.row === 1 ? 0x6a6194 : 0xffffff);
        [p.legs, p.up, p.legsA, p.upA].forEach((m) => { if (m) (m.material as MeshBasicMaterial).color = tint; });
        p.slot = e.slot;
      } else {
        p.slot = e.slot;
      }
    });
  }

  setBooths(left: BoothEntry | null, right: BoothEntry | null): void {
    [left, right].forEach((want, i) => {
      const b = this.booths[i];
      const same = (a: BoothEntry | null, c: BoothEntry | null) => (a?.key ?? null) === (c?.key ?? null) && (a?.characterId ?? 0) === (c?.characterId ?? 0);
      if (same(b.who, want) && b.mode !== 'sink') return;
      b.next = want;
      b.t0 = this.now();
      if (!this.motion || !b.who) {
        this.assignBooth(b, want);
        b.rise = this.motion && want ? 0 : 1;
        b.mode = this.motion && want ? 'rise' : 'idle';
        return;
      }
      b.from = b.rise;
      b.mode = 'sink';
    });
  }

  // The view positions its DOM overlays (tags, bubbles) from each frame's anchors.
  setFrameListener(cb: ((out: FrameOut) => void) | null): void {
    this.onFrame = cb;
  }

  woot(key: string): void {
    const p = this.people.get(key);
    this.energy = Math.min(1, this.energy + 0.07);
    if (!p) return;
    p.wootAt = this.now();
    p.wootH = p.slot.row === 1 ? 5 : 7;
    if (this.motion && p.here >= 1) this.spawnHeart(p);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.frame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as Material | Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    for (const t of this.charTex.values()) [t.backUp, t.backLegs, t.armsUp, t.armsLegs, t.front].forEach((x) => x?.dispose());
    this.rows.forEach((r) => r.tex.dispose());
    this.renderer.dispose();
    // Free the GPU context now: a world switch or a remount makes a new canvas.
    this.renderer.forceContextLoss();
  }

  // --- internals ------------------------------------------------------------------

  private now(): number {
    return (performance.now() - this.t0) / 1000;
  }

  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  private plane(tex: Texture | null, w: number, h: number, z: number, opts: MeshBasicMaterialParameters = {}): Sized {
    const m = new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, ...opts });
    const mesh = new Mesh(new PlaneGeometry(w, h), m) as unknown as Sized;
    mesh.userData.size = [w, h];
    mesh.position.z = z;
    mesh.renderOrder = z * 10;
    this.scene.add(mesh);
    return mesh;
  }

  // Place by top-left in image coords, snapped to whole pixels.
  private put(mesh: Sized, x: number, y: number): void {
    const [w, h] = mesh.userData.size;
    mesh.position.x = Math.round(x) + w / 2;
    mesh.position.y = -(Math.round(y) + h / 2);
  }

  private drop(mesh: Sized): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }

  private chars(id: number): CharTex {
    const hit = this.charTex.get(id);
    if (hit) return hit;
    const back = this.imgs.back[id] ?? this.imgs.back[1];
    const front = this.imgs.front[id];
    const up = this.imgs.up[id];
    const t: CharTex = {
      backUp: texFrom(crop(back, 0, 0, SPRITE_W, SPLIT)),
      backLegs: texFrom(crop(back, 0, SPLIT, SPRITE_W, SPRITE_H - SPLIT)),
      armsUp: up ? texFrom(crop(up, 0, 0, UP_W, SPLIT + UP_EXTRA)) : null,
      armsLegs: up ? texFrom(crop(up, 0, SPLIT + UP_EXTRA, UP_W, SPRITE_H - SPLIT)) : null,
      front: front ? texFrom(crop(front, 0, 0, SPRITE_W, SPRITE_H)) : null,
    };
    this.charTex.set(id, t);
    return t;
  }

  private assignBooth(b: Booth, who: BoothEntry | null): void {
    b.who = who;
    b.next = null;
    const tex = who ? this.chars(who.characterId).front ?? this.chars(who.characterId).backUp : null;
    (b.mesh.material as MeshBasicMaterial).map = tex;
    b.mesh.material.needsUpdate = true;
    b.mesh.visible = Boolean(who);
  }

  private drawSky(t: number): void {
    const W = this.skyC.width;
    const AW = this.world.W;
    const sctx = this.skyC.getContext('2d')!;
    const img = sctx.createImageData(W, SKY_H);
    const d = img.data;
    const bands = this.bands;
    for (let y = 0; y < SKY_H; y++) {
      const f = (y / (SKY_H - 1)) * (bands.length - 1);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let c: ArrayLike<number>;
        if (y >= SKY_H - 6) { const k = Math.max(0, Math.min(AW - 1, x - SIDE_EXT)) * 4; c = [this.topRow[k], this.topRow[k + 1], this.topRow[k + 2]]; }
        else { const lo = Math.floor(f), fr = f - lo; c = bands[fr * 16 > BAYER[(y % 4) * 4 + (x % 4)] ? Math.min(lo + 1, bands.length - 1) : lo]; }
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
    for (const s of this.stars) {
      const on = !this.motion || Math.sin(t * 2.2 + s.p) > -0.6;
      sctx.fillStyle = on ? (s.b > 0.6 ? '#f4f1ff' : '#b9aee0') : '#5b4f86';
      sctx.fillRect(s.x, s.y, 1, 1);
      if (s.big && on) {
        sctx.fillStyle = '#8f7fd0';
        sctx.fillRect(s.x - 1, s.y, 1, 1); sctx.fillRect(s.x + 1, s.y, 1, 1); sctx.fillRect(s.x, s.y - 1, 1, 1); sctx.fillRect(s.x, s.y + 1, 1, 1);
      }
    }
    const mx = this.world.moon[0] + SIDE_EXT, my = SKY_H + this.world.moon[1], r = 11;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r + r) continue;
      sctx.fillStyle = x + y > 6 ? '#b8afd6' : '#e9e4fb';
      sctx.fillRect(mx + x, my + y, 1, 1);
    }
    sctx.fillStyle = '#c9c1e6';
    ([[-4, -3, 3], [3, 2, 2], [-2, 5, 2]] as const).forEach(([x, y, s]) => sctx.fillRect(mx + x, my + y, s, s - 1));
  }

  private drawWave(beat: number, cnv: HTMLCanvasElement): void {
    const wctx = cnv.getContext('2d')!;
    const W = cnv.width, H = cnv.height, mid = Math.floor(H / 2), amp = Math.max(2, mid - 2);
    wctx.fillStyle = '#28154a';
    wctx.fillRect(0, 0, W, H);
    const env = this.motion ? 0.45 + 0.55 * Math.exp(-((beat % 1) * 3.2)) : 0.7;
    let prev: number | null = null;
    for (let x = 0; x < W; x++) {
      const a = Math.sin(x * 0.42 + beat * Math.PI * 0.5) * 0.65 + Math.sin(x * 0.17 - beat * 1.3) * 0.35;
      const y = Math.round(mid + a * amp * env);
      const y0 = prev ?? y;
      const lo = Math.min(y, y0), hi = Math.max(y, y0);
      wctx.fillStyle = '#5a3a9a'; wctx.fillRect(x, lo - 1, 1, hi - lo + 3);
      wctx.fillStyle = '#d9cffb'; wctx.fillRect(x, lo, 1, Math.max(1, hi - lo));
      prev = y;
    }
  }

  // Background crowd: procedural silhouettes in rows behind the named audience.
  private buildRows(crowdBottom: number): void {
    this.rows.forEach((r) => { this.drop(r.mesh); r.tex.dispose(); });
    this.rows = [];
    const W = this.world.W + 2 * SIDE_EXT;
    this.seed = 11;
    const first = this.world.rowsFrom;
    const last = crowdBottom - this.world.rowsToOff;
    let feet = first;
    while (feet <= last) {
      const t = clamp01((feet - first) / Math.max(26, last - first));
      const h = Math.round(24 + 14 * t), spacing = 8 + 6 * t;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = h + 14;
      const tex = texFrom(c);
      const mesh = this.plane(tex, c.width, c.height, 5 + this.rows.length * 0.08);
      const n = Math.ceil(W / spacing) + 1;
      const people: RowPerson[] = Array.from({ length: n }, (_, i) => {
        const hr = Math.max(2, Math.round(h / 11 + this.rnd() * 1.2));
        return {
          x: Math.round(2 + i * spacing + (this.rnd() - 0.5) * spacing * 0.8),
          hr,
          hair: HAIR[Math.floor(this.rnd() * HAIR.length)],
          sw: hr + 2 + Math.floor(this.rnd() * 2),
          style: this.rnd() < 0.5 ? 0 : 1,
          phase: this.rnd() < 0.5 ? 0 : 0.5,
          arms: this.rnd() < 0.1 ? 1 : 0,
          phone: this.rnd() < 0.2,
          lift: Math.floor(this.rnd() * 5),
        };
      });
      const row: Row = { feet, h, body: mix(FAR[0], NEAR[0], t), rim: mix(FAR[1], NEAR[1], t), c, ctx: c.getContext('2d')!, tex, mesh, people };
      this.put(mesh, -SIDE_EXT, feet - c.height + 2);
      this.rows.push(row);
      feet += Math.max(11, Math.round(h * 0.42));
    }
  }

  private drawPerson(ctx: CanvasRenderingContext2D, p: RowPerson, base: number, row: Row, bob: number): void {
    const cx = p.x + 10, top = base - row.h + p.lift + bob;
    const r = p.hr, headCy = top + r + (p.hair === 'afro' ? 2 : 0);
    ctx.fillStyle = row.body;
    const disc = (cx0: number, cy0: number, rr: number) => {
      for (let y = -rr; y <= rr; y++) for (let x = -rr; x <= rr; x++) if (x * x + y * y <= rr * rr + rr) ctx.fillRect(cx0 + x, cy0 + y, 1, 1);
    };
    if (p.hair === 'afro') disc(cx, headCy - 1, r + 2);
    disc(cx, headCy, r);
    if (p.hair === 'bun') disc(cx, headCy - r - 1, Math.max(1, r - 2));
    if (p.hair === 'cap') { ctx.fillRect(cx - r, headCy - r, r * 2 + 1, 2); ctx.fillRect(cx + r, headCy - r + 1, 2, 1); }
    if (p.hair === 'long') ctx.fillRect(cx - r, headCy, r * 2 + 1, r + 3);
    const neckY = headCy + r;
    ctx.fillRect(cx - 1, neckY, 3, 2);
    const sy = neckY + 2, sw = p.sw;
    ctx.fillRect(cx - sw + 2, sy, sw * 2 - 3, 1);
    ctx.fillRect(cx - sw + 1, sy + 1, sw * 2 - 1, 1);
    ctx.fillRect(cx - sw, sy + 2, sw * 2 + 1, base + 20 - sy);
    if (p.hair !== 'cap' && p.hair !== 'bun') {
      // Rim light on the head from the lit stage.
      ctx.fillStyle = row.rim;
      const rr = p.hair === 'afro' ? r + 2 : r, cy = p.hair === 'afro' ? headCy - 1 : headCy;
      for (let x = -rr + 1; x <= rr - 1; x++) ctx.fillRect(cx + x, cy - Math.floor(Math.sqrt(Math.max(0, rr * rr + rr - x * x))), 1, 1);
      ctx.fillStyle = row.body;
    }
    if (p.arms) {
      const reach = Math.round(r * 2 + 4);
      const ax = cx + (sw - 1);
      for (let k = 0; k < reach; k++) ctx.fillRect(ax + Math.floor(k / 5), sy - k, 2, 1);
      const hx = ax + Math.floor(reach / 5), hy = sy - reach - 1;
      ctx.fillRect(hx, hy, 2, 2);
      ctx.fillStyle = row.rim; ctx.fillRect(hx, hy, 2, 1); ctx.fillStyle = row.body;
      if (p.phone) { ctx.fillStyle = '#cfe6ff'; ctx.fillRect(hx, hy - 3, 2, 3); ctx.fillStyle = row.body; }
    }
  }

  private drawRow(row: Row, beat: number): void {
    const ctx = row.ctx, H = row.c.height, base = H - 2;
    ctx.clearRect(0, 0, row.c.width, H);
    for (const p of row.people) {
      const f = (beat + p.phase) % 1;
      const bob = this.motion ? (p.style === 0 ? (f < 0.5 ? 1 : 0) : (f < 0.25 ? -1 : 0)) : 0;
      this.drawPerson(ctx, p, base, row, bob);
    }
    row.tex.needsUpdate = true;
  }

  private spawnHeart(p: Person): void {
    const m = this.plane(this.heartTex, 7, 6, 12);
    this.hearts.push({ m, x: p.slot.x + 6 + Math.round((this.rnd() - 0.5) * 8), y0: p.slot.feet - 52, born: this.now() });
  }

  private burst(): void {
    const [lx, rx, y] = this.world.confetti;
    this.conf.forEach((c, i) => {
      const left = i % 2 === 0;
      c.x = left ? lx : rx;
      c.y = y;
      c.vx = (left ? -1 : 1) * (10 + this.rnd() * 50) + (this.rnd() - 0.5) * 20;
      c.vy = -40 - this.rnd() * 60;
    });
  }

  private frame(): void {
    const f = this.framing;
    if (!f) return;
    const t = this.now();
    const dt = Math.min(0.05, Math.max(0, t - this.lastT));
    this.lastT = t;
    const motion = this.motion;
    // One shared beat for the room (lib/beatClock), aligned to the synced clock.
    const beat = motion ? beatAt(serverNow()).beats : 0;
    const pulse = motion ? Math.exp(-(beat % 1) * 3.5) : 0.4;

    // Lights.
    const u = this.beamMat.uniforms;
    this.beams.forEach((b, i) => {
      u.ang.value[i] = b.a + (motion ? Math.sin(t * b.sp + b.ph) * (i < 4 ? 0.28 : 0.35) : 0);
      u.inten.value[i] = (0.7 + 0.5 * this.energy) * (i < 4 ? 0.55 + 0.45 * pulse : Math.floor(beat / 4) % 2 === i % 2 ? 0.9 : 0.25);
    });
    this.lamps.forEach((m, i) => { (m.material as MeshBasicMaterial).opacity = 0.35 + 0.65 * (Math.floor(beat + i * 0.5) % 2 ? pulse : 0.3); });
    if (motion ? t - this.lastSky > 0.25 : this.lastSky < 0) { this.drawSky(t); this.skyTex.needsUpdate = true; this.lastSky = t; }
    if (this.wavePanels.length) { this.drawWave(beat, this.waveC); this.waveTex.needsUpdate = true; }
    for (const b of this.booths) if (b.waveC && b.waveTex) { this.drawWave(beat, b.waveC); b.waveTex.needsUpdate = true; }

    this.energy = Math.max(0, this.energy - dt * 0.05);
    if (motion && this.energy > 0.8 && t - this.lastBurst > 10) { this.burst(); this.lastBurst = t; }

    // Booths: sink, swap, rise (the rotation on a track change).
    const out: FrameOut = { people: new Map(), booths: [] as unknown as FrameOut['booths'] };
    this.booths.forEach((b) => {
      if (b.mode === 'sink') {
        b.rise = Math.max(0, b.from - (t - b.t0) / 0.4);
        if (b.rise <= 0) { this.assignBooth(b, b.next); b.mode = b.who ? 'rise' : 'idle'; b.t0 = t; }
      } else if (b.mode === 'rise') {
        b.rise = Math.min(1, (t - b.t0) / 0.5);
        if (b.rise >= 1) b.mode = 'idle';
      }
      const bob = motion && b.rise >= 1 ? ((beat % 1) < 0.5 ? 1 : 0) : 0;
      const y = b.def.top + Math.round((1 - b.rise) * 40);
      this.put(b.mesh, b.def.x, y + bob);
      const [ax, ay] = this.css(b.def.x + SPRITE_W / 2, b.def.desk ? b.def.top + 28 + 16 : y);
      out.booths.push({ key: b.who?.key ?? null, x: ax, y: ay, visible: Boolean(b.who) && b.rise >= 1 });
    });

    // Background rows dance on half beats.
    const half = Math.floor(beat * 4);
    if (half !== this.lastHalf) {
      this.rows.forEach((row) => this.drawRow(row, beat));
      this.lastHalf = half;
    }

    // Named audience: walk in from the side, groove, woot.
    for (const p of this.people.values()) {
      if (p.here < 1) p.here = motion ? clamp01((t - p.hereFrom) / 1.2) : 1;
      const k = p.here;
      const off = Math.round((1 - k) * (p.side < 0 ? -(p.slot.x + 30) : this.world.W - p.slot.x + 30));
      let bob = 0, sway = 0, hop = 0;
      const since = t - p.wootAt;
      const wooting = since >= 0 && since < 0.5;
      const armsUp = since >= 0 && since < 0.5 + 60 / 100 + (motion ? 0 : 0.6);
      if (k < 1) hop = Math.floor(off / 3) % 2 ? -1 : 0;
      else if (motion && !wooting) {
        const fb = (beat + p.phase) % 1;
        if (p.style === 0) bob = fb < 0.5 ? 1 : 0;
        else if (p.style === 1) { hop = fb < 0.22 ? -1 : 0; bob = fb > 0.5 && fb < 0.7 ? 1 : 0; }
        else { bob = fb < 0.5 ? 1 : 0; sway = Math.floor((beat + p.phase) / 2) % 2; }
      }
      const jump = motion && wooting ? -Math.round(p.wootH * Math.sin((since / 0.5) * Math.PI)) : 0;
      const x = p.slot.x + off + sway, jy = jump + hop;
      const up = armsUp && k >= 1 && p.upA !== null && p.legsA !== null;
      p.up.visible = p.legs.visible = !up;
      if (p.upA) p.upA.visible = up;
      if (p.legsA) p.legsA.visible = up;
      this.put(p.legs, x, p.slot.feet - (SPRITE_H - SPLIT) + jy);
      this.put(p.up, x, p.slot.feet - SPRITE_H + jy + bob);
      if (p.legsA) this.put(p.legsA, x - 4, p.slot.feet - (SPRITE_H - SPLIT) + jy);
      if (p.upA) this.put(p.upA, x - 4, p.slot.feet - SPRITE_H - UP_EXTRA + jy + bob);
      const [ax, ay] = this.css(x + SPRITE_W / 2, p.slot.feet - SPRITE_H + jy + bob - (up ? 7 : 0));
      out.people.set(p.key, { x: ax, y: ay, visible: k >= 1 && ay > 0 && ay < f.height });
    }

    // Hearts drift up in whole-pixel steps and blink out.
    for (let i = this.hearts.length - 1; i >= 0; i--) {
      const h = this.hearts[i];
      const life = (t - h.born) / 1.6;
      if (life >= 1) { this.drop(h.m); this.hearts.splice(i, 1); continue; }
      const y = h.y0 - Math.round(34 * (1 - (1 - life) * (1 - life)));
      this.put(h.m, h.x + Math.round(Math.sin(life * 9) * 1.5), y);
      h.m.visible = life < 0.75 || Math.floor(life * 30) % 2 === 0;
    }

    // Confetti: simple gravity, snapped to pixels.
    this.conf.forEach((c, i) => {
      if (c.y < -500) { this.confPos[i * 3 + 1] = 9999; return; }
      c.vy += 60 * dt; c.vx *= 0.985; c.x += c.vx * dt; c.y += c.vy * dt;
      this.confPos[i * 3] = Math.round(c.x + Math.sin(t * 6 + c.ph)) + 0.5;
      this.confPos[i * 3 + 1] = -(Math.round(c.y) + 0.5);
      this.confPos[i * 3 + 2] = 11;
      if (c.y > this.world.liveBottom + 30) c.y = -999;
    });
    (this.confGeo.attributes.position as BufferAttribute).needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
    this.onFrame?.(out);
  }

  private css(wx: number, wy: number): [number, number] {
    const f = this.framing!;
    return [Math.round((wx - f.camLeft) * f.scale + f.ox), Math.round((wy - f.camTop) * f.scale)];
  }
}
