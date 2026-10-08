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
import { DESK_BOTTOM, DESK_TOP, SIDE_EXT, SPLIT, SPRITE_H, SPRITE_W, type Framing, type Slot, type WorldDef } from '@/lib/palco';
import { beatAt } from '@/lib/beatClock';
import { serverNow } from '@/lib/playbackSync';
import { CHARACTER_COUNT } from '@/lib/characters';

const SKY_H = 540;
// Arms-up frames: 28x60, 4 px margin each side and 12 rows of headroom over
// the 20x48 sprite, bottom aligned. Drawn per facing, following the outfit.
const UP_W = 28;
const UP_EXTRA = 12;
const UP_SIDE = (UP_W - SPRITE_W) / 2;
// Name tags rise this many native px while the arms are up.
const UP_TAG = 6;
const INK = '#0d0a17';
// The named audience faces the camera; nothing turns anyone round yet.
const FACING: Facing = 'front';

export interface SceneImages {
  stage: HTMLImageElement;
  // Image-model sky (bands, stars, moon, far lights), as wide as the plate.
  sky: HTMLImageElement | null;
  // The floor DJ desk of the vertical stage (left facing; mirrored for R).
  desk: HTMLImageElement | null;
  // Background crowd tiles, two frames per layer.
  crowd: Record<CrowdLayer, [HTMLImageElement, HTMLImageElement]>;
  front: Record<number, HTMLImageElement>;
  back: Record<number, HTMLImageElement>;
  upFront: Record<number, HTMLImageElement>;
  upBack: Record<number, HTMLImageElement>;
  // Dance frames: 28x60 on the same canvas as the arms-up frames.
  danceFront: Record<number, HTMLImageElement>;
  danceBack: Record<number, HTMLImageElement>;
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
  const [sky, desk, ...tiles] = await Promise.all([
    load(world.sky),
    world.booths.some((b) => b.desk) ? load('/palco/desk.png') : Promise.resolve(null),
    ...CROWD_LAYERS.flatMap((l) => [load(`/palco/crowd-${l}-a.png`), load(`/palco/crowd-${l}-b.png`)]),
  ]);
  if (tiles.some((t) => !t)) throw new Error('palco: crowd art failed to load');
  const crowd = Object.fromEntries(CROWD_LAYERS.map((l, i) => [l, [tiles[i * 2]!, tiles[i * 2 + 1]!]])) as SceneImages['crowd'];
  const out: SceneImages = { stage, sky, desk, crowd, front: {}, back: {}, upFront: {}, upBack: {}, danceFront: {}, danceBack: {} };
  const ids = Array.from({ length: CHARACTER_COUNT }, (_, i) => i + 1);
  await Promise.all(
    ids.flatMap((id) => [
      load(`/palco/characters/${pad(id)}-front.png`).then((i) => { if (i) out.front[id] = i; }),
      load(`/palco/characters/${pad(id)}-back.png`).then((i) => { if (i) out.back[id] = i; }),
      load(`/palco/characters/${pad(id)}-up-front.png`).then((i) => { if (i) out.upFront[id] = i; }),
      load(`/palco/characters/${pad(id)}-up-back.png`).then((i) => { if (i) out.upBack[id] = i; }),
      load(`/palco/characters/${pad(id)}-dance-front.png`).then((i) => { if (i) out.danceFront[id] = i; }),
      load(`/palco/characters/${pad(id)}-dance-back.png`).then((i) => { if (i) out.danceBack[id] = i; }),
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

// A horizontally flipped copy.
function mirrored(src: HTMLCanvasElement | HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext('2d')!;
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  return c;
}

type Sized = Mesh<PlaneGeometry, Material> & { userData: { size: [number, number] } };

const BAYER_GLSL = `float bayer(vec2 p){ int x=int(mod(p.x,4.)); int y=int(mod(p.y,4.)); int i=x+y*4;
  float m[16]; m[0]=0.;m[1]=8.;m[2]=2.;m[3]=10.;m[4]=12.;m[5]=4.;m[6]=14.;m[7]=6.;m[8]=3.;m[9]=11.;m[10]=1.;m[11]=9.;m[12]=15.;m[13]=7.;m[14]=13.;m[15]=5.;
  for(int k=0;k<16;k++){ if(k==i) return (m[k]+0.5)/16.; } return 0.; }`;
const BEAM_LOOK: Array<[[number, number, number], number, number]> = [
  [[0.55, 0.38, 1.0], 0.7, 0], [[0.85, 0.8, 1.0], 0.9, 1.7], [[0.85, 0.8, 1.0], 0.9, 3.1],
  [[0.55, 0.38, 1.0], 0.7, 4.4], [[0.95, 0.45, 0.85], 1.4, 0.4], [[0.95, 0.45, 0.85], 1.4, 2.2],
];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface CharTex {
  // Upper body (rows 0..SPLIT) and legs of each facing, plus the arms-up pairs.
  halves: Record<Facing, [Texture, Texture]>;
  arms: Record<Facing, [Texture, Texture] | null>;
  dance: Record<Facing, [Texture, Texture] | null>;
  front: Texture | null;
}

type Facing = 'front' | 'back';

interface Person {
  key: string;
  characterId: number;
  slot: Slot;
  legs: Sized;
  up: Sized;
  // The 28x60 planes: arms up (woot) or the dance frame, by texture swap.
  legsA: Sized | null;
  upA: Sized | null;
  arms: [Texture, Texture] | null;
  dance: [Texture, Texture] | null;
  pose: 'idle' | 'dance' | 'arms';
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
  // Head row; on the vertical stage it moves below the player.
  top: number;
  desk?: Sized;
}

// A background crowd row: an image-model tile layer (far, mid or near) tiled
// across the view, with two frames that alternate on the half beat.
interface Row {
  feet: number;
  h: number;
  texA: Texture;
  texB: Texture;
  mesh: Sized;
  phase: number;
  frame: number;
}

type CrowdLayer = 'far' | 'mid' | 'near';
const CROWD_LAYERS: CrowdLayer[] = ['far', 'mid', 'near'];

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
  // Battery: no frames while the tab is hidden, and while idle (the phone
  // stage shrunk under an open Fila or Chat) only for a moment after a change.
  private hidden = false;
  private idle = false;
  private awakeUntil = 0;
  private running = false;
  private seed = 7;
  private readonly t0 = performance.now();
  private readonly charTex = new Map<number, CharTex>();
  private readonly people = new Map<string, Person>();
  private readonly booths: Booth[] = [];
  private rows: Row[] = [];
  private lastSky = -1;
  private energy = 0;
  private lastBurst = -100;
  private readonly hearts: Array<{ m: Sized; x: number; y0: number; born: number }> = [];
  private readonly conf: Array<{ x: number; y: number; vx: number; vy: number; ph: number }> = [];
  private readonly confPos: Float32Array;
  private readonly confGeo = new BufferGeometry();
  private readonly skyC: HTMLCanvasElement;
  private readonly skyTex: Texture;
  private readonly skyBase: ImageData;
  // Twinkle: isolated bright pixels of the sky art blink to the sky beside them.
  private readonly stars: Array<{ i: number; on: [number, number, number]; off: [number, number, number]; p: number; s: number }> = [];
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

    // Sky: the image-model plate, its sides mirrored past the art; its last
    // rows meet the stage's top row.
    const SW = W + 2 * SIDE_EXT;
    this.skyC = document.createElement('canvas');
    this.skyC.width = SW;
    this.skyC.height = SKY_H;
    const sg = this.skyC.getContext('2d')!;
    sg.fillStyle = INK;
    sg.fillRect(0, 0, SW, SKY_H);
    if (imgs.sky) {
      const sh = Math.min(SKY_H, imgs.sky.height);
      sg.drawImage(imgs.sky, 0, 0, W, sh, SIDE_EXT, SKY_H - sh, W, sh);
      sg.drawImage(mirrored(crop(imgs.sky, 0, 0, SIDE_EXT, sh)), 0, SKY_H - sh);
      sg.drawImage(mirrored(crop(imgs.sky, W - SIDE_EXT, 0, SIDE_EXT, sh)), SIDE_EXT + W, SKY_H - sh);
    }
    this.skyBase = sg.getImageData(0, 0, SW, SKY_H);
    {
      const d = this.skyBase.data;
      const lum = (x: number, y: number) => { const i = (y * SW + x) * 4; return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; };
      for (let y = 1; y < SKY_H - 60; y++) for (let x = 1; x < SW - 1; x++) {
        const L = lum(x, y);
        if (L < 120) continue;
        // Part of the moon or a beam, not a star.
        if (Math.max(lum(x - 1, y - 1), lum(x + 1, y - 1), lum(x - 1, y + 1), lum(x + 1, y + 1)) > L - 50) continue;
        const j = (y * SW + x) * 4, k = ((y - 1) * SW + x) * 4;
        this.stars.push({ i: j, on: [d[j], d[j + 1], d[j + 2]], off: [d[k], d[k + 1], d[k + 2]], p: this.rnd() * 6, s: 1.6 + this.rnd() * 1.8 });
      }
    }
    this.drawSky(0);
    this.skyTex = texFrom(this.skyC);
    this.put(this.plane(this.skyTex, SW, SKY_H, 0), -SIDE_EXT, -SKY_H);

    // Stage plate, its edge columns carried past the sides, and the ground under it.
    this.put(this.plane(texFrom(imgs.stage), W, world.H, 1), 0, 0);
    // Past the sides: the plate's own edge, mirrored (a stretched edge column streaks).
    this.put(this.plane(texFrom(mirrored(crop(imgs.stage, 0, 0, SIDE_EXT, world.H))), SIDE_EXT, world.H, 1), -SIDE_EXT, 0);
    this.put(this.plane(texFrom(mirrored(crop(imgs.stage, W - SIDE_EXT, 0, SIDE_EXT, world.H))), SIDE_EXT, world.H, 1), W, 0);
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
      const booth: Booth = { def, mesh: this.plane(null, SPRITE_W, SPRITE_H, 4), who: null, next: null, rise: 0, mode: 'idle', t0: 0, from: 0, top: def.top };
      booth.mesh.visible = false;
      if (def.desk) {
        // The floor DJs stand in front of the silhouette rows (z 5 to 6).
        booth.mesh.position.z = 6.5;
        booth.mesh.renderOrder = 65;
        this.placeDesk(booth);
      } else if (def.cover) {
        const [cx, cy, cw, chh] = def.cover;
        this.put(this.plane(texFrom(crop(imgs.stage, cx, cy, cw, chh)), cw, chh, 4.5), cx, cy);
      }
      this.booths.push(booth);
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

  // boothTop: head row of the DJs (the vertical stage moves them below the player).
  resize(f: Framing, boothTop?: number): void {
    this.framing = f;
    for (const b of this.booths) {
      const top = b.def.desk && boothTop !== undefined ? boothTop : b.def.top;
      if (top !== b.top) {
        b.top = top;
        this.placeDesk(b);
      }
    }
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
    this.kick();
  }

  setMotion(on: boolean): void {
    this.motion = on;
    if (!on) {
      for (const p of this.people.values()) p.here = 1;
      this.conf.forEach((c) => { c.y = -999; });
      this.hearts.splice(0).forEach((h) => this.drop(h.m));
    }
    this.kick();
  }

  setCrowd(entries: CrowdEntry[]): void {
    const now = this.now();
    this.kick();
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
        const wide = tex.arms[FACING] ?? tex.dance[FACING];
        const fresh: Person = {
          key: e.key,
          characterId: e.characterId,
          slot: e.slot,
          // Faces the camera (plug.dj style) so you can see who is who.
          legs: this.plane(tex.halves[FACING][1], SPRITE_W, SPRITE_H - SPLIT, z, { color: tint }),
          up: this.plane(tex.halves[FACING][0], SPRITE_W, SPLIT, z + 0.005, { color: tint }),
          legsA: wide ? this.plane(wide[1], UP_W, SPRITE_H - SPLIT, z, { color: tint }) : null,
          upA: wide ? this.plane(wide[0], UP_W, SPLIT + UP_EXTRA, z + 0.005, { color: tint }) : null,
          arms: tex.arms[FACING],
          dance: tex.dance[FACING],
          pose: 'idle',
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
    this.kick();
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
    this.kick();
    this.energy = Math.min(1, this.energy + 0.07);
    if (!p) return;
    p.wootAt = this.now();
    p.wootH = p.slot.row === 1 ? 5 : 7;
    if (this.motion && p.here >= 1) this.spawnHeart(p);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.hidden = document.hidden;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.kick();
  }

  // Idle: render only around changes (a booth swap, a woot, a resize).
  setIdle(idle: boolean): void {
    this.idle = idle;
    this.kick();
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    document.removeEventListener('visibilitychange', this.onVisibility);
    // Every texture once: the scene's maps (stage plate, edges, ground, covers,
    // desks, lamps, rows) plus the ones not always in the scene.
    const textures = new Set<Texture>([this.skyTex, this.heartTex]);
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as Material | Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        const map = (x as MeshBasicMaterial).map;
        if (map) textures.add(map);
        x.dispose();
      }
    });
    this.hearts.splice(0).forEach((h) => this.drop(h.m));
    this.confGeo.dispose();
    textures.forEach((t) => t.dispose());
    for (const t of this.charTex.values()) {
      [...t.halves.front, ...t.halves.back, ...(t.arms.front ?? []), ...(t.arms.back ?? []), ...(t.dance.front ?? []), ...(t.dance.back ?? []), t.front].forEach((x) => x?.dispose());
    }
    this.rows.forEach((r) => { textures.add(r.texA); textures.add(r.texB); });
    this.renderer.dispose();
    // Free the GPU context now: a world switch or a remount makes a new canvas.
    this.renderer.forceContextLoss();
  }

  // --- internals ------------------------------------------------------------------

  private readonly onVisibility = () => {
    this.hidden = document.hidden;
    this.kick();
  };

  private readonly loop = () => {
    this.raf = 0;
    if (!this.running) return;
    this.frame();
    if (this.hidden || (this.idle && performance.now() > this.awakeUntil)) return;
    this.raf = requestAnimationFrame(this.loop);
  };

  // Keeps frames coming for a moment (long enough for a booth sink and rise).
  private kick(ms = 1200): void {
    this.awakeUntil = Math.max(this.awakeUntil, performance.now() + ms);
    if (this.running && !this.hidden && !this.raf) this.raf = requestAnimationFrame(this.loop);
  }

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
    const halves = (img: HTMLImageElement): [Texture, Texture] => [
      texFrom(crop(img, 0, 0, SPRITE_W, SPLIT)),
      texFrom(crop(img, 0, SPLIT, SPRITE_W, SPRITE_H - SPLIT)),
    ];
    // Arms-up frames split UP_EXTRA rows lower (their headroom); the legs
    // half differs slightly from the plain sprite because hems lift.
    const arms = (img: HTMLImageElement | undefined): [Texture, Texture] | null =>
      img ? [texFrom(crop(img, 0, 0, UP_W, SPLIT + UP_EXTRA)), texFrom(crop(img, 0, SPLIT + UP_EXTRA, UP_W, SPRITE_H - SPLIT))] : null;
    const t: CharTex = {
      halves: { front: halves(front ?? back), back: halves(back) },
      arms: { front: arms(this.imgs.upFront[id]), back: arms(this.imgs.upBack[id]) },
      dance: { front: arms(this.imgs.danceFront[id]), back: arms(this.imgs.danceBack[id]) },
      front: front ? texFrom(crop(front, 0, 0, SPRITE_W, SPRITE_H)) : null,
    };
    this.charTex.set(id, t);
    return t;
  }

