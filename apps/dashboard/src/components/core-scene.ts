import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Fate } from "../flow.js";

/**
 * The page's scene, in plain three.js (SceneCanvas.tsx wraps it in React).
 *
 *   core   the signed warrant, a faceted crystal in the middle
 *   rings  one per agent, around the core; the lit arc is the share of its budget left
 *   shell  the warrant's boundary; payments leave through it or stop at it
 *   nodes  the payees, outside the shell
 *
 * Calm by default: grey-blue while everything is inside the limits. Colour only for a block
 * (red spark where it hit the shell), a payment waiting for the owner (amber, held at the
 * shell) and STOP (the shell seals red, rings freeze, the core goes dark).
 *
 * Every tunable number is in LOOK.
 */
export const LOOK = {
  quiet: 0x9fb4c8,
  bright: 0xdde8f3,
  dim: 0x2a3a4c,
  coreFill: 0x15212d,
  blocked: 0xff7a70,
  waiting: 0xe2ad5b,
  stoppedRing: 0x7a3a36,
  core: 0.3,
  shell: 1.2,
  payeeRx: 1.85,
  payeeRy: 1.45,
  ringSpin: 0.05,
  arcSeconds: 1.4,
  trail: 20,
  lowBudget: 0.2,
};

const SAMPLES = 90;
const HEAD: Record<Fate, number> = {
  paid: LOOK.bright,
  blocked: LOOK.blocked,
  asked: LOOK.waiting,
};
const LINE: Record<Fate, number> = { paid: LOOK.quiet, blocked: LOOK.blocked, asked: LOOK.waiting };

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

const FRESNEL_VERT = `
varying vec3 vN; varying vec3 vV;
void main() {
  vN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FRESNEL_FRAG = `
