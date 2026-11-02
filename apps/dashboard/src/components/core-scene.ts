import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { Fate } from "../flow.js";
import { tintOf } from "../tints.js";

/**
 * The page's scene, in plain three.js (SceneCanvas.tsx wraps it in React). Read it like a
 * gauge, seen from slightly above:
 *
 *   rings     one per agent, concentric, flat on the floor. The lit arc is the budget left,
 *             from 12 o'clock clockwise; it shortens as the agent spends.
 *   boundary  the thin circle around the rings is the warrant. Each payee has a port on it.
 *   gates     the payees, standing outside the boundary.
 *   comets    payments. In the agent's tint they leave through the port to the gate; red ones
 *             stop at the port; amber ones wait there for the owner.
 *   STOP      a red dome closes over everything.
 *
 * Every tunable number is in LOOK. Red and amber mean state; everything else is agent tints.
 */
export const LOOK = {
  quiet: 0x9fb4c8,
  bright: 0xe6eef6,
  blocked: 0xff6f63,
  waiting: 0xf0b45a,
  firstRing: 0.62,
  ringGap: 0.3,
  ringWidth: 0.075,
  boundaryPad: 0.42,
  gatePad: 0.78,
  cometSeconds: 1.7,
  trail: 16,
  bloom: { strength: 0.45, radius: 0.4, threshold: 0.62 },
};

const SAMPLES = 120;
const TAU = Math.PI * 2;

export interface AgentNode {
  id: string;
  name: string;
  /** Share of the budget left, 0..1. */
  left: number;
}
export interface PayeeNode {
  id: string;
  name: string;
  sub: string;
  paid: boolean;
}
export interface Shot {
  warrantId: string;
  payee: string;
  fate: Fate;
  seq: number;
}
export interface Waiting {
  id: string;
  warrantId: string | undefined;
  payee: string | undefined;
}

export interface SceneHandle {
  setNodes(agents: AgentNode[], payees: PayeeNode[]): void;
  setStopped(stopped: boolean): void;
  setMotion(on: boolean): void;
  /** Pixels covered by panels on the left and right; the scene centres in what is left. */
  setInsets(left: number, right: number): void;
  setSelected(warrantId: string | null): void;
  setWaiting(waiting: Waiting[]): void;
  fire(shot: Shot, delayMs: number): void;
  dispose(): void;
}