  // The image-model floor desk of the vertical stage. A sinking DJ is clipped
  // at its bottom edge (see frame), so it needs no cover of art pixels.
  private placeDesk(b: Booth): void {
    if (!b.def.desk || !this.imgs.desk) return;
    if (b.desk) this.drop(b.desk);
    const img = this.imgs.desk;
    b.desk = this.plane(texFrom(b.def.side === 'R' ? mirrored(img) : img), img.width, img.height, 6.6);
    this.put(b.desk, b.def.x - (img.width - SPRITE_W) / 2, b.top + DESK_TOP);
  }

  private assignBooth(b: Booth, who: BoothEntry | null): void {
    b.who = who;
    b.next = null;
    const base = who ? this.chars(who.characterId).front ?? this.chars(who.characterId).halves.back[0] : null;
    const mat = b.mesh.material as MeshBasicMaterial;
    // Floor DJs crop their own copy of the texture (repeat/offset per booth).
    if (b.def.desk && mat.map && mat.map !== base) mat.map.dispose();
    const tex = base && b.def.desk ? base.clone() : base;
    if (tex && b.def.desk) tex.needsUpdate = true;
    mat.map = tex;
    b.mesh.material.needsUpdate = true;
    b.mesh.visible = Boolean(who);
  }

  private drawSky(t: number): void {
    const d = this.skyBase.data;
    for (const st of this.stars) {
      const c = !this.motion || Math.sin(t * st.s + st.p) > -0.55 ? st.on : st.off;
      d[st.i] = c[0]; d[st.i + 1] = c[1]; d[st.i + 2] = c[2];
    }
    this.skyC.getContext('2d')!.putImageData(this.skyBase, 0, 0);
  }