uniform vec3 color; uniform float power; uniform float strength;
varying vec3 vN; varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(vN, vV)), power);
  gl_FragColor = vec4(color, f * strength);
}`;

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.3, "rgba(255,255,255,0.6)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function createScene(
  host: HTMLElement,
  labelLayer: HTMLElement,
  onSelect: (warrantId: string | null) => void,
): SceneHandle {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  const maxDpr = Math.min(2, window.devicePixelRatio || 1);
  let dpr = maxDpr;
  renderer.setPixelRatio(dpr);
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  /** Where the camera starts, and returns to when nothing is selected. */
  const HOME = new THREE.Vector3(0, 1.1, 5.6);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 3.2;
  controls.maxDistance = 9;
  const tex = glowTexture();

  /** Everything that tilts with the pointer. */
  const world = new THREE.Group();
  scene.add(world);

  const sprite = (color: number, scale: number, opacity = 1) => {
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

  // Dust far out, for depth only.
  {
    const n = 420;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(3 + Math.random() * 5);
      pos.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    world.add(
      new THREE.Points(
        g,
        new THREE.PointsMaterial({
          color: LOOK.quiet,
          size: 0.02,
          map: tex,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
        }),
      ),
    );
  }

  // The core.
  const core = new THREE.Group();
  const coreGeo = new THREE.IcosahedronGeometry(LOOK.core, 0);
  const coreFill = new THREE.MeshBasicMaterial({
    color: LOOK.coreFill,
    transparent: true,
    opacity: 0.92,
  });
  const coreEdges = new THREE.LineBasicMaterial({
    color: LOOK.bright,
    transparent: true,
    opacity: 0.85,
  });
  const coreGlow = sprite(LOOK.quiet, 1.1, 0.28);
  const outerWire = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(LOOK.core * 1.45, 1)),
    new THREE.LineBasicMaterial({ color: LOOK.quiet, transparent: true, opacity: 0.12 }),
  );
  core.add(
    coreGlow,
    new THREE.Mesh(coreGeo, coreFill),
    new THREE.LineSegments(new THREE.EdgesGeometry(coreGeo), coreEdges),
    outerWire,
  );
  world.add(core);
  let coreFlash = 0;
  let coreFlashColor = new THREE.Color(LOOK.quiet);

  // The shell.
  const shellColor = new THREE.Color(LOOK.quiet);
  const shellStrength = { value: 0.32 };
  const shellMat = new THREE.ShaderMaterial({
    uniforms: {
      color: { value: shellColor },
      power: { value: 2.6 },
      strength: shellStrength,
    },
    vertexShader: FRESNEL_VERT,
    fragmentShader: FRESNEL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const shellWireMat = new THREE.LineBasicMaterial({
    color: LOOK.quiet,
    transparent: true,
    opacity: 0.035,
  });
  world.add(
    new THREE.Mesh(new THREE.SphereGeometry(LOOK.shell, 72, 72), shellMat),
    new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(LOOK.shell, 4)),
      shellWireMat,
    ),
  );

  // Agents (rings) and payees (nodes), rebuilt by setNodes when the set changes.
  interface Ring {
    id: string;
    pivot: THREE.Group;
    spin: THREE.Group;
    radius: number;
    lit: THREE.Mesh;
    litMat: THREE.MeshBasicMaterial;
    trackMat: THREE.MeshBasicMaterial;
    hit: THREE.Mesh;
    bead: THREE.Group;
    beadGlow: THREE.Sprite;
    shown: number;
    built: number;
    target: number;
    label: HTMLElement;
  }
  interface Node {
    id: string;
    pos: THREE.Vector3;
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    glow: THREE.Sprite;
    label: HTMLElement;
    flash: number;
  }
  let rings: Ring[] = [];
  let nodes: Node[] = [];
  const nodeGroup = new THREE.Group();
  world.add(nodeGroup);

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

  const arcGeometry = (radius: number, share: number) =>
    new THREE.TorusGeometry(
      radius,
      0.016,
      8,
      Math.max(8, Math.round(180 * share)),
      Math.max(0.0001, Math.PI * 2 * share),
    );

  let stopped = false;
  let motion = true;
  let selected: string | null = null;
  let hovered: string | null = null;
  let needsRender = true;

  const ringColor = (r: Ring) =>
    stopped ? LOOK.stoppedRing : r.target < LOOK.lowBudget ? LOOK.waiting : LOOK.quiet;

  const paintRings = () => {
    for (const r of rings) {
      const focus = selected === null || selected === r.id;
      const lit = !stopped && (selected === r.id || hovered === r.id);
      r.litMat.color.set(lit ? LOOK.bright : ringColor(r));
      r.litMat.opacity = focus ? 0.95 : 0.3;
      r.trackMat.opacity = focus ? 0.55 : 0.2;
      r.beadGlow.material.opacity = focus ? 0.9 : 0.25;
      r.label.classList.toggle("is-dim", !focus);
      r.label.classList.toggle("is-on", selected === r.id);
    }
    needsRender = true;
  };

  const placeBead = (r: Ring) => {
    const a = Math.PI * 2 * r.shown;
    r.bead.position.set(Math.cos(a) * r.radius, Math.sin(a) * r.radius, 0);
  };

  // Waiting markers: payments held at the shell for the owner.
  interface Marker {
    id: string;
    sprite: THREE.Sprite;
    dir: THREE.Vector3;
  }
  let markers: Marker[] = [];
  let waitingCache: Waiting[] = [];

  const ringOf = (id: string | undefined) => rings.find((r) => r.id === id);
  const nodeOf = (id: string | undefined) => nodes.find((n) => n.id === id);
  const beadWorld = (r: Ring) => r.bead.getWorldPosition(new THREE.Vector3());

  const handle: SceneHandle = {
    setNodes(agents, payees) {
      const same = agents.length === rings.length && agents.every((a, i) => rings[i]?.id === a.id);
      if (same) {
        agents.forEach((a, i) => {
          const r = rings[i];
          if (!r) return;
          r.target = a.left;
          const lbl = r.label.querySelector(".sc-name");
          if (lbl) lbl.textContent = a.name;
        });
      } else {
        for (const r of rings) {
          r.label.remove();
          r.pivot.removeFromParent();
        }
        const n = agents.length;
        rings = agents.map((a, i) => {
          const radius = n > 1 ? 0.5 + (i * 0.46) / (n - 1) : 0.72;
          const pivot = new THREE.Group();
          pivot.rotation.set(Math.PI / 2 - 0.42 + i * 0.5, i * 0.95, 0);
          const spin = new THREE.Group();
          spin.rotation.z = i * 1.9;
          const trackMat = new THREE.MeshBasicMaterial({
            color: LOOK.dim,
            transparent: true,
            opacity: 0.55,
          });
          const track = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.005, 6, 200), trackMat);
          const litMat = new THREE.MeshBasicMaterial({
            color: LOOK.quiet,
            transparent: true,
            opacity: 0.95,
          });
          const lit = new THREE.Mesh(arcGeometry(radius, a.left), litMat);
          const hit = new THREE.Mesh(
            new THREE.TorusGeometry(radius, 0.07, 6, 64),
            new THREE.MeshBasicMaterial({ visible: false }),
          );
          hit.userData["warrantId"] = a.id;
          const bead = new THREE.Group();
          const beadGlow = sprite(LOOK.bright, 0.22, 0.9);
          bead.add(
            new THREE.Mesh(
              new THREE.OctahedronGeometry(0.035),
              new THREE.MeshBasicMaterial({ color: LOOK.bright }),
            ),
            beadGlow,
          );
          spin.add(track, lit, hit, bead);
          pivot.add(spin);
          world.add(pivot);
          const ring: Ring = {
            id: a.id,
            pivot,
            spin,
            radius,
            lit,
            litMat,
            trackMat,
            hit,
            bead,
            beadGlow,
            shown: a.left,
            built: a.left,
            target: a.left,
            label: makeLabel("sc-agent", a.name),
          };
          placeBead(ring);
          return ring;
        });
      }

      const sameNodes =
        payees.length === nodes.length && payees.every((p, i) => nodes[i]?.id === p.id);
      if (sameNodes) {
        payees.forEach((p, i) => {
          const nd = nodes[i];
          if (!nd) return;
          const lbl = nd.label.querySelector(".sc-sub");
          if (lbl) lbl.textContent = p.sub;
          nd.mat.color.set(p.paid ? LOOK.bright : LOOK.quiet);
          nd.glow.material.opacity = p.paid ? 0.6 : 0.2;
        });
      } else {
        for (const nd of nodes) nd.label.remove();
        nodeGroup.clear();
        const m = payees.length;
        nodes = payees.map((p, k) => {
          const a =
            Math.PI / 2 - ((k + 0.5) * Math.PI * 2) / Math.max(1, m) + Math.PI / Math.max(1, m);
          const pos = new THREE.Vector3(
            Math.cos(a) * LOOK.payeeRx,
            Math.sin(a) * LOOK.payeeRy,
            -0.15,
          );
          const mat = new THREE.MeshBasicMaterial({ color: p.paid ? LOOK.bright : LOOK.quiet });
          const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.055), mat);
          mesh.position.copy(pos);
          const glow = sprite(LOOK.quiet, 0.35, p.paid ? 0.6 : 0.2);
          glow.position.copy(pos);
          nodeGroup.add(mesh, glow);
          return {
            id: p.id,
            pos,
            mesh,
            mat,
            glow,
            label: makeLabel("sc-payee", p.name, p.sub),
            flash: 0,
          };
        });
      }
      paintRings();
      handle.setWaiting(waitingCache);
    },

    setStopped(s) {
      stopped = s;
      const c = new THREE.Color(s ? LOOK.blocked : LOOK.quiet);
      shellColor.copy(c);
      shellStrength.value = s ? 0.95 : 0.32;
      shellWireMat.color.copy(c);
      shellWireMat.opacity = s ? 0.12 : 0.035;
      coreEdges.color.set(s ? LOOK.blocked : LOOK.bright);
      coreEdges.opacity = s ? 0.55 : 0.85;
      coreGlow.material.opacity = s ? 0.04 : 0.28;
      paintRings();
    },

    setMotion(on) {
      motion = on;
      needsRender = true;
    },

    setInsets(left, right) {
      insets = { left, right };
      applyView();
    },

    setSelected(id) {
      if (id === selected) return;
      selected = id;
      paintRings();
      const r = ringOf(id ?? undefined);
      if (!r) flyTo(HOME);
      else {
        // Look straight down the ring's axis, from the side the camera is already on.
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(
          r.pivot.getWorldQuaternion(new THREE.Quaternion()),
        );
        if (normal.dot(camera.position) < 0) normal.negate();
        flyTo(normal);
      }
    },

    setWaiting(list) {
      waitingCache = list;
      const before = new Set(markers.map((m) => m.id));
      for (const m of markers) m.sprite.removeFromParent();
      markers = list.map((w) => {
        const owner = ringOf(w.warrantId);
        const target = nodeOf(w.payee)?.pos ?? (owner ? beadWorld(owner) : null);
        const dir = (target?.clone() ?? new THREE.Vector3(1, 0.3, 0.4)).normalize();
        const s = sprite(LOOK.waiting, 0.26, 1);
        s.position.copy(dir.clone().multiplyScalar(LOOK.shell));
        world.add(s);
        return { id: w.id, sprite: s, dir };
      });
      // Turn once to face something new that needs the owner.
      const fresh = markers.find((m) => !before.has(m.id));
      if (fresh && before.size + 1 >= markers.length && motion && selected === null)
        flyTo(fresh.dir);
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
      renderer.dispose();
      renderer.domElement.remove();
      labelLayer.replaceChildren();
    },
  };

  // Camera flights, caused by the owner (a click, a key) or by one new approval.
  let flight: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null = null;
  function flyTo(dir: THREE.Vector3) {
    const dist = camera.position.length();
    const to = dir.clone().normalize().multiplyScalar(dist);
    if (!motion) {
      camera.position.copy(to);
      needsRender = true;
      return;
    }
    flight = { from: camera.position.clone(), to, t: 0 };
  }

  // Payments in flight, ripples on the shell, sparks where a block hit.
  interface Arc {
    line: THREE.Line;
    head: THREE.Sprite;
    pts: THREE.Vector3[];
    stopAt: number;
    hit: number;
    fate: Fate;
    t: number;
    fade: number;
    crossed: boolean;
    node: Node | undefined;
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
  const arcs: Arc[] = [];
  const ripples: Ripple[] = [];
  const sparks: Spark[] = [];

  const ripple = (at: THREE.Vector3, color: number, size = 1) => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.02 * size, 0.03 * size, 48),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.position.copy(at);
    mesh.lookAt(at.clone().multiplyScalar(2));
    world.add(mesh);
    ripples.push({ mesh, t: 0 });
  };

  const spark = (at: THREE.Vector3) => {
    const out = at.clone().normalize();
    for (let i = 0; i < 14; i++) {
      const s = sprite(LOOK.blocked, 0.06, 1);
      s.position.copy(at);
      const v = new THREE.Vector3()
        .randomDirection()
        .multiplyScalar(0.5)
        .addScaledVector(out, -0.35);
      world.add(s);
      sparks.push({ s, v, t: 0 });
    }
  };

  function launch(shot: Shot) {
    const r = ringOf(shot.warrantId);
    if (!r) return;
    const start = world.worldToLocal(beadWorld(r));
    const nd = nodeOf(shot.payee);
    const end = nd?.pos.clone() ?? start.clone().normalize().multiplyScalar(LOOK.payeeRx);
    const ctrl = start.clone().add(end).multiplyScalar(0.5);
    ctrl.setLength(Math.max(ctrl.length(), 0.8) * 1.3);
    const pts = new THREE.QuadraticBezierCurve3(start, ctrl, end).getPoints(SAMPLES);
    let hit = pts.findIndex((p) => p.length() >= LOOK.shell);
    if (hit < 0) hit = SAMPLES;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({
        color: LINE[shot.fate],
        transparent: true,
        opacity: shot.fate === "paid" ? 0.55 : 0.95,
        blending: THREE.AdditiveBlending,
      }),
    );
    line.geometry.setDrawRange(0, 0);
    const head = sprite(HEAD[shot.fate], shot.fate === "paid" ? 0.12 : 0.17);
    head.position.copy(start);
    world.add(line, head);
    coreFlash = 1;
    coreFlashColor = new THREE.Color(shot.fate === "blocked" ? LOOK.blocked : LOOK.quiet);
    arcs.push({
      line,
      head,
      pts,
      stopAt: shot.fate === "paid" ? SAMPLES : hit,
      hit,
      fate: shot.fate,
      t: motion ? 0 : 1,
      fade: 0,
      crossed: false,
      node: shot.fate === "paid" ? nd : undefined,
    });
  }

  // Picking: a click (not a drag) on a ring selects its agent; on empty space clears.
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt: { x: number; y: number } | null = null;
  const pick = (e: PointerEvent): string | null => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(
      rings.map((r) => r.hit),
      false,
    )[0];
    return (hit?.object.userData["warrantId"] as string | undefined) ?? null;
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
      paintRings();
    }
  };
  // Pointer tilt: the scene leans a little toward the cursor.
  const tilt = new THREE.Vector2();
  const onTilt = (e: PointerEvent) => {
    tilt.set((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1);
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  renderer.domElement.addEventListener("pointermove", onMove);
  window.addEventListener("pointermove", onTilt);
  controls.addEventListener("change", () => {
    needsRender = true;
  });

  let insets = { left: 0, right: 0 };
  function applyView() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    // Shift the picture so the core sits in the middle of the uncovered space.
    camera.setViewOffset(w, h, (insets.right - insets.left) / 2, 0, w, h);
    camera.updateProjectionMatrix();
    needsRender = true;
  }
  const ro = new ResizeObserver(applyView);
  ro.observe(host);

  const tmp = new THREE.Vector3();
  const place = (el: HTMLElement, at: THREE.Vector3) => {
    tmp.copy(at).project(camera);
    const x = (tmp.x * 0.5 + 0.5) * host.clientWidth;
    const y = (-tmp.y * 0.5 + 0.5) * host.clientHeight;
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  };

  // Frame budget: full rate while something moves, 30 fps for the slow ambient spin, nothing
  // at all when still. Pixel density steps down if frames run long.
  let raf = 0;
  let last = performance.now();
  let lastRender = 0;
  let slow = 0;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const lerping = rings.some((r) => Math.abs(r.target - r.shown) > 0.0005);
    const busy =
      arcs.length > 0 ||
      ripples.length > 0 ||
      sparks.length > 0 ||
      flight !== null ||
      lerping ||
      coreFlash > 0;
    const ambient = motion && !stopped;
    const breathing = markers.length > 0 && motion;
    if (!busy && !needsRender && !ambient && !breathing) return;
    if (!busy && !needsRender && now - lastRender < 33) return;
    const step = Math.min(0.05, (now - (lastRender || now)) / 1000) || dt;
    lastRender = now;
    needsRender = false;

    if (flight) {
      flight.t = Math.min(1, flight.t + step / 0.9);
      const e = ease(flight.t);
      const len = flight.from.length();
      camera.position.copy(flight.from).lerp(flight.to, e).setLength(len);
      if (flight.t >= 1) flight = null;
    }
    controls.update();

    if (motion) {
      world.rotation.y += (tilt.x * 0.08 - world.rotation.y) * Math.min(1, step * 3);
      world.rotation.x += (tilt.y * 0.05 - world.rotation.x) * Math.min(1, step * 3);
    }

    if (ambient) {
      core.rotation.y += step * 0.12;
      outerWire.rotation.y -= step * 0.2;
      for (const r of rings) r.spin.rotation.z += step * LOOK.ringSpin;
    }
    for (const r of rings) {
      if (Math.abs(r.target - r.shown) > 0.0005) {
        r.shown += (r.target - r.shown) * Math.min(1, step * 2.5);
        if (Math.abs(r.shown - r.built) > 0.003 || Math.abs(r.target - r.shown) <= 0.0005) {
          r.lit.geometry.dispose();
          r.lit.geometry = arcGeometry(r.radius, r.shown);
          r.built = r.shown;
        }
        placeBead(r);
      }
    }
    if (coreFlash > 0) {
      coreFlash = Math.max(0, coreFlash - step * 2.5);
      coreGlow.material.color.copy(coreFlashColor);
      coreGlow.material.opacity = (stopped ? 0.04 : 0.28) + coreFlash * 0.5;
    }
    for (const m of markers) {
      const k = motion ? 1 + Math.sin(now / 260) * 0.2 : 1;
      m.sprite.scale.setScalar(0.26 * k);
    }

    for (let i = arcs.length - 1; i >= 0; i--) {
      const a = arcs[i];
      if (!a) continue;
      const total = a.stopAt / SAMPLES;
      a.t = Math.min(total, a.t + step / LOOK.arcSeconds);
      const head = Math.round(ease(Math.min(1, a.t / Math.max(total, 1e-6))) * a.stopAt);
      const from = motion ? Math.max(0, head - LOOK.trail) : 0;
      a.line.geometry.setDrawRange(from, Math.max(0, head - from + 1));
      const at = a.pts[Math.min(head, SAMPLES)];
      if (at) a.head.position.copy(at);
      if (!a.crossed && head >= a.hit) {
        a.crossed = true;
        const p = a.pts[a.hit];
        if (p) {
          if (a.fate === "blocked") {
            ripple(p, LOOK.blocked, 1.4);
            if (motion) spark(p);
          } else if (a.fate === "asked") ripple(p, LOOK.waiting, 1.2);
          else ripple(p, LOOK.quiet, 0.7);
        }
      }
      if (a.t >= total) {
        if (a.fade === 0 && a.node) a.node.flash = 1;
        a.fade += step / (a.fate === "paid" ? 0.7 : 1.4);
        const o = Math.max(0, 1 - a.fade);
        (a.line.material as THREE.LineBasicMaterial).opacity =
          o * (a.fate === "paid" ? 0.55 : 0.95);
        a.head.material.opacity = o;
        if (a.fade >= 1) {
          a.line.geometry.dispose();
          (a.line.material as THREE.Material).dispose();
          a.head.material.dispose();
          world.remove(a.line, a.head);
          arcs.splice(i, 1);
        }
      }
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      if (!r) continue;
      r.t += step / 0.8;
      r.mesh.scale.setScalar(1 + r.t * 5);
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
      s.t += step / 0.6;
      s.s.position.addScaledVector(s.v, step);
      s.v.multiplyScalar(0.94);
      s.s.material.opacity = Math.max(0, 1 - s.t);
      if (s.t >= 1) {
        s.s.material.dispose();
        world.remove(s.s);
        sparks.splice(i, 1);
      }
    }
    for (const nd of nodes) {
      if (nd.flash > 0) nd.flash = Math.max(0, nd.flash - step * 1.5);
      nd.glow.scale.setScalar(0.35 * (1 + nd.flash * 1.6));
    }

    for (const r of rings) place(r.label, beadWorld(r));
    for (const nd of nodes) place(nd.label, nd.mesh.getWorldPosition(tmp.clone()));

    // Frames that run long, three seconds in a row: step the pixel density down.
    if (busy && step > 1 / 40) slow++;
    else slow = Math.max(0, slow - 1);
    if (slow > 90 && dpr > 1) {
      dpr = Math.max(1, dpr - 0.25);
      renderer.setPixelRatio(dpr);
      slow = 0;
    }
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);
  return handle;
}