const FLAT_VERT = `
varying vec2 vP;
void main() {
  vP = vec2(position.x, -position.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// A flat ring drawn by its fragment shader, so the edges stay smooth at any size: a faint
// track, the lit arc with round ends from 12 o'clock clockwise to uShare, and a soft glow.
const RING_FRAG = `
uniform float uR; uniform float uW; uniform float uShare; uniform float uDim;
uniform float uTime; uniform float uSheen; uniform float uTrackA; uniform float uGlow;
uniform vec3 uColor;
varying vec2 vP;
const float TAU = 6.28318530718;
vec4 over(vec4 top, vec4 bot) {
  float a = top.a + bot.a * (1.0 - top.a);
  vec3 c = (top.rgb * top.a + bot.rgb * bot.a * (1.0 - top.a)) / max(a, 1e-4);
  return vec4(c, a);
}
void main() {
  float d = length(vP);
  float ang = atan(vP.x, vP.y);
  if (ang < 0.0) ang += TAU;
  float t = ang / TAU;
  float dr = abs(d - uR);
  float aaT = fwidth(dr) * 1.2;
  float track = 1.0 - smoothstep(uW - aaT, uW + aaT, dr);

  float th = uShare * TAU;
  vec2 c0 = vec2(0.0, uR);
  vec2 c1 = vec2(sin(th), cos(th)) * uR;
  float inside = (uShare >= 0.9999 || t <= uShare) ? 1.0 : 0.0;
  float dist = mix(min(length(vP - c0), length(vP - c1)), dr, inside);
  if (uShare <= 0.0005) dist = 1e3;
  float aa = fwidth(dist) * 1.2;
  float arc = 1.0 - smoothstep(uW - aa, uW + aa, dist);

  float along = inside > 0.5 ? clamp(t / max(uShare, 1e-4), 0.0, 1.0) : 1.0;
  vec3 col = mix(uColor * 0.55, uColor, smoothstep(0.0, 1.0, along));
  float across = clamp(1.0 - dr / uW, 0.0, 1.0);
  col *= 0.72 + 0.3 * sqrt(across);
  float band = along - fract(uTime * 0.09);
  col += uSheen * 0.3 * exp(-band * band * 90.0) * arc;

  float glow = uGlow * exp(-max(dist - uW, 0.0) * 24.0) * step(0.0005, uShare);
  vec4 o = vec4(uColor, track * uTrackA);
  o = over(vec4(uColor, glow * 0.22), o);
  o = over(vec4(col, arc), o);
  gl_FragColor = vec4(o.rgb, o.a * uDim);
}`;

// The dial just outside the boundary: 120 fine ticks, every sixth one longer.
const TICK_FRAG = `
uniform float uR; uniform float uW; uniform vec3 uColor; uniform float uA;
varying vec2 vP;
const float TAU = 6.28318530718;
void main() {
  float d = length(vP);
  float ang = atan(vP.x, vP.y);
  if (ang < 0.0) ang += TAU;
  float k = ang / TAU * 120.0;
  float f = fract(k);
  float major = mod(floor(k + 0.5), 6.0) < 0.5 ? 1.0 : 0.0;
  float tick = 1.0 - smoothstep(0.08, 0.08 + fwidth(k) * 1.5, min(f, 1.0 - f));
  float len = mix(uW * 0.4, uW, major);
  float inBand = 1.0 - smoothstep(len - fwidth(d), len + fwidth(d), abs(d - uR));
  gl_FragColor = vec4(uColor, tick * inBand * uA * mix(0.55, 1.0, major));
}`;

// The floor inside the boundary: a faint pool of light.
const FLOOR_FRAG = `
uniform float uR; uniform vec3 uColor;
varying vec2 vP;
void main() {
  float d = length(vP) / uR;
  gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.0, 1.0, d)) * 0.14);
}`;

const FRESNEL_VERT = `
varying vec3 vN; varying vec3 vV;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FRESNEL_FRAG = `
uniform vec3 color; uniform float strength;
varying vec3 vN; varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(vN, vV)), 2.2);
  gl_FragColor = vec4(color, (0.06 + f) * strength);
}`;

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (g) draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const glowTexture = () =>
  canvasTexture(64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });

const backgroundTexture = () =>
  canvasTexture(512, (g) => {
    const grad = g.createRadialGradient(256, 280, 0, 256, 280, 380);
    grad.addColorStop(0, "#101b26");
    grad.addColorStop(0.55, "#0a1018");
    grad.addColorStop(1, "#06090d");
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 512);
  });

/** A square lying in the floor plane, for the shader-drawn circles. */
function floorQuad(half: number, y = 0): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(half * 2, half * 2);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

/** The point `share` of the way round a circle, clockwise from 12 o'clock (far side). */
const onCircle = (radius: number, share: number, y = 0) =>
  new THREE.Vector3(Math.sin(share * TAU) * radius, y, -Math.cos(share * TAU) * radius);

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

type RingUniforms = {
  uR: THREE.IUniform<number>;
  uW: THREE.IUniform<number>;
  uShare: THREE.IUniform<number>;
  uDim: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uSheen: THREE.IUniform<number>;
  uTrackA: THREE.IUniform<number>;
  uGlow: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
};

const ringUniforms = (radius: number, width: number, color: number | THREE.Color) =>
  ({
    uR: { value: radius },
    uW: { value: width },
    uShare: { value: 1 },
    uDim: { value: 1 },
    uTime: { value: 0 },
    uSheen: { value: 0 },
    uTrackA: { value: 0 },
    uGlow: { value: 0.8 },
    uColor: { value: new THREE.Color(color) },
  }) satisfies RingUniforms;