  // Background crowd: image-model tile rows behind the named audience, far
  // to near. Every other tile is mirrored, so the joins stay seamless and the
  // repeat period doubles; each row starts at its own offset.
  private buildRows(crowdBottom: number): void {
    this.rows.forEach((r) => { this.drop(r.mesh); r.texA.dispose(); r.texB.dispose(); });
    this.rows = [];
    const W = this.world.W + 2 * SIDE_EXT;
    this.seed = 11;
    const tiled = (img: HTMLImageElement, off: number) => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = img.height;
      const g = c.getContext('2d')!;
      for (let x = -off, i = 0; x < W; x += img.width, i++) {
        if (i % 2) g.drawImage(mirrored(img), x, 0);
        else g.drawImage(img, x, 0);
      }
      return texFrom(c);
    };
    const first = this.world.rowsFrom;
    const last = crowdBottom - this.world.rowsToOff;
    let feet = first;
    while (feet <= last) {
      const t = clamp01((feet - first) / Math.max(26, last - first));
      const [a, b] = this.imgs.crowd[t < 0.34 ? 'far' : t < 0.67 ? 'mid' : 'near'];
      const off = Math.floor(this.rnd() * a.width * 2);
      const texA = tiled(a, off), texB = tiled(b, off);
      const mesh = this.plane(texA, W, a.height, 5 + this.rows.length * 0.08);
      this.put(mesh, -SIDE_EXT, feet + 2 - a.height);
      // Neighbouring rows are out of phase.
      this.rows.push({ feet, h: a.height, texA, texB, mesh, phase: this.rows.length % 2 ? 0.5 : 0, frame: 0 });
      feet += Math.max(11, Math.round((24 + 14 * t) * 0.42));
    }
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
      const sink = Math.round((1 - b.rise) * 40);
      const y = b.top + sink;
      if (b.def.desk) {
        // Show only the rows above the desk's bottom edge: whole rows.
        const vis = DESK_BOTTOM - sink;
        const map = (b.mesh.material as MeshBasicMaterial).map;
        if (map) { map.repeat.y = vis / SPRITE_H; map.offset.y = 1 - vis / SPRITE_H; }
        b.mesh.scale.y = vis / SPRITE_H;
        b.mesh.position.x = Math.round(b.def.x) + SPRITE_W / 2;
        b.mesh.position.y = -(y + bob + vis / 2);
      } else {
        this.put(b.mesh, b.def.x, y + bob);
      }
      const [ax, ay] = this.css(b.def.x + SPRITE_W / 2, b.def.desk ? b.top + DESK_BOTTOM : y);
      out.booths.push({ key: b.who?.key ?? null, x: ax, y: ay, visible: Boolean(b.who) && b.rise >= 1 });
    });

    // Background rows: two frames, half a beat each, neighbours out of phase.
    for (const row of this.rows) {
      const fr = motion ? Math.floor(beat * 2 + row.phase * 2) % 2 : 0;
      if (fr !== row.frame) {
        row.frame = fr;
        (row.mesh.material as MeshBasicMaterial).map = fr ? row.texB : row.texA;
        row.mesh.material.needsUpdate = true;
      }
    }

    // Named audience: walk in from the side, groove, woot.
    for (const p of this.people.values()) {
      if (p.here < 1) p.here = motion ? clamp01((t - p.hereFrom) / 1.2) : 1;
      const k = p.here;
      const off = Math.round((1 - k) * (p.side < 0 ? -(p.slot.x + 30) : this.world.W - p.slot.x + 30));
      let sway = 0, hop = 0, dance = false;
      const since = t - p.wootAt;
      const wooting = since >= 0 && since < 0.5;
      const armsUp = since >= 0 && since < 0.5 + 60 / 100 + (motion ? 0 : 0.6);
      if (k < 1) hop = Math.floor(off / 3) % 2 ? -1 : 0;
      else if (motion && !armsUp) {
        // Groove: the dance frame alternates with idle, half a beat each, per-person phase.
        const fb = (beat + p.phase) % 1;
        dance = fb < 0.5;
        if (p.style === 1) hop = fb > 0.5 && fb < 0.62 ? -1 : 0;
        else if (p.style === 2) sway = Math.floor((beat + p.phase) / 2) % 2;
      }
      const jump = motion && wooting ? -Math.round(p.wootH * Math.sin((since / 0.5) * Math.PI)) : 0;
      const x = p.slot.x + off + sway, jy = jump + hop;
      const up = armsUp && k >= 1 && p.arms !== null;
      const pose = up ? 'arms' : dance && p.dance ? 'dance' : 'idle';
      if (pose !== p.pose && p.upA && p.legsA) {
        const pair = pose === 'arms' ? p.arms : pose === 'dance' ? p.dance : null;
        if (pair) {
          (p.upA.material as MeshBasicMaterial).map = pair[0];
          (p.legsA.material as MeshBasicMaterial).map = pair[1];
          p.upA.material.needsUpdate = true;
          p.legsA.material.needsUpdate = true;
        }
      }
      p.pose = pose;
      const wide = pose !== 'idle';
      p.up.visible = p.legs.visible = !wide;
      if (p.upA) p.upA.visible = wide;
      if (p.legsA) p.legsA.visible = wide;
      this.put(p.legs, x, p.slot.feet - (SPRITE_H - SPLIT) + jy);
      this.put(p.up, x, p.slot.feet - SPRITE_H + jy);
      if (p.legsA) this.put(p.legsA, x - UP_SIDE, p.slot.feet - (SPRITE_H - SPLIT) + jy);
      if (p.upA) this.put(p.upA, x - UP_SIDE, p.slot.feet - SPRITE_H - UP_EXTRA + jy);
      const [ax, ay] = this.css(x + SPRITE_W / 2, p.slot.feet - SPRITE_H + jy - (up ? UP_TAG : 0));
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