export function createScene(
  host: HTMLElement,
  labelLayer: HTMLElement,
  onSelect: (warrantId: string | null) => void,
): SceneHandle {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  let dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const bgTex = backgroundTexture();
  scene.background = bgTex;
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  /** Where the camera rests: about 32 degrees above the floor, looking at the core. */
  const HOME = new THREE.Vector3(0, 3.5, 6.2);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0.1);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 4;
  controls.maxDistance = 10;
  controls.minPolarAngle = 0.2;
  controls.maxPolarAngle = 1.2;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(256, 256),
    LOOK.bloom.strength,
    LOOK.bloom.radius,
    LOOK.bloom.threshold,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  const tex = glowTexture();
  /** Everything that leans a little with the pointer. */
  const world = new THREE.Group();
  scene.add(world);

  const sprite = (color: number | THREE.Color, scale: number, opacity = 1) => {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex,
        color,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    s.scale.setScalar(scale);
    return s;
  };

  const flatMat = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: FLAT_VERT,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
    });

  // The core: a small faceted gem over a pool of light.
  const gemMat = new THREE.MeshStandardMaterial({
    color: 0xcfdeee,
    emissive: 0x2a4058,
    roughness: 0.25,
    metalness: 0.35,
    flatShading: true,
  });
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), gemMat);
  gem.position.y = 0.17;
  gem.scale.set(1, 1.4, 1);
  const gemEdgeMat = new THREE.LineBasicMaterial({
    color: LOOK.bright,
    transparent: true,
    opacity: 0.5,
  });
  gem.add(new THREE.LineSegments(new THREE.EdgesGeometry(gem.geometry), gemEdgeMat));
  const gemGlow = sprite(LOOK.quiet, 0.6, 0.3);
  gemGlow.position.y = 0.17;
  const gemPool = sprite(LOOK.quiet, 0.8, 0.22);
  gemPool.position.y = 0.01;
  world.add(gem, gemGlow, gemPool);
  let flash = 0;
  let flashColor = new THREE.Color(LOOK.quiet);

  // Boundary, dial, floor and the STOP dome; sized by layout() once the agents are known.
  const boundaryU = ringUniforms(1.6, 0.011, LOOK.quiet);
  boundaryU.uGlow.value = 1.2;
  const boundary = new THREE.Mesh(floorQuad(1), flatMat(RING_FRAG, boundaryU));
  const tickU = {
    uR: { value: 1.75 },
    uW: { value: 0.05 },
    uA: { value: 0.3 },
    uColor: { value: new THREE.Color(LOOK.quiet) },
  };
  const ticks = new THREE.Mesh(floorQuad(1), flatMat(TICK_FRAG, tickU));
  const floorU = { uR: { value: 1.6 }, uColor: { value: new THREE.Color(0x6f8fb0) } };
  const floor = new THREE.Mesh(floorQuad(1, -0.002), flatMat(FLOOR_FRAG, floorU));
  floor.renderOrder = -2;
  ticks.renderOrder = -1;
  const domeU = { color: { value: new THREE.Color(LOOK.blocked) }, strength: { value: 0 } };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 32, 0, TAU, 0, Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: domeU,
      vertexShader: FRESNEL_VERT,
      fragmentShader: FRESNEL_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  dome.visible = false;
  dome.renderOrder = 50;
  world.add(floor, ticks, boundary, dome);
  let rb = 1.6;
  let rp = 2.4;

  interface Ring {
    id: string;
    radius: number;
    mesh: THREE.Mesh;
    u: RingUniforms;
    tint: THREE.Color;
    target: number;
    label: HTMLElement;
  }
  interface Gate {
    id: string;
    share: number;
    pos: THREE.Vector3;
    port: THREE.Vector3;
    pillarMat: THREE.MeshStandardMaterial;
    top: THREE.Sprite;
    portDot: THREE.Sprite;
    label: HTMLElement;
    flash: number;
    portFlash: number;
    portColor: THREE.Color;
  }
  let rings: Ring[] = [];
  let gates: Gate[] = [];
  const gateGroup = new THREE.Group();
  world.add(gateGroup);

  const makeLabel = (cls: string, name: string, sub?: string) => {
    const el = document.createElement("div");
    el.className = `sc-label ${cls}`;
    const n = document.createElement("span");
    n.className = "sc-name";
    n.textContent = name;
    el.append(n);
    if (sub !== undefined) {
      const s = document.createElement("span");
      s.className = "sc-sub";
      s.textContent = sub;
      el.append(s);
    }
    labelLayer.appendChild(el);
    return el;
  };

  let stopped = false;
  let motion = true;
  let selected: string | null = null;
  let hovered: string | null = null;
  let needsRender = true;
  let domeT = 1;
  const white = new THREE.Color(LOOK.bright);
  const deadRing = new THREE.Color(0x6a4a4a);

  const paint = () => {
    for (const r of rings) {
      const focus = selected === null || selected === r.id;
      const lift = !stopped && (hovered === r.id || selected === r.id);
      r.u.uColor.value.copy(stopped ? deadRing : r.tint);
      if (lift) r.u.uColor.value.lerp(white, 0.25);
      r.u.uDim.value = focus ? 1 : 0.28;
      r.u.uGlow.value = lift ? 1.3 : 0.8;
      r.label.classList.toggle("is-dim", !focus);
      r.label.classList.toggle("is-on", selected === r.id);
    }
    needsRender = true;
  };

  const resizeFlat = (mesh: THREE.Mesh, half: number, y = 0) => {
    mesh.geometry.dispose();
    mesh.geometry = floorQuad(half, y);
  };

  /** Sizes the boundary, dial and floor to the rings that exist now; returns the ring gap. */
  const layout = (n: number) => {
    const gap = n > 1 ? Math.min(LOOK.ringGap, 1.05 / (n - 1)) : LOOK.ringGap;
    const outer = LOOK.firstRing + Math.max(0, n - 1) * gap;
    rb = outer + LOOK.boundaryPad;
    rp = rb + LOOK.gatePad;
    boundaryU.uR.value = rb;
    resizeFlat(boundary, rb + 0.3);
    tickU.uR.value = rb + 0.11;
    resizeFlat(ticks, rb + 0.3);
    floorU.uR.value = rb;
    resizeFlat(floor, rb + 0.05, -0.002);
    dome.scale.setScalar(rb);
    return gap;
  };

  // Payments waiting for the owner, held at their ports.
  let markers: THREE.Sprite[] = [];
  let waitingCache: Waiting[] = [];

  const ringOf = (id: string | undefined) => rings.find((r) => r.id === id);
  const gateOf = (id: string | undefined) => gates.find((g) => g.id === id);
  /** Where a payment for this payee crosses the boundary, or straight out from the agent. */
  const portFor = (payee: string | undefined, r: Ring | undefined) =>
    gateOf(payee)?.port.clone() ?? onCircle(rb, r ? r.u.uShare.value : 0.5, 0.02);

  const handle: SceneHandle = {
    setNodes(agents, payees) {
      const same = agents.length === rings.length && agents.every((a, i) => rings[i]?.id === a.id);
      if (same) {
        agents.forEach((a, i) => {
          const r = rings[i];
          if (r) r.target = a.left;
        });
      } else {
        for (const r of rings) {
          r.label.remove();
          r.mesh.removeFromParent();
          r.mesh.geometry.dispose();
          (r.mesh.material as THREE.Material).dispose();
        }
        const gap = layout(agents.length);
        const width = Math.min(LOOK.ringWidth, gap * 0.28);
        rings = agents.map((a, i) => {
          const radius = LOOK.firstRing + i * gap;
          const tint = new THREE.Color(tintOf(i));
          const u = ringUniforms(radius, width, tint);
          u.uShare.value = a.left;
          u.uSheen.value = motion ? 1 : 0;
          u.uTrackA.value = 0.13;
          const mesh = new THREE.Mesh(floorQuad(radius + width * 6), flatMat(RING_FRAG, u));
          mesh.renderOrder = i + 1;
          world.add(mesh);
          const label = makeLabel("sc-ring", a.name);
          label.style.setProperty("--tint", tintOf(i));
          return { id: a.id, radius, mesh, u, tint, target: a.left, label };
        });
      }

      const sameGates =
        payees.length === gates.length && payees.every((p, i) => gates[i]?.id === p.id);
      if (sameGates) {
        payees.forEach((p, i) => {
          const g = gates[i];
          if (!g) return;
          const sub = g.label.querySelector(".sc-sub");
          if (sub) sub.textContent = p.sub;
          g.pillarMat.emissive.set(p.paid ? 0x3a556e : 0x1a2632);
          g.top.material.opacity = p.paid ? 0.85 : 0.4;
        });
      } else {
        for (const g of gates) g.label.remove();
        for (const o of gateGroup.children) {
          const m = o as THREE.Mesh;
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
        gateGroup.clear();
        const m = payees.length;
        // Spread round the far side, from 8 o'clock over the top to 4 o'clock, so no gate sits
        // behind the instruments along the bottom of the page.
        gates = payees.map((p, k) => {
          const share = m === 1 ? 0 : (0.66 + (k * 0.68) / (m - 1)) % 1;
          const pos = onCircle(rp, share);
          const port = onCircle(rb, share, 0.02);
          const pillarMat = new THREE.MeshStandardMaterial({
            color: 0x9fb4c8,
            emissive: p.paid ? 0x3a556e : 0x1a2632,
            roughness: 0.4,
            metalness: 0.3,
            flatShading: true,
          });
          const pillar = new THREE.Mesh(
            new THREE.CylinderGeometry(0.03, 0.045, 0.32, 6),
            pillarMat,
          );
          pillar.position.copy(pos).setY(0.16);
          const top = sprite(LOOK.bright, 0.3, p.paid ? 0.85 : 0.4);
          top.position.copy(pos).setY(0.36);
          const halo = sprite(LOOK.quiet, 0.45, 0.16);
          halo.position.copy(pos).setY(0.01);
          const portDot = sprite(LOOK.quiet, 0.12, 0.55);
          portDot.position.copy(port);
          gateGroup.add(pillar, top, halo, portDot);
          return {
            id: p.id,
            share,
            pos,
            port,
            pillarMat,
            top,
            portDot,
            label: makeLabel("sc-gate", p.name, p.sub),
            flash: 0,
            portFlash: 0,
            portColor: new THREE.Color(LOOK.quiet),
          };
        });
      }
      paint();
      handle.setWaiting(waitingCache);
    },

    setStopped(s) {
      if (s === stopped) return;
      stopped = s;
      const c = new THREE.Color(s ? LOOK.blocked : LOOK.quiet);
      boundaryU.uColor.value.copy(c);
      boundaryU.uW.value = s ? 0.02 : 0.011;
      tickU.uColor.value.copy(c);
      gemMat.color.set(s ? 0x3a2626 : 0xcfdeee);
      gemMat.emissive.set(s ? 0x000000 : 0x2a4058);
      gemEdgeMat.color.set(s ? LOOK.blocked : LOOK.bright);
      gemGlow.material.opacity = s ? 0.05 : 0.3;
      dome.visible = s;
      domeT = s && motion ? 0 : 1;
      domeU.strength.value = s ? (motion ? 0 : 0.55) : 0;
      paint();
    },

    setMotion(on) {
      motion = on;
      for (const r of rings) r.u.uSheen.value = on ? 1 : 0;
      needsRender = true;
    },

    setInsets(left, right) {
      insets = { left, right };
      applyView();
    },

    setSelected(id) {
      if (id === selected) return;
      selected = id;
      paint();
    },

    setWaiting(list) {
      waitingCache = list;
      for (const m of markers) {
        m.material.dispose();
        m.removeFromParent();
      }
      // One marker per port, a little larger for each extra wait, so a queue stays one light.
      const byPort = new Map<string, { at: THREE.Vector3; n: number }>();
      for (const w of list) {
        const at = portFor(w.payee, ringOf(w.warrantId));
        const key = `${at.x.toFixed(2)},${at.z.toFixed(2)}`;
        const hit = byPort.get(key);
        if (hit) hit.n++;
        else byPort.set(key, { at, n: 1 });
      }
      markers = [...byPort.values()].map(({ at, n }) => {
        const s = sprite(LOOK.waiting, 0.26, 0.9);
        s.position.copy(at);
        s.userData.size = 0.26 * (1 + Math.min(0.6, Math.log2(n) * 0.15));
        world.add(s);
        return s;
      });
      needsRender = true;
    },

    fire(shot, delayMs) {
      window.setTimeout(() => launch(shot), motion ? delayMs : 0);
    },

    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("dblclick", onHome);
      window.removeEventListener("pointermove", onTilt);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      tex.dispose();
      bgTex.dispose();
      bloom.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelLayer.replaceChildren();
    },
  };

  // Double-click flies the camera home after the viewer has turned it.
  let flight: { from: THREE.Vector3; t: number } | null = null;
  const onHome = () => {
    if (motion) flight = { from: camera.position.clone(), t: 0 };
    else camera.position.copy(HOME);
    needsRender = true;
  };

  // Comets, ripples on the floor, sparks where a block hit the boundary.
  interface Comet {
    pts: THREE.Vector3[];
    head: THREE.Sprite;
    tail: THREE.Sprite[];
    stopAt: number;
    port: number;
    fate: Fate;
    t: number;
    fade: number;
    crossed: boolean;
    gate: Gate | undefined;
    color: THREE.Color;
  }
  interface Ripple {
    mesh: THREE.Mesh;
    t: number;
  }
  interface Spark {
    s: THREE.Sprite;
    v: THREE.Vector3;
    t: number;
  }
  const comets: Comet[] = [];
  const ripples: Ripple[] = [];
  const sparks: Spark[] = [];

  const ripple = (at: THREE.Vector3, color: THREE.Color | number, size = 1) => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.03 * size, 0.042 * size, 64),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(at).setY(0.01);
    world.add(mesh);
    ripples.push({ mesh, t: 0 });
  };

  const spark = (at: THREE.Vector3) => {
    const out = at.clone().setY(0).normalize();
    for (let i = 0; i < 16; i++) {
      const s = sprite(LOOK.blocked, 0.07, 1);
      s.position.copy(at);
      const v = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(0.6)
        .addScaledVector(out, -0.4);
      v.y = Math.abs(v.y) * 0.8;
      world.add(s);
      sparks.push({ s, v, t: 0 });
    }
  };

  function launch(shot: Shot) {
    const r = ringOf(shot.warrantId);
    if (!r) return;
    const share = r.u.uShare.value;
    const tip = onCircle(r.radius, share, 0.03);
    const gate = gateOf(shot.payee);
    const port = portFor(shot.payee, r);
    const portShare = gate ? gate.share : share;
    // Turn the shorter way round from the tip to the port.
    let delta = portShare - share;
    if (delta > 0.5) delta -= 1;
    if (delta < -0.5) delta += 1;
    const mid = onCircle((r.radius + rb) / 2, share + delta / 2, 0.35);
    const end = gate ? gate.pos.clone().setY(0.36) : onCircle(rp, portShare, 0.2);
    const pts = new THREE.CatmullRomCurve3([tip, mid, port, end], false, "centripetal").getPoints(
      SAMPLES,
    );
    let portAt = pts.findIndex((p) => Math.hypot(p.x, p.z) >= rb - 0.005);
    if (portAt < 0) portAt = SAMPLES;
    const color =
      shot.fate === "paid"
        ? r.tint.clone().lerp(white, 0.35)
        : new THREE.Color(shot.fate === "blocked" ? LOOK.blocked : LOOK.waiting);
    const head = sprite(color, 0.2, 1);
    head.position.copy(tip);
    world.add(head);
    const tail = Array.from({ length: LOOK.trail }, (_, k) => {
      const s = sprite(color, 0.15 * (1 - k / LOOK.trail) + 0.03, 0);
      s.position.copy(tip);
      world.add(s);
      return s;
    });
    flash = 1;
    flashColor = shot.fate === "blocked" ? new THREE.Color(LOOK.blocked) : r.tint.clone();
    comets.push({
      pts,
      head,
      tail,
      stopAt: shot.fate === "paid" ? SAMPLES : portAt,
      port: portAt,
      fate: shot.fate,
      t: motion ? 0 : 1,
      fade: 0,
      crossed: false,
      gate: shot.fate === "paid" ? gate : undefined,
      color,
    });
  }

  // Picking on the floor: the ring nearest the pointer, by distance from the centre.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  let downAt: { x: number; y: number } | null = null;
  const pick = (e: PointerEvent): string | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(floorPlane, hitPoint)) return null;
    world.worldToLocal(hitPoint);
    const d = Math.hypot(hitPoint.x, hitPoint.z);
    let best: Ring | null = null;
    for (const r of rings) {
      const off = Math.abs(d - r.radius);
      if (off < LOOK.ringGap * 0.45 && (!best || off < Math.abs(d - best.radius))) best = r;
    }
    return best?.id ?? null;
  };
  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) onSelect(pick(e));
    downAt = null;
  };
  const onMove = (e: PointerEvent) => {
    if (e.buttons) return;
    const h = pick(e);
    if (h !== hovered) {
      hovered = h;
      renderer.domElement.style.cursor = h ? "pointer" : "";
      paint();
    }
  };
  const tilt = new THREE.Vector2();
  const onTilt = (e: PointerEvent) => {
    tilt.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  renderer.domElement.addEventListener("pointermove", onMove);
  renderer.domElement.addEventListener("dblclick", onHome);
  window.addEventListener("pointermove", onTilt);
  controls.addEventListener("change", () => {
    needsRender = true;
  });

  let insets = { left: 0, right: 0 };
  function applyView() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    // Shift the picture so the core sits in the middle of the uncovered space.
    camera.setViewOffset(w, h, (insets.right - insets.left) / 2, 0, w, h);
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  const ro = new ResizeObserver(applyView);
  ro.observe(host);

  const tmp = new THREE.Vector3();
  const place = (el: HTMLElement, at: THREE.Vector3, anchor = "") => {
    tmp.copy(at);
    world.localToWorld(tmp);
    tmp.project(camera);
    const x = (tmp.x * 0.5 + 0.5) * host.clientWidth;
    const y = (-tmp.y * 0.5 + 0.5) * host.clientHeight;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)${anchor}`;
  };

  // Frame budget: full rate while something moves, 30 fps for the slow sheen, nothing at all
  // when still. Pixel density steps down if frames run long.
  let raf = 0;
  let lastRender = 0;
  let slow = 0;
  let clock = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    const easing = rings.some((r) => Math.abs(r.target - r.u.uShare.value) > 0.0005);
    const busy =
      comets.length > 0 ||
      ripples.length > 0 ||
      sparks.length > 0 ||
      flight !== null ||
      easing ||
      flash > 0 ||
      domeT < 1 ||
      gates.some((g) => g.flash > 0 || g.portFlash > 0);
    const ambient = motion && (!stopped || markers.length > 0);
    if (!busy && !needsRender && !ambient) return;
    if (!busy && !needsRender && now - lastRender < 33) return;
    const step = lastRender ? Math.min(0.05, (now - lastRender) / 1000) : 1 / 60;
    lastRender = now;
    needsRender = false;
    clock += step;

    if (flight) {
      flight.t = Math.min(1, flight.t + step / 0.9);
      camera.position.copy(flight.from).lerp(HOME, ease(flight.t));
      if (flight.t >= 1) flight = null;
    }
    controls.update();

    if (motion) {
      const k = Math.min(1, step * 2.5);
      world.rotation.y += (tilt.x * 0.06 - world.rotation.y) * k;
      world.rotation.x += (tilt.y * 0.02 - world.rotation.x) * k;
      if (!stopped) gem.rotation.y += step * 0.35;
    }

    for (const r of rings) {
      r.u.uTime.value = clock;
      const d = r.target - r.u.uShare.value;
      if (Math.abs(d) > 0.0005) r.u.uShare.value += d * Math.min(1, step * (motion ? 2.2 : 60));
      else r.u.uShare.value = r.target;
    }
    if (flash > 0) {
      flash = Math.max(0, flash - step * 2.2);
      gemGlow.material.color.copy(flashColor);
      gemGlow.material.opacity = (stopped ? 0.05 : 0.3) + flash * 0.6;
    }
    if (domeT < 1) {
      domeT = Math.min(1, domeT + step / 0.7);
      domeU.strength.value = ease(domeT) * 0.55;
    }
    const breathe = motion ? 1 + Math.sin(now / 280) * 0.22 : 1;
    for (const m of markers) m.scale.setScalar((m.userData.size as number) * breathe);

    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      if (!c) continue;
      const total = c.stopAt / SAMPLES;
      c.t = Math.min(total, c.t + step / LOOK.cometSeconds);
      const head = Math.round(ease(Math.min(1, c.t / Math.max(total, 1e-6))) * c.stopAt);
      const at = c.pts[Math.min(head, SAMPLES)];
      if (at) c.head.position.copy(at);
      c.tail.forEach((s, j) => {
        const p = c.pts[Math.max(0, head - (j + 1) * 2)];
        if (p) s.position.copy(p);
        s.material.opacity = motion ? (1 - j / c.tail.length) * 0.7 * (1 - c.fade) : 0;
      });
      if (!c.crossed && head >= c.port) {
        c.crossed = true;
        const p = c.pts[c.port];
        if (p) {
          if (c.fate === "blocked") {
            ripple(p, LOOK.blocked, 1.5);
            if (motion) spark(p);
          } else if (c.fate === "asked") ripple(p, LOOK.waiting, 1.3);
          else ripple(p, c.color, 0.8);
          const gate = gates.find((g) => g.port.distanceTo(p) < 0.15);
          if (gate) {
            gate.portFlash = 1;
            gate.portColor = c.color.clone();
          }
        }
      }
      if (c.t >= total) {
        if (c.fade === 0 && c.gate) {
          c.gate.flash = 1;
          ripple(c.gate.pos, c.color, 1.1);
        }
        c.fade += step / (c.fate === "paid" ? 0.5 : 1.2);
        c.head.material.opacity = Math.max(0, 1 - c.fade);
        if (c.fade >= 1) {
          for (const s of [c.head, ...c.tail]) {
            s.material.dispose();
            world.remove(s);
          }
          comets.splice(i, 1);
        }
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      if (!r) continue;
      r.t += step / 0.9;
      r.mesh.scale.setScalar(1 + ease(Math.min(1, r.t)) * 5);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - r.t);
      if (r.t >= 1) {
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        world.remove(r.mesh);
        ripples.splice(i, 1);
      }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      if (!s) continue;
      s.t += step / 0.65;
      s.s.position.addScaledVector(s.v, step);
      s.v.multiplyScalar(0.93);
      s.v.y -= step * 0.6;
      s.s.material.opacity = Math.max(0, 1 - s.t);
      if (s.t >= 1) {
        s.s.material.dispose();
        world.remove(s.s);
        sparks.splice(i, 1);
      }
    }
    for (const g of gates) {
      if (g.flash > 0) g.flash = Math.max(0, g.flash - step * 1.4);
      if (g.portFlash > 0) g.portFlash = Math.max(0, g.portFlash - step * 1.1);
      g.top.scale.setScalar(0.3 * (1 + g.flash * 1.4));
      if (g.portFlash > 0) g.portDot.material.color.copy(g.portColor);
      else g.portDot.material.color.set(LOOK.quiet);
      g.portDot.scale.setScalar(0.12 * (1 + g.portFlash * 2));
    }

    // Ring names sit just left of 12 o'clock, where each arc starts.
    for (const r of rings) place(r.label, onCircle(r.radius, 0, 0.02), " translate(-100%, -50%)");
    for (const g of gates) place(g.label, g.pos);

    if (busy && step > 1 / 40) slow++;
    else slow = Math.max(0, slow - 1);
    if (slow > 90 && dpr > 1) {
      dpr = Math.max(1, dpr - 0.25);
      renderer.setPixelRatio(dpr);
      applyView();
      slow = 0;
    }
    composer.render();
  };
  raf = requestAnimationFrame(frame);
  return handle;
}
