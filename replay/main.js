import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
// Replay data is Z-up with the ice in the x/y plane; three.js is Y-up.
const v3 = (x, y, z) => new THREE.Vector3(x, z, -y);
const UP = new THREE.Vector3(0, 1, 0);
const HOLD_MS = 2000;
const FRESH = { cache: 'no-cache' };  // replays are rebuilt in place; always revalidate          // auto-pause on each coach note
const TAP_MS = 250;            // a press shorter than this without dragging is a tap
const TAP_PX = 8;

const state = {
  replay: null, skaters: [], frame: 0, nFrames: 1, fps: 60,
  playing: false, speed: 0.25, follow: true, showVideo: true, showLabels: true,
  cameraView: false, bodyMode: 'both',
  jumpDir: new THREE.Vector3(1, 0, 0), notes: [], activeNote: null, hold: null,
};

// ---------- renderer, scene, camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const SKY = new THREE.Color(0x0b1322);
const FOG = new THREE.Fog(0x0b1322, 22, 60);
scene.background = SKY;
scene.fog = FOG;

const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 300);
camera.position.set(0, 1.6, 7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.maxPolarAngle = Math.PI * 0.497;
controls.minDistance = 0.8;
controls.maxDistance = 45;
controls.target.set(0, 1, 0);

scene.add(new THREE.HemisphereLight(0xdbeafe, 0x1e293b, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 0.5, far: 40 });
scene.add(sun, sun.target);
const rim = new THREE.DirectionalLight(0x67e8f9, 0.8);
scene.add(rim);

const rink = new THREE.Group();
// Catches the skater's shadow on the real ice when the filming camera's footage is behind the scene.
const shadowCatcher = new THREE.Mesh(new THREE.PlaneGeometry(60, 30), new THREE.ShadowMaterial({ opacity: 0.35 }));
shadowCatcher.rotation.x = -Math.PI / 2;
shadowCatcher.receiveShadow = true;
shadowCatcher.visible = false;
scene.add(rink, shadowCatcher);

function buildRink() {
  const ice = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 30),
    new THREE.MeshStandardMaterial({ color: 0x16243a, roughness: 0.7, metalness: 0.0 }),
  );
  ice.rotation.x = -Math.PI / 2;
  ice.receiveShadow = true;
  rink.add(ice);
  const grid = new THREE.GridHelper(60, 60, 0x2b4a6b, 0x1f3550);
  grid.position.y = 0.001;
  rink.add(grid);
  const fine = new THREE.GridHelper(12, 48, 0x23405e, 0x1c3049);
  fine.position.y = 0.0015;
  fine.material.transparent = true;
  fine.material.opacity = 0.6;
  rink.add(fine);
}
buildRink();

// ---------- skater rendering ----------
const sphereGeo = new THREE.SphereGeometry(1, 20, 14);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const TORSO = new Set(['l_shoulder-r_shoulder', 'l_hip-r_hip', 'l_shoulder-l_hip', 'r_shoulder-r_hip']);
const FOOT = /heel|toe/;
const hotMat = new THREE.MeshStandardMaterial({ color: 0xef4444, emissive: 0xef4444, emissiveIntensity: 0.8, roughness: 0.4 });
const haloMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false });

function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

// ---------- interpolation between frames ----------
// A triple spins 60-70 degrees per 25 fps frame. Straight-line interpolation of points between two frames cuts
// the chord of that arc, so the body shrinks and regrows between every pair of frames (a visible stutter).
// Instead, poses are interpolated in a frame that turns with the body: remove each frame's yaw about its centre,
// blend, then apply the blended yaw and centre.
// The blend is a Catmull-Rom cubic through four frames, not a straight line between two: in slow motion
// (0.25x shows each 60 fps frame for four screen frames) straight segments change speed at every data
// frame, which reads as a fine stutter; the cubic keeps the velocity continuous.
function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

function frameYaw(p, idx) {
  // Yaw (about +Y) of the left-right body axis from hips and shoulders, three.js coordinates.
  const ax = p[idx.l_hip].x - p[idx.r_hip].x + p[idx.l_shoulder].x - p[idx.r_shoulder].x;
  const az = p[idx.l_hip].z - p[idx.r_hip].z + p[idx.l_shoulder].z - p[idx.r_shoulder].z;
  return Math.atan2(az, ax);
}

function spinBlend(i, t, yaw, centre) {
  // Frames i-1, i, i+1, i+2 (clamped) with Catmull-Rom weights at t; yaws unwrapped along the chain.
  const n = yaw.length;
  const idx = [i - 1, i, i + 1, i + 2].map((m) => THREE.MathUtils.clamp(m, 0, n - 1));
  const t2 = t * t, t3 = t2 * t;
  const w = [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
  const y1 = yaw[idx[1]], y0 = y1 + wrapAngle(yaw[idx[0]] - y1), y2 = y1 + wrapAngle(yaw[idx[2]] - y1);
  const ys = [y0, y1, y2, y2 + wrapAngle(yaw[idx[3]] - yaw[idx[2]])];
  const yt = w[0] * ys[0] + w[1] * ys[1] + w[2] * ys[2] + w[3] * ys[3];
  const c = idx.map((m) => centre[m]);
  return { idx, w, c, cos: ys.map(Math.cos), sin: ys.map(Math.sin), cosT: Math.cos(-yt), sinT: Math.sin(-yt),
    cx: w.reduce((s, wk, k) => s + wk * c[k].x, 0), cz: w.reduce((s, wk, k) => s + wk * c[k].z, 0) };
}

function blendPoint(b, xs, ys, zs, out, o) {
  // xs, ys, zs: the point in the four frames. rotY(v, a): x' = x cos a + z sin a, z' = -x sin a + z cos a (removes yaw a).
  let rx = 0, rz = 0, y = 0;
  for (let k = 0; k < 4; k++) {
    const x1 = xs[k] - b.c[k].x, z1 = zs[k] - b.c[k].z;
    rx += b.w[k] * (x1 * b.cos[k] + z1 * b.sin[k]);
    rz += b.w[k] * (-x1 * b.sin[k] + z1 * b.cos[k]);
    y += b.w[k] * ys[k];
  }
  out[o] = rx * b.cosT + rz * b.sinT + b.cx;
  out[o + 2] = -rx * b.sinT + rz * b.cosT + b.cz;
  out[o + 1] = y;
}

// ---------- SAM 3D Body surface ----------
const HOT = new THREE.Color(0xef4444);
const bodyUniforms = { uPulse: { value: 0 }, uRim: { value: new THREE.Color(0x67e8f9) }, uHot: { value: HOT } };

// The body is dressed as a motion-capture suit, not bare skin: matte panels per segment (vertex colours),
// seam lines where segments meet, white skate boots, and a cyan Fresnel rim. Bone index -> panel:
const PANEL_OF_BONE = [0, 0, 0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 10, 10, 11, 11, 11, 11, 11];
const PANEL_HEAD = 1;
const PANEL_COLORS = [0x253043, 0x2b3446, 0x212a3a, 0x1e2736, 0x212a3a, 0x1e2736,  // torso, head, L/R arm
  0x1c2433, 0x1a2230, 0x1c2433, 0x1a2230, 0xe5eaf1, 0xe5eaf1].map((c) => new THREE.Color(c));  // legs, boots
const SUIT_INFLATE = 0.012;  // m of "fabric" over the body surface
const PANEL_HAIR = PANEL_COLORS.length;
PANEL_COLORS.push(new THREE.Color(0x3a2a20));  // dark brown hair
const BOOT_INFLATE = 0.018;  // the skate boot's leather is thicker and stiffer

function bodyMaterial() {
  // Vertices flagged "hot" (a coach note's segment) turn red and pulse.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.0,
    transparent: true, opacity: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, bodyUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float hot;\nvarying float vHot;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHot = hot;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPulse;\nuniform vec3 uRim;\nuniform vec3 uHot;\nvarying float vHot;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uHot, vHot);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float fres = pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.2);
        totalEmissiveRadiance += uRim * fres * 0.55 * (1.0 - vHot) + uHot * vHot * (0.35 + 0.55 * uPulse);`);
  };
  return mat;
}

class BodyMesh {
  // Per-frame SAM 3D Body vertices (int16 mm, replay coordinates), one shared triangle list, a bone label per vertex.
  constructor(header, buffer, bones) {
    const { frames: T, vertices: V, faces: F } = header;
    Object.assign(this, { T, V, bones });
    this.pos = new Int16Array(buffer, 0, T * V * 3);
    const off = T * V * 3 * 2;
    this.faces = new Uint16Array(buffer, off, F * 3);
    this.labels = new Uint8Array(buffer, off + F * 6, V);
    this.geo = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.hot = new THREE.BufferAttribute(new Float32Array(V), 1);
    this.geo.setAttribute('position', this.position);
    this.geo.setAttribute('hot', this.hot);
    this.geo.setIndex(new THREE.BufferAttribute(this.faces, 1));
    // Normals from the whole surface (the hair is drawn as a separate mesh over part of it).
    this.fullGeo = new THREE.BufferGeometry();
    this.fullGeo.setAttribute('position', this.position);
    this.fullGeo.setIndex(new THREE.BufferAttribute(this.faces, 1));
    this.panel = new Uint8Array(V);
    const color = new Float32Array(V * 3);
    for (let k = 0; k < V; k++) {
      const lab = this.labels[k];
      this.panel[k] = lab === 255 ? PANEL_HEAD : PANEL_OF_BONE[lab] ?? 0;
      const c = PANEL_COLORS[this.panel[k]];
      color.set([c.r, c.g, c.b], 3 * k);
    }
    this.geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    this.colors = color;
    this.inflate = new Float32Array(V).fill(SUIT_INFLATE);
    const seamGeo = new THREE.BufferGeometry();
    seamGeo.setAttribute('position', this.position);  // shared: seams move with the surface for free
    seamGeo.setIndex(this.seamIndex());
    this.seamMat = new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.7, depthWrite: false });
    this.seams = new THREE.LineSegments(seamGeo, this.seamMat);
    this.seams.renderOrder = 2;
    this.seams.frustumCulled = false;
    // A depth-only pass first, so the see-through surface shows only its front layer (no inner folds).
    this.depth = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true,
      polygonOffsetFactor: 1, polygonOffsetUnits: 2 }));
    this.mat = bodyMaterial();
    this.mat.depthWrite = false;
    this.mat.depthFunc = THREE.LessEqualDepth;
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.depth.renderOrder = 1;
    this.mesh.renderOrder = 2;
    this.mesh.castShadow = true;
    for (const m of [this.depth, this.mesh]) m.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.depth, this.mesh, this.seams);
    this.frame = -1;
  }

  seamIndex() {
    // Seams: mesh edges whose two vertices belong to different panels (rings at the joints, the boot's top).
    const seen = new Set(), seam = [], V = this.V;
    for (let f = 0; f < this.faces.length / 3; f++) {
      for (let e = 0; e < 3; e++) {
        const a = this.faces[3 * f + e], b = this.faces[3 * f + ((e + 1) % 3)];
        if (this.panel[a] === this.panel[b] || this.panel[a] === PANEL_HAIR || this.panel[b] === PANEL_HAIR) continue;
        const key = a < b ? a * V + b : b * V + a;
        if (seen.has(key)) continue;
        seen.add(key);
        seam.push(a, b);
      }
    }
    return seam;
  }

  vertex(f, k) {
    // Vertex k of frame f in three.js coordinates (m), before the suit's inflation.
    const a = (f * this.V + k) * 3;
    return new THREE.Vector3(this.pos[a] / 1000, this.pos[a + 2] / 1000, -this.pos[a + 1] / 1000);
  }

  footVertices(names) {
    const out = { l: [], r: [] };
    for (let k = 0; k < this.V; k++) {
      const bone = this.bones[this.labels[k]];
      if (bone && /heel|toe/.test(names[bone[0]] + names[bone[1]])) out[names[bone[0]][0]].push(k);
    }
    return out;
  }

  markBoot(points, idx, shaft = 0.14) {
    // A figure skate's upper: the foot and the shin up to `shaft` above the ankle, white and stiffer than the suit.
    const bootPanel = { l: 10, r: 11 };
    for (let k = 0; k < this.V; k++) {
      const bone = this.bones[this.labels[k]];
      if (!bone) continue;
      let side = null;
      for (const s of ['l', 'r']) {
        const foot = this.panel[k] === bootPanel[s];
        const shin = bone[0] === idx[`${s}_knee`] && bone[1] === idx[`${s}_ankle`];
        if (shin) {
          const ankle = points[idx[`${s}_ankle`]], axis = points[idx[`${s}_knee`]].clone().sub(ankle).normalize();
          if (this.vertex(0, k).sub(ankle).dot(axis) < shaft) side = s;
        } else if (foot) side = s;
      }
      if (!side) continue;
      this.panel[k] = bootPanel[side];
      const c = PANEL_COLORS[bootPanel[side]];
      this.colors.set([c.r, c.g, c.b], 3 * k);
      this.inflate[k] = BOOT_INFLATE;
    }
    this.geo.attributes.color.needsUpdate = true;
    this.seams.geometry.setIndex(this.seamIndex());
    const f = this.frame;
    this.frame = -1;
    this.setFrame(Math.max(f, 0));
  }

  markHair(points, idx) {
    // Hair on the scalp: head vertices above a hairline that is high at the forehead, just above the ears at the
    // sides and down to the nape at the back; thicker towards the crown, with a slight unevenness like strands.
    const ear = points[idx.l_ear].clone().add(points[idx.r_ear]).multiplyScalar(0.5);
    const neck = points[idx.l_shoulder].clone().add(points[idx.r_shoulder]).multiplyScalar(0.5);
    const up = ear.clone().sub(neck).normalize();
    const fwd = points[idx.nose].clone().sub(ear);
    fwd.addScaledVector(up, -fwd.dot(up)).normalize();
    const side = new THREE.Vector3().crossVectors(fwd, up);
    const c = PANEL_COLORS[PANEL_HAIR];
    for (let k = 0; k < this.V; k++) {
      if (this.labels[k] !== 255) continue;
      const v = this.vertex(0, k).sub(ear);
      const u = v.dot(up), phi = Math.atan2(v.dot(side), v.dot(fwd));
      const line = 0.0125 + 0.055 * Math.cos(phi) - 0.0075 * Math.cos(2 * phi);  // 6 cm front, 2 cm sides, -3.5 cm back
      if (u < line) continue;
      this.panel[k] = PANEL_HAIR;
      this.colors.set([c.r, c.g, c.b], 3 * k);
      const strand = 0.002 * Math.sin(k * 12.9898) * Math.cos(k * 78.233);
      this.inflate[k] = SUIT_INFLATE + Math.min((u - line) / 0.05, 1) * 0.012 + strand;  // flush at the hairline
    }
    this.geo.attributes.color.needsUpdate = true;
    this.seams.geometry.setIndex(this.seamIndex());
    // Hair is its own opaque mesh (no suit rim light), sharing the surface's moving vertices.
    const hair = [], rest = [];
    for (let f = 0; f < this.faces.length / 3; f++) {
      const tri = [this.faces[3 * f], this.faces[3 * f + 1], this.faces[3 * f + 2]];
      (tri.filter((v) => this.panel[v] === PANEL_HAIR).length >= 2 ? hair : rest).push(...tri);
    }
    this.geo.setIndex(rest);
    const hairGeo = new THREE.BufferGeometry();
    hairGeo.setAttribute('position', this.position);
    hairGeo.setIndex(hair);
    this.hairGeo = hairGeo;
    this.hairMat = new THREE.MeshStandardMaterial({ color: 0x2b1d14, roughness: 0.55, metalness: 0.08,
      emissive: 0x140c08, emissiveIntensity: 1.0, transparent: true, opacity: this.mat.opacity });
    this.hair = new THREE.Mesh(hairGeo, this.hairMat);
    this.hair.renderOrder = 2;
    this.hair.castShadow = true;
    this.hair.frustumCulled = false;
    this.group.add(this.hair);
    const f = this.frame;
    this.frame = -1;
    this.setFrame(Math.max(f, 0));
  }

  setHair(header, buffer) {
    // A real hairstyle (skatesense/hair.py: CC0 MakeHuman hair cards fitted to this head), in the frame of three
    // head vertices: the midpoint of the two near the ears, x towards the left one, y up through the top one.
    this.clearHair();
    const { vertices: N, faces: F } = header;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, 0, N * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buffer, N * 12, N * 2), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array(buffer, N * 20, F * 3), 1));
    geo.computeVertexNormals();
    const map = new THREE.TextureLoader().load(header.texture);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 4;
    this.hairMat = new THREE.MeshStandardMaterial({ map, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.6,
      metalness: 0.0, opacity: this.mat.opacity, transparent: this.mat.opacity < 1 });
    this.hairMesh = new THREE.Mesh(geo, this.hairMat);
    this.hairMesh.matrixAutoUpdate = false;
    this.hairMesh.renderOrder = 2;
    this.hairMesh.frustumCulled = false;
    this.hairMarks = header.landmarks;
    this.group.add(this.hairMesh);
    // The scalp under the cards takes the hair's colour (darker, as the roots are), so gaps never show the suit.
    const c = new THREE.Color(header.color).multiplyScalar(0.55);
    this.scalp = header.scalp;
    for (const k of this.scalp) this.colors.set([c.r, c.g, c.b], 3 * k);
    this.geo.attributes.color.needsUpdate = true;
    const f = this.frame;
    this.frame = -1;
    this.setFrame(Math.max(f, 0));
  }

  clearHair() {
    if (!this.hairMesh) return;
    this.group.remove(this.hairMesh);
    this.hairMesh.geometry.dispose();
    this.hairMat.map?.dispose();
    this.hairMat.dispose();
    for (const k of this.scalp) {
      const c = PANEL_COLORS[this.panel[k]];
      this.colors.set([c.r, c.g, c.b], 3 * k);
    }
    this.hairMesh = this.hairMat = this.scalp = null;
  }

  placeHair(out) {
    const P = (k) => new THREE.Vector3(out[3 * k], out[3 * k + 1], out[3 * k + 2]);
    const [L, R, T] = this.hairMarks.map(P);
    const o = L.clone().add(R).multiplyScalar(0.5);
    const x = L.sub(R).normalize();
    const z = new THREE.Vector3().crossVectors(x, T.sub(o)).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    this.hairMesh.matrix.makeBasis(x, y, z).setPosition(o);
    this.hairMesh.matrixWorldNeedsUpdate = true;
  }

  setFrame(f, blend = null) {
    if (f === this.frame && !blend) return;
    this.frame = f;
    const out = this.position.array, p = this.pos;
    const i = THREE.MathUtils.clamp(Math.floor(f), 0, this.T - 1);
    if (!blend || f === i) {
      const a = i * this.V * 3;
      for (let k = 0; k < this.V; k++) {
        // Z-up replay (mm) -> Y-up three.js (m): (x, y, z) -> (x, z, -y)
        out[3 * k] = p[a + 3 * k] / 1000; out[3 * k + 1] = p[a + 3 * k + 2] / 1000; out[3 * k + 2] = -p[a + 3 * k + 1] / 1000;
      }
    } else {
      const base = blend.idx.map((m) => m * this.V * 3), xs = [0, 0, 0, 0], ys = [0, 0, 0, 0], zs = [0, 0, 0, 0];
      for (let k = 0; k < this.V; k++) {
        for (let m = 0; m < 4; m++) {
          const a = base[m] + 3 * k;
          xs[m] = p[a] / 1000; ys[m] = p[a + 2] / 1000; zs[m] = -p[a + 1] / 1000;
        }
        blendPoint(blend, xs, ys, zs, out, 3 * k);
      }
    }
    if (this.hairMesh) this.placeHair(out);  // from the bare surface, as it was fitted
    this.fullGeo.computeVertexNormals();
    this.geo.setAttribute('normal', this.fullGeo.attributes.normal);
    // Fabric thickness: push the surface out along its normals (smooths the anatomy, like a suit does).
    const n = this.fullGeo.attributes.normal.array;
    for (let k = 0; k < 3 * this.V; k++) out[k] += n[k] * this.inflate[(k / 3) | 0];
    this.position.needsUpdate = true;
    if (this.hairGeo) this.hairGeo.setAttribute('normal', this.fullGeo.attributes.normal);
  }

  setHighlight(joints) {
    const hot = this.hot.array;
    for (let k = 0; k < this.V; k++) {
      const bone = this.bones[this.labels[k]];
      hot[k] = bone && joints.has(bone[0]) && joints.has(bone[1]) ? 1 : 0;
    }
    this.hot.needsUpdate = true;
  }

  setBuffer(buffer) {
    // Another body shape of the same clip: same frames, vertices and triangles, new positions.
    this.pos = new Int16Array(buffer, 0, this.T * this.V * 3);
    const f = this.frame;
    this.frame = -1;
    this.setFrame(Math.max(f, 0));
  }

  setOpacity(o) {
    this.mat.opacity = o;
    if (this.hairMat) {
      this.hairMat.opacity = o;
      if (this.hairMesh && this.hairMat.transparent !== o < 1) {
        this.hairMat.transparent = o < 1;
        this.hairMat.needsUpdate = true;
      }
    }
    this.seamMat.opacity = Math.min(0.7, o);
  }
}

// ---------- figure skates ----------
// Real proportions, from skatesense/skates.py: the replay carries the geometry and the mounting (summary.skates),
// so the steel drawn here is the steel the replay was put on the ice with and the take-off and landing points were
// measured on. Side profile in metres: x forward from the ball of the foot, y up from the ice, z sideways.
// Steel: the John Wilson Coronation Ace's side profile traced from the maker's photo (scripts/trace_blade_profile.py),
// 4 mm thick, with its front window cut out; plates. Boot: the outsole, pitched like the foot inside it (heel up), and
// a heel block; the upper is the body mesh's own foot and lower shin (BodyMesh.markBoot).
// DEFAULT_SKATES (the same module's defaults) is for replays written before the geometry was exported.
const DEFAULT_SKATES = {"source":"John Wilson Coronation Ace, traced (models/blade_profile.json)","blade":[[-0.00064,0.0551],[-0.00127,0.05481],[-0.0019,0.05482],[-0.00252,0.05484],[-0.00315,0.05485],[-0.00377,0.05487],[-0.0044,0.05489],[-0.00502,0.0549],[-0.00565,0.05492],[-0.00627,0.05494],[-0.0069,0.05464],[-0.00753,0.05466],[-0.00815,0.05467],[-0.00878,0.05469],[-0.0094,0.05471],[-0.01002,0.05472],[-0.01065,0.05474],[-0.01127,0.05476],[-0.01191,0.05446],[-0.01253,0.05448],[-0.01315,0.05449],[-0.01378,0.05451],[-0.0144,0.05453],[-0.01504,0.05423],[-0.01566,0.05425],[-0.01628,0.05426],[-0.01691,0.05428],[-0.01753,0.0543],[-0.01817,0.054],[-0.01879,0.05402],[-0.01941,0.05403],[-0.02005,0.05374],[-0.02067,0.05375],[-0.0213,0.05377],[-0.02193,0.05347],[-0.02255,0.05349],[-0.02319,0.05319],[-0.02381,0.05321],[-0.02444,0.05291],[-0.02507,0.05293],[-0.0257,0.05264],[-0.02632,0.05265],[-0.02696,0.05236],[-0.02759,0.05206],[-0.02822,0.05176],[-0.02885,0.05178],[-0.02948,0.05148],[-0.03011,0.05119],[-0.03074,0.05089],[-0.03138,0.05029],[-0.03202,0.04999],[-0.03266,0.04938],[-0.0333,0.04877],[-0.03363,0.04816],[-0.03364,0.04753],[-0.03366,0.04691],[-0.03336,0.04628],[-0.03338,0.04565],[-0.0334,0.04503],[-0.03279,0.04439],[-0.03218,0.04375],[-0.03156,0.04342],[-0.03095,0.04309],[-0.03065,0.04246],[-0.03067,0.04183],[-0.031,0.04122],[-0.03101,0.04059],[-0.03072,0.03996],[-0.03073,0.03933],[-0.03044,0.0387],[-0.03014,0.03807],[-0.02953,0.03743],[-0.02892,0.0371],[-0.0283,0.03677],[-0.02769,0.03644],[-0.02706,0.03643],[-0.02645,0.03579],[-0.02616,0.03515],[-0.02617,0.03453],[-0.02588,0.0339],[-0.02589,0.03327],[-0.02591,0.03265],[-0.02562,0.03201],[-0.02563,0.03139],[-0.02565,0.03077],[-0.02598,0.03015],[-0.02599,0.02953],[-0.02632,0.02891],[-0.02634,0.02828],[-0.02667,0.02767],[-0.027,0.02705],[-0.02764,0.02644],[-0.02828,0.02584],[-0.02892,0.02523],[-0.02956,0.02462],[-0.0302,0.02401],[-0.03083,0.02372],[-0.03147,0.02311],[-0.03211,0.02281],[-0.03274,0.02252],[-0.03337,0.02222],[-0.034,0.02193],[-0.03464,0.02163],[-0.03527,0.02133],[-0.03589,0.02135],[-0.03652,0.02105],[-0.03716,0.02076],[-0.03778,0.02077],[-0.03841,0.02048],[-0.03904,0.0205],[-0.03967,0.0202],[-0.0403,0.02022],[-0.04092,0.02023],[-0.04154,0.02025],[-0.04218,0.01995],[-0.0428,0.01997],[-0.04343,0.01999],[-0.04405,0.02],[-0.04468,0.01971],[-0.04531,0.01972],[-0.04593,0.01974],[-0.04656,0.01976],[-0.04718,0.01977],[-0.0478,0.01979],[-0.04843,0.0198],[-0.04905,0.01982],[-0.04968,0.01984],[-0.05031,0.01954],[-0.05093,0.01956],[-0.05156,0.01957],[-0.05218,0.01959],[-0.05281,0.01961],[-0.05343,0.01962],[-0.05406,0.01964],[-0.05468,0.01966],[-0.05531,0.01967],[-0.05593,0.01969],[-0.05655,0.01971],[-0.05718,0.01972],[-0.0578,0.01974],[-0.05843,0.01975],[-0.05906,0.01946],[-0.05968,0.01948],[-0.06031,0.01949],[-0.06093,0.01951],[-0.06156,0.01952],[-0.06218,0.01954],[-0.06281,0.01956],[-0.06343,0.01957],[-0.06405,0.01959],[-0.06468,0.01961],[-0.0653,0.01962],[-0.06593,0.01964],[-0.06655,0.01966],[-0.06718,0.01967],[-0.0678,0.01969],[-0.06843,0.01971],[-0.06905,0.01972],[-0.06967,0.01974],[-0.0703,0.01975],[-0.07092,0.01977],[-0.07155,0.01979],[-0.07217,0.0198],[-0.0728,0.01982],[-0.07342,0.01984],[-0.07404,0.01985],[-0.07467,0.01987],[-0.07529,0.01989],[-0.07592,0.0199],[-0.07654,0.01992],[-0.07717,0.01993],[-0.07779,0.01995],[-0.07842,0.01997],[-0.07904,0.01998],[-0.07966,0.02],[-0.08029,0.02002],[-0.08091,0.02003],[-0.08154,0.02005],[-0.08216,0.02007],[-0.08279,0.02008],[-0.08341,0.0201],[-0.08403,0.02011],[-0.08466,0.02013],[-0.08528,0.02015],[-0.08591,0.02016],[-0.08653,0.02018],[-0.08716,0.0202],[-0.08778,0.02021],[-0.08841,0.02023],[-0.08903,0.02025],[-0.08965,0.02026],[-0.09028,0.02028],[-0.0909,0.0203],[-0.09153,0.02031],[-0.09215,0.02033],[-0.09278,0.02034],[-0.09339,0.02067],[-0.09402,0.02069],[-0.09464,0.02071],[-0.09527,0.02072],[-0.09589,0.02074],[-0.09651,0.02075],[-0.09714,0.02077],[-0.09776,0.02079],[-0.09839,0.0208],[-0.09901,0.02082],[-0.09964,0.02084],[-0.10026,0.02085],[-0.10088,0.02087],[-0.10151,0.02089],[-0.10213,0.0209],[-0.10275,0.02123],[-0.10337,0.02125],[-0.104,0.02126],[-0.10462,0.02128],[-0.10525,0.0213],[-0.10587,0.02131],[-0.1065,0.02133],[-0.10712,0.02135],[-0.10774,0.02136],[-0.10837,0.02138],[-0.10899,0.02139],[-0.10962,0.02141],[-0.11023,0.02174],[-0.11086,0.02176],[-0.11148,0.02177],[-0.11211,0.02179],[-0.11273,0.02181],[-0.11336,0.02182],[-0.11398,0.02184],[-0.1146,0.02185],[-0.11523,0.02187],[-0.11585,0.02189],[-0.11648,0.0219],[-0.11709,0.02223],[-0.11772,0.02225],[-0.11834,0.02227],[-0.11897,0.02228],[-0.11959,0.0223],[-0.12021,0.02263],[-0.12083,0.02264],[-0.12146,0.02266],[-0.12208,0.02268],[-0.1227,0.023],[-0.12332,0.02302],[-0.12395,0.02304],[-0.12456,0.02337],[-0.12519,0.02338],[-0.1258,0.02371],[-0.12643,0.02373],[-0.12704,0.02406],[-0.12767,0.02407],[-0.12828,0.0244],[-0.12891,0.02442],[-0.12952,0.02475],[-0.13014,0.02507],[-0.13076,0.0254],[-0.13137,0.02573],[-0.13199,0.02606],[-0.1326,0.02639],[-0.13322,0.02672],[-0.13384,0.02705],[-0.13445,0.02769],[-0.13506,0.02801],[-0.13567,0.02866],[-0.13628,0.0293],[-0.13689,0.02994],[-0.13749,0.03058],[-0.13779,0.03121],[-0.13809,0.03184],[-0.13838,0.03248],[-0.13868,0.03311],[-0.13897,0.03374],[-0.13927,0.03437],[-0.13925,0.035],[-0.13924,0.03562],[-0.13953,0.03625],[-0.13951,0.03688],[-0.13919,0.0375],[-0.13917,0.03812],[-0.13915,0.03874],[-0.13914,0.03937],[-0.13881,0.03998],[-0.13879,0.04061],[-0.13846,0.04123],[-0.13845,0.04185],[-0.13781,0.04215],[-0.13719,0.04213],[-0.13657,0.04211],[-0.13594,0.0421],[-0.13532,0.04208],[-0.13469,0.04206],[-0.13407,0.04205],[-0.13344,0.04203],[-0.13282,0.04201],[-0.1322,0.042],[-0.13157,0.04198],[-0.13095,0.04197],[-0.13032,0.04195],[-0.1297,0.04193],[-0.12907,0.04192],[-0.12843,0.04252],[-0.12842,0.04315],[-0.1284,0.04377],[-0.12838,0.0444],[-0.12868,0.04503],[-0.12897,0.04566],[-0.12896,0.04629],[-0.12925,0.04692],[-0.12955,0.04755],[-0.12953,0.04818],[-0.12983,0.04881],[-0.13013,0.04944],[-0.13011,0.05007],[-0.1304,0.0507],[-0.1307,0.05133],[-0.13068,0.05196],[-0.13098,0.05259],[-0.1316,0.05292],[-0.13221,0.05324],[-0.13284,0.05326],[-0.13346,0.05328],[-0.13409,0.05329],[-0.13471,0.05331],[-0.13533,0.05333],[-0.13596,0.05334],[-0.13658,0.05336],[-0.1372,0.05369],[-0.13782,0.0537],[-0.13845,0.05372],[-0.13907,0.05374],[-0.1397,0.05375],[-0.14032,0.05377],[-0.14095,0.05379],[-0.14157,0.0538],[-0.14219,0.05413],[-0.14281,0.05415],[-0.14343,0.05416],[-0.14406,0.05418],[-0.14468,0.0542],[-0.14531,0.05421],[-0.14593,0.05423],[-0.14656,0.05425],[-0.14718,0.05426],[-0.14781,0.05428],[-0.14842,0.05461],[-0.14905,0.05462],[-0.14967,0.05464],[-0.15029,0.05466],[-0.15092,0.05467],[-0.15154,0.05469],[-0.15217,0.05471],[-0.15279,0.05472],[-0.15342,0.05474],[-0.15404,0.05476],[-0.15467,0.05477],[-0.15529,0.05479],[-0.15591,0.0548],[-0.15653,0.05513],[-0.15715,0.05515],[-0.15779,0.05485],[-0.15841,0.05487],[-0.15904,0.05489],[-0.15967,0.05459],[-0.16029,0.05461],[-0.16092,0.05462],[-0.16155,0.05433],[-0.16218,0.05403],[-0.16281,0.05405],[-0.16344,0.05375],[-0.16407,0.05346],[-0.1647,0.05316],[-0.16535,0.05255],[-0.16567,0.05194],[-0.16569,0.05131],[-0.16602,0.0507],[-0.16604,0.05007],[-0.16605,0.04945],[-0.16576,0.04881],[-0.16546,0.04818],[-0.16485,0.04754],[-0.16424,0.0469],[-0.16363,0.04657],[-0.16301,0.04624],[-0.1624,0.04591],[-0.16178,0.04559],[-0.16116,0.04526],[-0.16054,0.04524],[-0.15993,0.0446],[-0.15963,0.04397],[-0.15965,0.04334],[-0.15967,0.04272],[-0.15937,0.04209],[-0.15939,0.04146],[-0.1594,0.04084],[-0.15942,0.04021],[-0.15913,0.03958],[-0.15914,0.03896],[-0.15916,0.03833],[-0.15917,0.03771],[-0.1595,0.03709],[-0.15952,0.03647],[-0.15954,0.03584],[-0.15986,0.03523],[-0.15988,0.0346],[-0.16021,0.03399],[-0.16054,0.03337],[-0.16087,0.03275],[-0.1612,0.03214],[-0.16184,0.03153],[-0.16216,0.03091],[-0.16281,0.03031],[-0.16344,0.03001],[-0.16408,0.0294],[-0.16472,0.02879],[-0.16535,0.0285],[-0.16598,0.0282],[-0.16662,0.02791],[-0.16725,0.02761],[-0.16788,0.02731],[-0.16851,0.02702],[-0.16915,0.02672],[-0.16978,0.02643],[-0.17041,0.02613],[-0.17104,0.02615],[-0.17167,0.02585],[-0.17229,0.02587],[-0.17293,0.02557],[-0.17356,0.02528],[-0.17418,0.02529],[-0.17481,0.02531],[-0.17544,0.02501],[-0.17606,0.02503],[-0.1767,0.02473],[-0.17732,0.02475],[-0.17795,0.02477],[-0.17858,0.02447],[-0.1792,0.02449],[-0.17983,0.0245],[-0.18045,0.02452],[-0.18108,0.02422],[-0.18171,0.02424],[-0.18233,0.02426],[-0.18296,0.02427],[-0.18359,0.02398],[-0.18421,0.02399],[-0.18484,0.02401],[-0.18546,0.02403],[-0.1861,0.02373],[-0.18672,0.02375],[-0.18734,0.02376],[-0.18797,0.02378],[-0.18859,0.0238],[-0.18923,0.0235],[-0.18985,0.02352],[-0.19047,0.02353],[-0.1911,0.02355],[-0.19172,0.02357],[-0.19236,0.02327],[-0.19298,0.02329],[-0.1936,0.0233],[-0.19423,0.02332],[-0.19486,0.02302],[-0.19549,0.02304],[-0.19612,0.02274],[-0.19675,0.02245],[-0.19738,0.02215],[-0.19802,0.02186],[-0.19866,0.02125],[-0.1993,0.02064],[-0.19994,0.02003],[-0.20027,0.01942],[-0.2006,0.0188],[-0.20092,0.01819],[-0.20094,0.01756],[-0.20127,0.01694],[-0.20129,0.01632],[-0.20161,0.0157],[-0.20163,0.01508],[-0.20165,0.01446],[-0.20166,0.01383],[-0.20199,0.01321],[-0.20201,0.01259],[-0.20202,0.01197],[-0.20204,0.01134],[-0.20206,0.01072],[-0.20207,0.01009],[-0.20146,0.00976],[-0.20083,0.00975],[-0.20022,0.00942],[-0.19959,0.0094],[-0.19897,0.00939],[-0.19834,0.00937],[-0.19773,0.00904],[-0.1971,0.00903],[-0.19648,0.00901],[-0.19585,0.00899],[-0.19523,0.00898],[-0.19461,0.00896],[-0.19398,0.00894],[-0.19337,0.00861],[-0.19274,0.0086],[-0.19212,0.00858],[-0.19149,0.00857],[-0.19087,0.00855],[-0.19024,0.00853],[-0.18963,0.0082],[-0.189,0.00819],[-0.18838,0.00817],[-0.18775,0.00815],[-0.18713,0.00814],[-0.18651,0.00812],[-0.18588,0.00811],[-0.18526,0.00809],[-0.18464,0.00776],[-0.18402,0.00774],[-0.18339,0.00773],[-0.18277,0.00771],[-0.18214,0.0077],[-0.18152,0.00768],[-0.18089,0.00766],[-0.18027,0.00765],[-0.17965,0.00763],[-0.17903,0.0073],[-0.1784,0.00728],[-0.17778,0.00727],[-0.17716,0.00725],[-0.17653,0.00724],[-0.17591,0.00722],[-0.17528,0.0072],[-0.17466,0.00719],[-0.17403,0.00717],[-0.17342,0.00684],[-0.17279,0.00682],[-0.17217,0.00681],[-0.17154,0.00679],[-0.17092,0.00678],[-0.1703,0.00676],[-0.16967,0.00674],[-0.16905,0.00673],[-0.16842,0.00671],[-0.1678,0.00669],[-0.16717,0.00668],[-0.16656,0.00635],[-0.16593,0.00633],[-0.16531,0.00632],[-0.16469,0.0063],[-0.16406,0.00628],[-0.16344,0.00627],[-0.16281,0.00625],[-0.16219,0.00623],[-0.16156,0.00622],[-0.16094,0.0062],[-0.16031,0.00618],[-0.1597,0.00586],[-0.15907,0.00584],[-0.15845,0.00582],[-0.15783,0.00581],[-0.1572,0.00579],[-0.15658,0.00577],[-0.15595,0.00576],[-0.15533,0.00574],[-0.1547,0.00573],[-0.15408,0.00571],[-0.15345,0.00569],[-0.15283,0.00568],[-0.15221,0.00535],[-0.15159,0.00533],[-0.15097,0.00531],[-0.15034,0.0053],[-0.14972,0.00528],[-0.14909,0.00527],[-0.14847,0.00525],[-0.14784,0.00523],[-0.14722,0.00522],[-0.14659,0.0052],[-0.14597,0.00518],[-0.14535,0.00517],[-0.14472,0.00515],[-0.14411,0.00482],[-0.14348,0.00481],[-0.14286,0.00479],[-0.14223,0.00477],[-0.14161,0.00476],[-0.14098,0.00474],[-0.14036,0.00472],[-0.13973,0.00471],[-0.13911,0.00469],[-0.13849,0.00467],[-0.13786,0.00466],[-0.13724,0.00464],[-0.13662,0.00431],[-0.136,0.0043],[-0.13537,0.00428],[-0.13475,0.00426],[-0.13412,0.00425],[-0.1335,0.00423],[-0.13287,0.00421],[-0.13258,0.00358],[-0.13195,0.00357],[-0.13133,0.00355],[-0.13071,0.00353],[-0.13008,0.00352],[-0.12946,0.0035],[-0.12883,0.00348],[-0.12821,0.00347],[-0.12758,0.00345],[-0.12696,0.00343],[-0.12634,0.00342],[-0.12571,0.0034],[-0.12509,0.00307],[-0.12447,0.00306],[-0.12385,0.00304],[-0.12322,0.00302],[-0.1226,0.00301],[-0.12197,0.00299],[-0.12135,0.00298],[-0.12072,0.00296],[-0.1201,0.00294],[-0.11948,0.00293],[-0.11885,0.00291],[-0.11823,0.00289],[-0.1176,0.00288],[-0.11698,0.00286],[-0.11635,0.00284],[-0.11573,0.00283],[-0.1151,0.00281],[-0.11448,0.00279],[-0.11386,0.00247],[-0.11324,0.00245],[-0.11262,0.00243],[-0.11199,0.00242],[-0.11137,0.0024],[-0.11074,0.00238],[-0.11012,0.00237],[-0.10949,0.00235],[-0.10887,0.00234],[-0.10824,0.00232],[-0.10762,0.0023],[-0.107,0.00229],[-0.10637,0.00227],[-0.10575,0.00225],[-0.10512,0.00224],[-0.1045,0.00222],[-0.10387,0.0022],[-0.10325,0.00219],[-0.10263,0.00217],[-0.102,0.00215],[-0.10138,0.00214],[-0.10075,0.00212],[-0.10013,0.00211],[-0.0995,0.00209],[-0.09888,0.00207],[-0.09825,0.00206],[-0.09763,0.00204],[-0.09701,0.00202],[-0.09638,0.00201],[-0.09576,0.00199],[-0.09513,0.00197],[-0.09452,0.00165],[-0.09389,0.00163],[-0.09327,0.00161],[-0.09264,0.0016],[-0.09202,0.00158],[-0.09139,0.00156],[-0.09077,0.00155],[-0.09015,0.00153],[-0.08952,0.00151],[-0.0889,0.0015],[-0.08827,0.00148],[-0.08765,0.00147],[-0.08702,0.00145],[-0.0864,0.00143],[-0.08578,0.00142],[-0.08515,0.0014],[-0.08453,0.00138],[-0.0839,0.00137],[-0.08328,0.00135],[-0.08265,0.00133],[-0.08203,0.00132],[-0.0814,0.0013],[-0.08078,0.00129],[-0.08016,0.00127],[-0.07953,0.00125],[-0.07891,0.00124],[-0.07828,0.00122],[-0.07766,0.0012],[-0.07703,0.00119],[-0.07641,0.00117],[-0.07579,0.00115],[-0.07516,0.00114],[-0.07454,0.00112],[-0.07391,0.0011],[-0.07329,0.00109],[-0.07266,0.00107],[-0.07204,0.00106],[-0.07141,0.00104],[-0.07079,0.00102],[-0.07017,0.00101],[-0.06954,0.00099],[-0.06892,0.00097],[-0.06829,0.00096],[-0.06767,0.00094],[-0.06704,0.00092],[-0.06642,0.00091],[-0.0658,0.00089],[-0.06517,0.00088],[-0.06455,0.00086],[-0.06392,0.00084],[-0.0633,0.00083],[-0.06267,0.00081],[-0.06205,0.00079],[-0.06142,0.00078],[-0.0608,0.00076],[-0.06018,0.00074],[-0.05955,0.00073],[-0.05893,0.00071],[-0.0583,0.0007],[-0.05768,0.00068],[-0.05705,0.00066],[-0.05643,0.00065],[-0.05581,0.00063],[-0.05518,0.00061],[-0.05456,0.0006],[-0.05393,0.00058],[-0.05331,0.00056],[-0.05268,0.00055],[-0.05206,0.00053],[-0.05143,0.00051],[-0.05081,0.0005],[-0.05019,0.00048],[-0.04956,0.00047],[-0.04894,0.00045],[-0.04831,0.00043],[-0.04769,0.00042],[-0.04706,0.0004],[-0.04644,0.00038],[-0.04582,0.00037],[-0.04519,0.00035],[-0.04457,0.00033],[-0.04394,0.00032],[-0.04332,0.0003],[-0.04269,0.00029],[-0.04206,0.00058],[-0.04144,0.00056],[-0.04082,0.00024],[-0.0402,0.00022],[-0.03956,0.00052],[-0.03894,0.0005],[-0.03831,0.00048],[-0.03769,0.00047],[-0.03707,0.00045],[-0.03644,0.00043],[-0.03582,0.00042],[-0.03519,0.0004],[-0.03457,0.00038],[-0.03394,0.00037],[-0.03332,0.00035],[-0.0327,0.00034],[-0.03207,0.00032],[-0.03145,0.0003],[-0.03082,0.00029],[-0.0302,0.00027],[-0.02957,0.00025],[-0.02895,0.00024],[-0.02832,0.00022],[-0.0277,0.0002],[-0.02708,0.00019],[-0.02645,0.00017],[-0.02583,0.00015],[-0.0252,0.00014],[-0.02457,0.00043],[-0.02395,0.00042],[-0.02332,0.0004],[-0.0227,0.00039],[-0.02207,0.00037],[-0.02145,0.00035],[-0.02082,0.00034],[-0.0202,0.00032],[-0.01958,0.0003],[-0.01895,0.00029],[-0.01833,0.00027],[-0.0177,0.00025],[-0.01708,0.00024],[-0.01645,0.00022],[-0.01583,0.0002],[-0.0152,0.00019],[-0.01458,0.00017],[-0.01396,0.00016],[-0.01333,0.00014],[-0.01271,0.00012],[-0.01208,0.00011],[-0.01146,9e-05],[-0.01083,7e-05],[-0.01021,6e-05],[-0.00959,4e-05],[-0.00896,2e-05],[-0.00834,1e-05],[-0.0077,0.0003],[-0.00708,0.00029],[-0.00646,0.00027],[-0.00583,0.00025],[-0.00521,0.00024],[-0.00458,0.00022],[-0.00396,0.00021],[-0.00333,0.00019],[-0.00271,0.00017],[-0.00208,0.00016],[-0.00146,0.00014],[-0.00084,0.00012],[-0.00021,0.00011],[0.00041,9e-05],[0.00104,7e-05],[0.00167,0.00037],[0.00229,0.00035],[0.00292,0.00034],[0.00354,0.00032],[0.00417,0.0003],[0.00479,0.00029],[0.00542,0.00027],[0.00604,0.00026],[0.00666,0.00024],[0.00729,0.00022],[0.00792,0.00052],[0.00855,0.0005],[0.00917,0.00049],[0.00979,0.00047],[0.01042,0.00045],[0.01104,0.00044],[0.01167,0.00042],[0.0123,0.00072],[0.01293,0.0007],[0.01355,0.00068],[0.01417,0.00067],[0.0148,0.00065],[0.01542,0.00063],[0.01606,0.00093],[0.01668,0.00091],[0.0173,0.0009],[0.01793,0.00088],[0.01855,0.00086],[0.01918,0.00085],[0.01981,0.00114],[0.02043,0.00113],[0.02106,0.00111],[0.02168,0.00109],[0.02232,0.00139],[0.02294,0.00137],[0.02356,0.00136],[0.02419,0.00134],[0.02481,0.00132],[0.02545,0.00162],[0.02607,0.0016],[0.02669,0.00159],[0.02732,0.00157],[0.02795,0.00187],[0.02858,0.00185],[0.0292,0.00183],[0.02982,0.00182],[0.03046,0.00211],[0.03108,0.0021],[0.03171,0.00208],[0.03234,0.00238],[0.03296,0.00236],[0.03359,0.00234],[0.03422,0.00264],[0.03484,0.00262],[0.03547,0.00261],[0.0361,0.0029],[0.03673,0.00289],[0.03735,0.00287],[0.03797,0.00285],[0.03861,0.00315],[0.03923,0.00313],[0.03986,0.00312],[0.04049,0.00341],[0.04111,0.0034],[0.04174,0.00338],[0.04237,0.00368],[0.04299,0.00366],[0.04363,0.00395],[0.04425,0.00394],[0.04487,0.00392],[0.04551,0.00422],[0.04613,0.0042],[0.04676,0.0045],[0.04739,0.00448],[0.04801,0.00446],[0.04865,0.00476],[0.04927,0.00474],[0.0499,0.00504],[0.05053,0.00502],[0.05115,0.00501],[0.05178,0.0053],[0.05241,0.00529],[0.05304,0.00558],[0.05367,0.00557],[0.05429,0.00555],[0.05492,0.00585],[0.05555,0.00614],[0.05618,0.00612],[0.0568,0.00611],[0.05743,0.00609],[0.05804,0.00576],[0.05866,0.00543],[0.05928,0.00542],[0.0599,0.00509],[0.06052,0.00476],[0.06114,0.00474],[0.06176,0.00442],[0.0624,0.00502],[0.06241,0.00565],[0.06243,0.00627],[0.06214,0.00691],[0.06215,0.00753],[0.06217,0.00815],[0.06218,0.00878],[0.06251,0.00939],[0.06314,0.00938],[0.06376,0.00936],[0.06439,0.00935],[0.06502,0.00964],[0.06504,0.01027],[0.06474,0.0109],[0.06476,0.01152],[0.06477,0.01215],[0.06479,0.01277],[0.06542,0.01307],[0.06605,0.01305],[0.06667,0.01303],[0.0673,0.01333],[0.06732,0.01395],[0.06795,0.01425],[0.06828,0.01487],[0.0683,0.01549],[0.068,0.01612],[0.06802,0.01675],[0.06865,0.01704],[0.06927,0.01703],[0.0699,0.01701],[0.06991,0.01764],[0.07024,0.01825],[0.07087,0.01824],[0.0715,0.01853],[0.07152,0.01916],[0.07122,0.01979],[0.07124,0.02041],[0.07157,0.02103],[0.07219,0.02101],[0.07281,0.021],[0.07314,0.02161],[0.07347,0.02223],[0.0741,0.02221],[0.07442,0.02252],[0.07443,0.02314],[0.07445,0.02376],[0.07447,0.02439],[0.0751,0.02468],[0.07572,0.02467],[0.07635,0.02465],[0.07698,0.02495],[0.07761,0.02524],[0.07794,0.02586],[0.07733,0.0265],[0.07672,0.02683],[0.07611,0.02747],[0.07549,0.0278],[0.07488,0.02844],[0.07428,0.02908],[0.07366,0.02941],[0.07305,0.03005],[0.07244,0.03069],[0.07184,0.03133],[0.07123,0.03197],[0.07093,0.0326],[0.07032,0.03324],[0.07003,0.03388],[0.06942,0.03452],[0.06912,0.03515],[0.06883,0.03578],[0.06853,0.03642],[0.06855,0.03704],[0.06794,0.03768],[0.06765,0.03831],[0.06735,0.03895],[0.06705,0.03958],[0.06676,0.04021],[0.06646,0.04084],[0.06585,0.04148],[0.06525,0.04213],[0.06464,0.04277],[0.06403,0.04341],[0.06342,0.04405],[0.06281,0.04469],[0.06283,0.04531],[0.06285,0.04594],[0.06286,0.04656],[0.06288,0.04719],[0.06258,0.04782],[0.06198,0.04846],[0.06136,0.04879],[0.06074,0.04912],[0.06013,0.04944],[0.05951,0.04977],[0.0589,0.0501],[0.05827,0.05012],[0.05765,0.05013],[0.05703,0.05046],[0.05641,0.05048],[0.05579,0.05081],[0.05517,0.05082],[0.05454,0.05084],[0.05393,0.05117],[0.0533,0.05119],[0.05268,0.0512],[0.05206,0.05153],[0.05144,0.05155],[0.05081,0.05156],[0.0502,0.05189],[0.04957,0.05191],[0.04895,0.05193],[0.04832,0.05194],[0.04771,0.05227],[0.04708,0.05229],[0.04646,0.0523],[0.04583,0.05232],[0.04522,0.05265],[0.04459,0.05266],[0.04397,0.05268],[0.04334,0.0527],[0.04272,0.05271],[0.0421,0.05304],[0.04148,0.05306],[0.04085,0.05307],[0.04023,0.05309],[0.03961,0.05311],[0.03898,0.05312],[0.03836,0.05345],[0.03774,0.05347],[0.03712,0.05349],[0.03649,0.0535],[0.03587,0.05352],[0.03524,0.05353],[0.03462,0.05355],[0.03399,0.05357],[0.03337,0.05358],[0.03275,0.0536],[0.03212,0.05362],[0.03151,0.05395],[0.03088,0.05396],[0.03026,0.05398],[0.02963,0.05399],[0.02901,0.05401],[0.02838,0.05403],[0.02776,0.05404],[0.02713,0.05406],[0.02651,0.05408],[0.02589,0.05409],[0.02526,0.05411],[0.02464,0.05413],[0.02401,0.05414],[0.02339,0.05416],[0.02276,0.05417],[0.02215,0.0545],[0.02152,0.05452],[0.0209,0.05454],[0.02027,0.05455],[0.01965,0.05457],[0.01903,0.05459],[0.0184,0.0546],[0.01778,0.05462],[0.01715,0.05463],[0.01653,0.05465],[0.0159,0.05467],[0.01528,0.05468],[0.01466,0.0547],[0.01403,0.05472],[0.01341,0.05473],[0.01278,0.05475],[0.01216,0.05477],[0.01153,0.05478],[0.01091,0.0548],[0.01028,0.05481],[0.00966,0.05483],[0.00904,0.05485],[0.00841,0.05486],[0.00779,0.05488],[0.00716,0.0549],[0.00654,0.05491],[0.00591,0.05493],[0.00529,0.05495],[0.00467,0.05496],[0.00404,0.05498],[0.00342,0.05499],[0.00279,0.05501],[0.00217,0.05503],[0.00154,0.05504],[0.00092,0.05506],[0.00029,0.05508],[-0.00033,0.05509]],"blade_holes":[[[0.04831,0.03976],[0.04895,0.04005],[0.04956,0.03973],[0.05018,0.0394],[0.05079,0.03876],[0.05108,0.03812],[0.0517,0.03779],[0.052,0.03716],[0.0526,0.03652],[0.05321,0.03588],[0.05351,0.03525],[0.0538,0.03462],[0.0541,0.03398],[0.05439,0.03335],[0.05438,0.03273],[0.05467,0.03209],[0.05466,0.03147],[0.05464,0.03084],[0.05494,0.03021],[0.05492,0.02959],[0.0549,0.02896],[0.05458,0.02835],[0.05456,0.02772],[0.05454,0.0271],[0.05421,0.02648],[0.05389,0.02587],[0.05324,0.02526],[0.0526,0.02465],[0.05198,0.02467],[0.05168,0.0253],[0.05104,0.02469],[0.05071,0.02407],[0.05007,0.02347],[0.04943,0.02286],[0.0491,0.02224],[0.04847,0.02195],[0.04784,0.02165],[0.04722,0.02167],[0.04658,0.02137],[0.04595,0.02108],[0.04533,0.02109],[0.04469,0.0208],[0.04407,0.02081],[0.04344,0.02083],[0.04281,0.02053],[0.04219,0.02055],[0.04156,0.02057],[0.04093,0.02027],[0.04031,0.02029],[0.03967,0.01999],[0.03905,0.02001],[0.03842,0.02002],[0.0378,0.02004],[0.03717,0.01974],[0.03654,0.01976],[0.03592,0.01978],[0.03529,0.01979],[0.03466,0.0195],[0.03404,0.01951],[0.03341,0.01953],[0.03279,0.01955],[0.03216,0.01925],[0.03153,0.01927],[0.03091,0.01928],[0.03028,0.0193],[0.02966,0.01932],[0.02903,0.01933],[0.0284,0.01904],[0.02778,0.01905],[0.02715,0.01907],[0.02653,0.01909],[0.0259,0.0191],[0.02528,0.01912],[0.02466,0.01914],[0.02403,0.01915],[0.0234,0.01886],[0.02277,0.01887],[0.02215,0.01889],[0.02153,0.01891],[0.0209,0.01892],[0.02028,0.01894],[0.01965,0.01895],[0.01903,0.01897],[0.0184,0.01899],[0.01778,0.019],[0.01715,0.01902],[0.01653,0.01904],[0.01591,0.01905],[0.01528,0.01907],[0.01466,0.01909],[0.01403,0.0191],[0.01341,0.01912],[0.01278,0.01914],[0.01216,0.01915],[0.01154,0.01917],[0.01091,0.01918],[0.01029,0.01951],[0.00967,0.01953],[0.00905,0.01955],[0.00842,0.01956],[0.0078,0.01958],[0.00717,0.01959],[0.00656,0.01992],[0.00593,0.01994],[0.00531,0.01996],[0.00469,0.02028],[0.00407,0.0203],[0.00345,0.02063],[0.00283,0.02065],[0.00221,0.02097],[0.00159,0.0213],[0.00098,0.02163],[0.00036,0.02196],[-0.00025,0.02229],[-0.00087,0.02262],[-0.00149,0.02295],[-0.0021,0.02327],[-0.00271,0.02392],[-0.00332,0.02456],[-0.00393,0.02488],[-0.00423,0.02552],[-0.00484,0.02616],[-0.00513,0.02679],[-0.00574,0.02743],[-0.00604,0.02806],[-0.00602,0.02869],[-0.00632,0.02932],[-0.0063,0.02995],[-0.00628,0.03057],[-0.00658,0.0312],[-0.00656,0.03183],[-0.00655,0.03245],[-0.00653,0.03308],[-0.00651,0.0337],[-0.0065,0.03432],[-0.00587,0.03462],[-0.00524,0.0346],[-0.00462,0.03459],[-0.00399,0.03457],[-0.00336,0.03487],[-0.00274,0.03485],[-0.00211,0.03483],[-0.00149,0.03482],[-0.00086,0.0348],[-0.00024,0.03478],[0.00039,0.03477],[0.00101,0.03475],[0.00163,0.03474],[0.00227,0.03503],[0.00289,0.03501],[0.00352,0.035],[0.00414,0.03498],[0.00476,0.03497],[0.00539,0.03495],[0.00601,0.03493],[0.00665,0.03523],[0.00727,0.03521],[0.0079,0.0352],[0.00852,0.03518],[0.00914,0.03516],[0.00977,0.03515],[0.0104,0.03544],[0.01103,0.03543],[0.01165,0.03541],[0.01227,0.03539],[0.0129,0.03538],[0.01353,0.03567],[0.01416,0.03566],[0.01478,0.03564],[0.0154,0.03562],[0.01604,0.03592],[0.01666,0.0359],[0.01729,0.03589],[0.01791,0.03587],[0.01854,0.03617],[0.01917,0.03615],[0.01979,0.03613],[0.02042,0.03612],[0.02105,0.03641],[0.02167,0.0364],[0.0223,0.03638],[0.02292,0.03636],[0.02355,0.03666],[0.02418,0.03664],[0.0248,0.03663],[0.02543,0.03692],[0.02606,0.03691],[0.02668,0.03689],[0.02731,0.03687],[0.02794,0.03717],[0.02856,0.03715],[0.02919,0.03714],[0.02982,0.03743],[0.03045,0.03742],[0.03107,0.0374],[0.0317,0.03738],[0.03233,0.03768],[0.03295,0.03766],[0.03358,0.03765],[0.03421,0.03794],[0.03483,0.03793],[0.03546,0.03791],[0.03609,0.0382],[0.03671,0.03819],[0.03734,0.03817],[0.03797,0.03847],[0.0386,0.03845],[0.03922,0.03843],[0.03985,0.03873],[0.04048,0.03871],[0.0411,0.0387],[0.04173,0.03899],[0.04236,0.03898],[0.04298,0.03896],[0.04362,0.03926],[0.04424,0.03924],[0.04486,0.03922],[0.0455,0.03952],[0.04612,0.0395],[0.04675,0.03949],[0.04738,0.03978],[0.048,0.03977]]],"runner_w":0.004,"plate_y":0.0543,"sole_t":0.012,"plates":[[-0.1656,-0.1306,0.038],[-0.0332,0.0629,0.044]],"sole":{"back":-0.1706,"front":0.074,"w_back":0.062,"w_ball":0.088},"heel":{"back":-0.1686,"front":-0.1186,"width":0.058},"ball_from_mid":0.05,"pitch":0.2,"scale":{"l":1.0,"r":1.0},"sole_depth":{"l":0.03,"r":0.03}};
const SKATE_REF_FOOT = 0.19;  // heel-to-toe keypoint distance of the 0.23 m reference foot
const skateSteel = (opacity) => new THREE.MeshStandardMaterial({ color: 0xd9e1ea, roughness: 0.24, metalness: 0.62,
  emissive: 0x8796ab, emissiveIntensity: 0.28, transparent: opacity < 1, opacity });

function polygonShape(points, holes = []) {
  const trace = (path, pts) => { pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y))); path.closePath(); return path; };
  const s = trace(new THREE.Shape(), points);
  for (const h of holes) s.holes.push(trace(new THREE.Path(), h));
  return s;
}

function soleOutline(back, front, wBack, wBall) {
  // Top view (x forward, second coordinate = -z): a boot sole from heel to toe, widest at the ball (x = 0).
  const s = new THREE.Shape();
  s.moveTo(back, 0);
  s.bezierCurveTo(back, wBack * 0.55, back + 0.03, wBack / 2, back + 0.05, wBack / 2);
  s.bezierCurveTo(-0.04, wBack / 2, -0.03, wBall / 2, 0, wBall / 2);
  s.bezierCurveTo(0.04, wBall / 2, front, wBall * 0.3, front, 0);
  s.bezierCurveTo(front, -wBall * 0.3, 0.04, -wBall / 2, 0, -wBall / 2);
  s.bezierCurveTo(-0.03, -wBall / 2, -0.04, -wBack / 2, back + 0.05, -wBack / 2);
  s.bezierCurveTo(back + 0.03, -wBack / 2, back, -wBack * 0.55, back, 0);
  return s;
}

function heelOutline(back, front, w) {
  // Top view: the heel block, round at the back, straight across at the front.
  const s = new THREE.Shape(), r = w / 2;
  s.moveTo(front, r);
  s.lineTo(back + r, r);
  s.absarc(back + r, 0, r, Math.PI / 2, 3 * Math.PI / 2, false);
  s.lineTo(front, -r);
  s.closePath();
  return s;
}

function solid(shape, depth, bevel = 0) {
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 2, curveSegments: 12 });
}

function makeSkate(geo, opacity, shadows) {
  // Returns { group, blade }; the group's frame is the skate's (x forward, y up, z sideways), origin on the ice under
  // the ball when the blade stands on its sweet spot.
  const g = new THREE.Group();
  const steel = skateSteel(opacity);
  const t = Math.tan(geo.pitch);
  const soleY = (x) => geo.plate_y + Math.max(0, -x) * t;  // outsole underside, rising towards the heel
  const blade = new THREE.Mesh(solid(polygonShape(geo.blade, geo.blade_holes || []), geo.runner_w), steel);
  blade.position.z = -geo.runner_w / 2;
  g.add(blade);
  for (const [x0, x1, w] of geo.plates) {
    const plate = new THREE.Mesh(boxGeo, steel);
    plate.scale.set(x1 - x0, 0.0025, w);
    plate.position.set((x0 + x1) / 2, geo.plate_y - 0.00125, 0);
    g.add(plate);
  }
  const leather = new THREE.MeshStandardMaterial({ color: 0x4b3a2e, roughness: 0.7, metalness: 0.05,
    transparent: opacity < 1, opacity });
  const sole = solid(soleOutline(geo.sole.back, geo.sole.front, geo.sole.w_back, geo.sole.w_ball), geo.sole_t, 0.002);
  sole.rotateX(-Math.PI / 2);  // extrude along +y; the outline's second axis -> -z
  const pos = sole.attributes.position;
  for (let k = 0; k < pos.count; k++) pos.setY(k, pos.getY(k) + soleY(pos.getX(k)));
  sole.computeVertexNormals();
  g.add(new THREE.Mesh(sole, leather));
  const heel = solid(heelOutline(geo.heel.back, geo.heel.front, geo.heel.width), 1);
  heel.rotateX(-Math.PI / 2);
  const hp = heel.attributes.position;
  for (let k = 0; k < hp.count; k++) hp.setY(k, geo.plate_y + hp.getY(k) * (soleY(hp.getX(k)) - geo.plate_y));
  heel.computeVertexNormals();
  g.add(new THREE.Mesh(heel, leather));
  g.traverse((m) => { if (m.isMesh) m.castShadow = shadows; });
  return { group: g, blade, steel };
}

class Skater {
  constructor(track, replay, { opacity = track.opacity ?? 1, shadows = true } = {}) {
    this.track = track;
    this.names = replay.joints;
    this.idx = Object.fromEntries(replay.joints.map((n, i) => [n, i]));
    this.nJ = replay.joints.length;
    this.points = track.frames.map((f) => {
      const p = [];
      for (let j = 0; j < this.nJ; j++) p.push(v3(f[3 * j], f[3 * j + 1], f[3 * j + 2]));
      return p;
    });
    this.com = track.com.map((c) => v3(c[0], c[1], c[2]));
    // What the follow camera tracks: the centre of mass smoothed over ~0.3 s, so the camera glides instead of
    // carrying the per-frame noise of a single-camera reconstruction (3-4x the displayed body's jitter).
    this.follow = smoothPath(this.com, 0.3 * replay.fps);
    this.pose = Array.from({ length: this.nJ }, () => new THREE.Vector3());
    // Per-frame yaw and centre for spin-aware interpolation (see spinBlend).
    this.yaw = this.points.map((p) => frameYaw(p, this.idx));
    this.centre = this.points.map((p) => p.reduce((acc, q) => acc.add(q), new THREE.Vector3()).divideScalar(p.length));

    const transparent = opacity < 1;
    this.bodyMat = new THREE.MeshStandardMaterial({ color: track.color, roughness: 0.45, metalness: 0.1,
      emissive: track.color, emissiveIntensity: 0.12, transparent, opacity, depthWrite: !transparent });
    // Without an environment map a mirror-like metal renders black; keep the blade a lit, light steel.
    const steel = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.35, metalness: 0.5, emissive: 0x94a3b8,
      emissiveIntensity: 0.35, transparent, opacity });
    this.group = new THREE.Group();
    const add = (geo, mat, cast = shadows) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast;
      this.group.add(m);
      return m;
    };
    this.jointMeshes = this.names.map((n) => {
      const m = add(sphereGeo, this.bodyMat);
      m.userData.r = n === 'nose' || n.endsWith('ear') ? 0.001 : FOOT.test(n) ? 0.018 : 0.034;
      m.scale.setScalar(m.userData.r);
      return m;
    });
    this.jointHalos = this.names.map(() => { const m = add(sphereGeo, haloMat, false); m.visible = false; return m; });
    this.head = add(sphereGeo, this.bodyMat);
    this.head.scale.setScalar(0.105);
    // A skater's bun at the back of the head, with the female build of the mesh.
    this.bun = add(sphereGeo, new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.85, metalness: 0.0 }));
    this.bun.scale.set(0.04, 0.036, 0.04);
    this.bun.visible = false;
    this.neck = add(cylGeo, this.bodyMat);
    this.boneMeshes = replay.bones.map(([a, b]) => {
      const key = `${this.names[a]}-${this.names[b]}`;
      const r = TORSO.has(key) ? 0.045 : FOOT.test(key) ? 0.014 : 0.032;
      const halo = add(cylGeo, haloMat, false);
      halo.visible = false;
      return { a, b, r, mesh: add(cylGeo, this.bodyMat), halo };
    });
    this.steel = steel;
    // Skates in real proportions (makeSkate). The main track's replay carries the geometry and mounting it was put on
    // the ice with (summary.skates). Otherwise: the boot's pitch is the foot's while its blade is on the ice (the
    // heel-toe keypoint line points down to the toe), so the blade sits flat; the size follows the foot.
    const exported = track === replay.tracks?.[0] ? replay.summary?.skates : null;
    this.skateGeo = { ...DEFAULT_SKATES, ...(exported || {}) };
    if (!exported) {
      const pitches = [], lens = { l: [], r: [] };
      for (const p of this.points) {
        for (const s of ['l', 'r']) {
          const fr = this.footFrame(p, s);
          lens[s].push(fr.len);
          if (Math.min(p[this.idx[`${s}_heel`]].y, p[this.idx[`${s}_big_toe`]].y) < 0.11) pitches.push(-Math.asin(fr.fwd.y));
        }
      }
      this.skateGeo.pitch = THREE.MathUtils.clamp(pitches.length ? percentile(pitches, 0.5) : 0.2, 0.09, 0.28);
      this.skateGeo.scale = Object.fromEntries(['l', 'r'].map((s) =>
        [s, THREE.MathUtils.clamp(percentile(lens[s], 0.5) / SKATE_REF_FOOT, 0.85, 1.2)]));
    }
    this.measureSole = !exported;
    this.soleDepth = { ...this.skateGeo.sole_depth };  // mesh sole below the heel-toe keypoint line
    this.skates = {};
    this.blades = {};
    for (const s of ['l', 'r']) {
      const sk = makeSkate(this.skateGeo, opacity, shadows);
      sk.group.scale.set(this.skateGeo.scale[s], 1, this.skateGeo.scale[s]);
      this.group.add(sk.group);
      this.skates[s] = sk.group;
      this.blades[s] = sk.blade;
    }
    this.steel = this.blades.l.material;
    // Foot keypoints beyond the 21 joints (summary of skates.foot_points): the toe pick and the heel of the blade,
    // where the steel meets the ice, and the outer and inner ankle bones, whose line shows the ankle's tilt (edge).
    this.footPts = null;
    if (track.foot_points) {
      const n = track.foot_points.names.length;
      const parse = (rows) => rows.map((f) => Array.from({ length: n }, (_, k) => v3(f[3 * k], f[3 * k + 1], f[3 * k + 2])));
      this.footPts = { names: track.foot_points.names, l: parse(track.foot_points.l), r: parse(track.foot_points.r) };
      const bladeMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, emissive: 0xcbd5e1, emissiveIntensity: 0.5,
        roughness: 0.3, transparent, opacity, depthWrite: !transparent });
      this.footKeyMats = [bladeMat];
      // The ankle-bone line coloured by the edge it shows: outer bone higher = inside edge (blue), inner bone
      // higher = outside edge (orange), within 3 degrees = flat (white).
      const lineMat = (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.6, roughness: 0.4,
        transparent, opacity, depthWrite: !transparent });
      this.edgeLineMats = { inside: lineMat(0x3b82f6), outside: lineMat(0xf97316), flat: lineMat(0xf1f5f9),
        unseen: lineMat(0x64748b) };  // grey: the camera is not looking along the blade, so the edge cannot be read
      this.edgeVisible = track.foot_points.edge_visible || null;
      this.footMeshes = {};
      for (const s of ['l', 'r']) {
        this.footMeshes[s] = {
          points: this.footPts.names.map((name) => {
            const m = add(sphereGeo, name.startsWith('ankle') ? this.bodyMat : bladeMat);
            m.userData.r = name.startsWith('ankle') ? 0.014 : 0.006;
            return m;
          }),
          ankle: add(cylGeo, this.edgeLineMats.flat),  // no line along the blade: it would hide the rocker's curve
        };
      }
    }
    this.highlight = new Set();
    this.body = null;
    this.skeletonMats = [this.bodyMat, steel];

    // Measured skate points (toe, heel, inner, outer per foot) around the take-off, if any.
    this.skate = null;
    if (track.skate) {
      const toPts = (flat) => [0, 1, 2, 3].map((k) => v3(flat[3 * k], flat[3 * k + 1], flat[3 * k + 2]));
      this.skate = new Map(track.skate.frames.map((f, i) => [f, {
        l: toPts(track.skate.points.l[i]), r: toPts(track.skate.points.r[i]), roll: track.skate.roll[i],
      }]));
    }
    this.edgeMats = {
      outside: new THREE.MeshStandardMaterial({ color: 0xf97316, emissive: 0xf97316, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.4 }),
      inside: new THREE.MeshStandardMaterial({ color: 0x3b82f6, emissive: 0x3b82f6, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.4 }),
      unclear: new THREE.MeshStandardMaterial({ color: 0x9ca3af, emissive: 0x9ca3af, emissiveIntensity: 0.3, roughness: 0.3, metalness: 0.4 }),
    };

    // Distance from the heel-toe line down to the blade bottom, from on-ice frames.
    this.bladeDepth = {};
    for (const s of ['l', 'r']) {
      const h = this.points.map((p) => Math.min(p[this.idx[`${s}_heel`]].y, p[this.idx[`${s}_big_toe`]].y));
      this.bladeDepth[s] = THREE.MathUtils.clamp(percentile(h, 0.1), 0.04, 0.16);
    }
    this.buildTracing(opacity);
  }

  attachBody(body) {
    this.body = body;
    // Where the mesh's sole is (below the heel-toe keypoint line), so the outsole sits under it; and the boot upper.
    const feet = body.footVertices(this.names);
    for (const s of this.measureSole ? ['l', 'r'] : []) {
      const depth = [];
      for (let f = 0; f < body.T; f += 4) {
        const fr = this.footFrame(this.points[f], s);
        let lo = -1;
        for (const k of feet[s]) lo = Math.max(lo, body.vertex(f, k).sub(fr.mid).dot(fr.down));
        if (lo > 0) depth.push(lo);
      }
      if (depth.length) this.soleDepth[s] = THREE.MathUtils.clamp(percentile(depth, 0.5), 0.0, 0.06);
    }
    body.markBoot(this.points[0], this.idx);
    if (!this.track.mesh?.hair) body.markHair(this.points[0], this.idx);
    this.group.add(body.group);
    body.setFrame(this.frameNow ?? 0);
    this.setBodyMode(state.bodyMode);
  }

  setBodyMode(mode) {
    // 'both': surface with the keypoints and lines drawn over it; 'skeleton'; 'mesh'.
    const hasBody = !!this.body;
    const skeleton = !hasBody || mode !== 'mesh';
    this.jointMeshes.forEach((m) => { m.visible = skeleton; });
    this.boneMeshes.forEach((b) => { b.mesh.visible = skeleton; });
    for (const f of Object.values(this.footMeshes || {})) [...f.points, f.ankle].forEach((m) => { m.visible = skeleton; });
    this.head.visible = skeleton && !(hasBody && mode === 'both');
    this.neck.visible = this.head.visible;
    if (hasBody) this.body.group.visible = mode !== 'skeleton';
    // Over the surface, the skeleton is drawn on top like keypoints on the footage.
    const onTop = hasBody && mode === 'both';
    // Drawn in the transparent pass after the surface (renderOrder 3), ignoring its depth.
    for (const m of [this.bodyMat, hotMat, haloMat, ...(this.footKeyMats || []), ...Object.values(this.edgeLineMats || {})]) {
      if (m.userData.baseTransparent === undefined) m.userData.baseTransparent = m.transparent;
      m.transparent = onTop || m.userData.baseTransparent;
      m.depthTest = !onTop;
      m.depthWrite = !onTop && !m.userData.baseTransparent;
      m.needsUpdate = true;
    }
    const footKeys = Object.values(this.footMeshes || {}).flatMap((f) => [...f.points, f.ankle]);
    [...this.jointMeshes, ...this.boneMeshes.map((b) => b.mesh), this.head, this.neck, ...footKeys]
      .forEach((m) => { m.renderOrder = onTop ? 3 : 0; });
    const thin = onTop ? 0.55 : 1;
    this.boneMeshes.forEach((b) => { b.thin = thin; });
    this.jointMeshes.forEach((m) => { m.userData.thin = thin; });
  }

  setHighlight(joints) {
    this.highlight = new Set(joints || []);
    this.body?.setHighlight(this.highlight);
    this.jointMeshes.forEach((m, j) => {
      const hot = this.highlight.has(j) && m.userData.r > 0.01;
      m.material = hot ? hotMat : this.bodyMat;
      this.jointHalos[j].visible = hot;
    });
    for (const b of this.boneMeshes) {
      const hot = this.highlight.has(b.a) && this.highlight.has(b.b);
      b.mesh.material = hot ? hotMat : this.bodyMat;
      b.halo.visible = hot;
    }
  }

  footFrame(p, s) {
    const heel = p[this.idx[`${s}_heel`]];
    const toe = new THREE.Vector3().addVectors(p[this.idx[`${s}_big_toe`]], p[this.idx[`${s}_small_toe`]]).multiplyScalar(0.5);
    const ankle = p[this.idx[`${s}_ankle`]];
    const fwd = new THREE.Vector3().subVectors(toe, heel);
    const len = fwd.length();
    fwd.normalize();
    const mid = new THREE.Vector3().addVectors(heel, toe).multiplyScalar(0.5);
    const down = new THREE.Vector3().subVectors(mid, ankle);
    down.addScaledVector(fwd, -down.dot(fwd)).normalize();
    const side = new THREE.Vector3().crossVectors(fwd, down);
    return { mid, fwd, down, side, len };
  }

  bladeBottom(p, s) {
    const f = this.footFrame(p, s);
    return f.mid.clone().addScaledVector(f.down, this.bladeDepth[s]).addScaledVector(f.fwd, 0.015);
  }

  buildTracing(opacity) {
    // The line each blade draws on the ice while it is in contact: its curvature encodes the edge.
    this.tracing = new THREE.Group();
    this.ribbons = [];
    for (const s of ['l', 'r']) {
      const color = new THREE.Color(this.track.color).offsetHSL(0, 0, s === 'l' ? -0.1 : 0.15);
      if (this.track.tracing) {
        // Smooth tracings from the replay (spline-fitted, several samples per frame): a ribbon that grows with playback.
        for (const run of this.track.tracing[s]) this.ribbons.push(this.ribbon(run, color, opacity));
        continue;
      }
      const pts = [];
      let prev = null;
      for (const p of this.points) {
        const b = this.bladeBottom(p, s);
        const onIce = b.y < 0.04;
        if (onIce && prev) pts.push(new THREE.Vector3(prev.x, 0.003, prev.z), new THREE.Vector3(b.x, 0.003, b.z));
        prev = onIce ? b : null;
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.tracing.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 * opacity })));
    }
  }

  ribbon(run, color, opacity) {
    // run: [x, y, frame] rows. Two flat strips on the ice: a crisp core and a soft glow.
    const n = run.length;
    const times = new Float32Array(n);
    const make = (half, y, alpha, blending) => {
      const pos = new Float32Array(n * 6);
      for (let i = 0; i < n; i++) {
        const a = run[Math.max(i - 1, 0)], b = run[Math.min(i + 1, n - 1)];
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        const [x, yy] = run[i];
        const l = v3(x - dy * half, yy + dx * half, y), r = v3(x + dy * half, yy - dx * half, y);
        pos.set([l.x, l.y, l.z, r.x, r.y, r.z], 6 * i);
        times[i] = run[i][2];
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: alpha * opacity, depthWrite: false,
        side: THREE.DoubleSide, blending });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 2;
      this.tracing.add(mesh);
      return mesh;
    };
    // A blade groove is a few millimetres wide: an 8 mm core with a narrow glow, so the curve's shape stays readable.
    return { times, meshes: [make(0.014, 0.003, 0.18, THREE.AdditiveBlending), make(0.004, 0.0035, 0.95, THREE.NormalBlending)] };
  }

  revealTracing(f) {
    for (const r of this.ribbons) {
      let lo = 0, hi = r.times.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (r.times[mid] <= f) lo = mid + 1; else hi = mid; }
      for (const m of r.meshes) m.geometry.setDrawRange(0, Math.max(lo - 1, 0) * 6);
    }
  }

  setFrame(f) {
    this.frameNow = f;
    this.revealTracing(f);
    const n = this.points.length;
    const i = THREE.MathUtils.clamp(Math.floor(f), 0, n - 1);
    const t = THREE.MathUtils.clamp(f - i, 0, 1);
    const blend = spinBlend(i, t, this.yaw, this.centre);
    this.body?.setFrame(f, blend);
    const tmp = [0, 0, 0];
    for (let k = 0; k < this.nJ; k++) {
      if (t > 0) {
        const q = blend.idx.map((m) => this.points[m][k]);
        blendPoint(blend, q.map((v) => v.x), q.map((v) => v.y), q.map((v) => v.z), tmp, 0);
        this.pose[k].set(tmp[0], tmp[1], tmp[2]);
      } else this.pose[k].copy(this.points[i][k]);
    }
    const p = this.pose;
    this.jointMeshes.forEach((m, k) => {
      m.position.copy(p[k]);
      m.scale.setScalar(m.userData.r * (m.userData.thin ?? 1));
      this.jointHalos[k].position.copy(p[k]);
      this.jointHalos[k].scale.setScalar(m.userData.r * 2.4);
    });
    if (this.footPts) {
      for (const s of ['l', 'r']) {
        const fm = this.footMeshes[s], pts = this.footPts[s];
        const at = fm.points.map((m, k) => {
          if (t > 0) {
            const q = blend.idx.map((f) => pts[f][k]);
            blendPoint(blend, q.map((v) => v.x), q.map((v) => v.y), q.map((v) => v.z), tmp, 0);
            m.position.set(tmp[0], tmp[1], tmp[2]);
          } else m.position.copy(pts[i][k]);
          m.scale.setScalar(m.userData.r * (this.boneMeshes[0]?.thin ?? 1));
          return m.position;
        });
        placeCylinder(fm.ankle, at[2], at[3], 0.008 * (this.boneMeshes[0]?.thin ?? 1));
        const d = at[2].clone().sub(at[3]);
        const roll = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y / (d.length() || 1), -1, 1)));
        const seen = !this.edgeVisible || this.edgeVisible[s][Math.round(f)];
        fm.ankle.material = this.edgeLineMats[!seen ? 'unseen' : roll > 3 ? 'inside' : roll < -3 ? 'outside' : 'flat'];
      }
    }
    const head = new THREE.Vector3().add(p[this.idx.nose]).add(p[this.idx.l_ear]).add(p[this.idx.r_ear]).divideScalar(3);
    this.head.position.copy(head);
    this.bun.visible = !!this.body?.group.visible && this.track.mesh?.variant === 'female' && !this.body?.hairMesh;
    if (this.bun.visible) {
      const ear = p[this.idx.l_ear].clone().add(p[this.idx.r_ear]).multiplyScalar(0.5);
      const up = ear.clone().sub(p[this.idx.l_shoulder].clone().add(p[this.idx.r_shoulder]).multiplyScalar(0.5)).normalize();
      const fwd = p[this.idx.nose].clone().sub(ear);
      fwd.addScaledVector(up, -fwd.dot(up)).normalize();
      this.bun.position.copy(ear).addScaledVector(up, 0.07).addScaledVector(fwd, -0.09);
    }
    const neckBase = new THREE.Vector3().addVectors(p[this.idx.l_shoulder], p[this.idx.r_shoulder]).multiplyScalar(0.5);
    placeCylinder(this.neck, neckBase, head, 0.035);
    if (this.comMarker) this.comMarker.position.copy(this.comAt(f));
    for (const b of this.boneMeshes) {
      placeCylinder(b.mesh, p[b.a], p[b.b], b.r * (b.thin ?? 1));
      placeCylinder(b.halo, p[b.a], p[b.b], b.r * 2.6);
    }
    const measured = this.skate?.get(Math.round(f));
    for (const s of ['l', 'r']) {
      const fr = this.footFrame(p, s);
      if (measured) {
        // Tilt the blade by the boot roll measured from the skate keypoints.
        const [toe, heel, inner, outer] = measured[s];
        const fwd = new THREE.Vector3().subVectors(toe, heel).normalize();
        const lat = new THREE.Vector3().subVectors(outer, inner);
        lat.addScaledVector(fwd, -lat.dot(fwd)).normalize();
        const up = s === 'l' ? new THREE.Vector3().crossVectors(fwd, lat) : new THREE.Vector3().crossVectors(lat, fwd);
        fr.down = up.negate();
        fr.fwd = fwd;
        fr.side = new THREE.Vector3().crossVectors(fr.fwd, fr.down);
      }
      // Skate frame: the foot frame turned heel-down by the boot's pitch; origin on the ice under the ball.
      const c = Math.cos(this.skateGeo.pitch), sn = Math.sin(this.skateGeo.pitch);
      const x = fr.fwd.clone().multiplyScalar(c).addScaledVector(fr.down, -sn);
      const y = fr.down.clone().multiplyScalar(-c).addScaledVector(fr.fwd, -sn);
      const z = new THREE.Vector3().crossVectors(x, y);
      if (this.footMeshes) {
        // Lean the skate with the ankle: its side axis follows the inner-to-outer ankle-bone line (the edge).
        const ap = this.footMeshes[s].points;
        const l = ap[2].position.clone().sub(ap[3].position);
        l.addScaledVector(x, -l.dot(x));
        if (l.lengthSq() > 1e-8) {
          l.normalize();
          z.copy(l.dot(z) < 0 ? l.negate() : l);
          y.crossVectors(z, x).normalize();
        }
      }
      const g = this.skates[s];
      const ball = fr.mid.clone().addScaledVector(fr.fwd, this.skateGeo.ball_from_mid * g.scale.x)
        .addScaledVector(fr.down, this.soleDepth[s]);
      g.position.copy(ball).addScaledVector(y, -(this.skateGeo.plate_y + this.skateGeo.sole_t));
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    }
  }

  contactPoint(frame) {
    // Under the middle of the lower blade, on the ice.
    const p = this.points[THREE.MathUtils.clamp(frame, 0, this.points.length - 1)];
    const low = (s) => Math.min(p[this.idx[`${s}_heel`]].y, p[this.idx[`${s}_big_toe`]].y);
    const s = low('l') < low('r') ? 'l' : 'r';
    return p[this.idx[`${s}_heel`]].clone().add(p[this.idx[`${s}_big_toe`]]).multiplyScalar(0.5).setY(0);
  }

  setEdgeColor(side, kind) {
    this.blades[side].material = kind ? this.edgeMats[kind] : this.steel;
  }

  comAt(f, path = this.com) {
    const n = path.length;
    const i = THREE.MathUtils.clamp(Math.floor(f), 0, n - 1);
    const j = Math.min(i + 1, n - 1);
    return new THREE.Vector3().lerpVectors(path[i], path[j], THREE.MathUtils.clamp(f - i, 0, 1));
  }

  followAt(f) {
    return this.comAt(f, this.follow);
  }
}

function smoothPath(points, sigma) {
  // Gaussian smoothing over frames (edges renormalised), for camera targets only.
  const r = Math.ceil(3 * sigma), w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-0.5 * ((k - r) / sigma) ** 2));
  return points.map((_, i) => {
    const acc = new THREE.Vector3();
    let sum = 0;
    for (let k = -r; k <= r; k++) {
      const p = points[i + k];
      if (!p) continue;
      acc.addScaledVector(p, w[k + r]);
      sum += w[k + r];
    }
    return acc.divideScalar(sum);
  });
}

function placeCylinder(mesh, a, b, r) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
  mesh.scale.set(r, Math.max(len, 1e-4), r);
}

// ---------- trajectory and event markers ----------
function ringSprite(color, size) {
  // A circle with a centre dot that faces the camera and draws over the body, so a point inside the body (the centre
  // of mass) stays visible. Dark outline for contrast on ice and suit alike.
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  for (const [w, style] of [[16, 'rgba(6,10,20,0.75)'], [9, hex]]) {
    x.lineWidth = w; x.strokeStyle = style;
    x.beginPath(); x.arc(64, 64, 52, 0, 2 * Math.PI); x.stroke();
  }
  x.fillStyle = 'rgba(6,10,20,0.75)'; x.beginPath(); x.arc(64, 64, 15, 0, 2 * Math.PI); x.fill();
  x.fillStyle = hex; x.beginPath(); x.arc(64, 64, 10, 0, 2 * Math.PI); x.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  s.scale.set(size, size, 1);
  s.renderOrder = 10;
  return s;
}

function buildOverlays(skater, events) {
  const g = new THREE.Group();
  const col = new THREE.Color(skater.track.color);
  const op = skater.track.opacity ?? 1;
  // The centre of mass's whole path, as a tube (1.4 cm across) so it reads from any distance; the flight arc 4 cm.
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(skater.com), skater.com.length * 2, 0.007, 8, false),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6 * op, depthWrite: false })));
  if (op === 1) {
    // Where the path passes through the body at this frame (moved in Skater.setFrame).
    skater.comMarker = ringSprite(0xe0f2fe, 0.09);
    g.add(skater.comMarker);
  }
  if (events && events.landing > events.takeoff + 2) {
    const flight = skater.com.slice(events.takeoff, events.landing);
    const curve = new THREE.CatmullRomCurve3(flight);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, flight.length * 3, 0.02, 10, false),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: op })));
    if (op < 1) return g;
    // Take-off and touchdown rings: small (5 cm), on the blade's contact point, not under the centre of mass.
    const rot = state.replay?.summary?.rotation;
    const ring = (point, color) => {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 48), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(point.x, 0.004, point.z);
      g.add(m);
    };
    ring(rot?.takeoff_point ? v3(rot.takeoff_point[0], rot.takeoff_point[1], 0) : skater.contactPoint(events.takeoff - 1), 0x22c55e);
    ring(rot?.landing_point ? v3(rot.landing_point[0], rot.landing_point[1], 0) : skater.contactPoint(events.landing), 0xef4444);
    // The apex: a ring over the body where the arc peaks, and a dashed drop to the ice (1 cm dashes, not a 1-px line).
    const apex = skater.com[events.apex];
    const top = ringSprite(0xf59e0b, 0.13);
    top.position.copy(apex);
    g.add(top);
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b, transparent: true, opacity: 0.9 });
    for (let y = apex.y; y > 0.01; y -= 0.1) {
      const dash = new THREE.Mesh(cylGeo, dashMat);
      placeCylinder(dash, new THREE.Vector3(apex.x, y, apex.z), new THREE.Vector3(apex.x, Math.max(y - 0.06, 0), apex.z), 0.005);
      g.add(dash);
    }
  }
  return g;
}

// ---------- rotation at touchdown ----------
// The instant the landing blade touches the ice decides the rotation call. The replay pauses there, and on the ice
// it shows the landing blade's direction (solid), where a reference jump's blade would point (dashed), and the
// angle between them. Data: summary.rotation from scripts/video_to_replay.py (rotation_call + knowledge).
const CALL_STYLE = {
  full: { color: 0x22c55e, label: 'Fully rotated', severity: 'info' },
  q: { color: 0xf59e0b, label: 'q · landed on the quarter', severity: 'minor' },
  '<': { color: 0xf97316, label: '< · under-rotated', severity: 'major' },
  '<<': { color: 0xef4444, label: '<< · downgraded', severity: 'major' },
  // The measurement's uncertainty is wider than the 90-degree bands: show the angle, make no call.
  uncertain: { color: 0x94a3b8, label: 'no call at this frame rate', severity: 'info' },
};
const rotationMarkerParts = [];
// The text in the scene (names and boxes), shown only with the Labels button; the lines and angle values always show.
const sceneLabels = [];
function sceneLabel(obj) {
  obj.visible = state.showLabels;
  sceneLabels.push(obj);
  return obj;
}

function rotationNote(replay) {
  const r = replay.summary?.rotation;
  if (!r || r.call === undefined) return null;
  const st = CALL_STYLE[r.call];
  const side = r.landing_foot;
  const idx = Object.fromEntries(replay.joints.map((n, i) => [n, i]));
  const leg = ['hip', 'knee', 'ankle', 'heel', 'big_toe', 'small_toe'].map((n) => idx[`${side}_${n}`]);
  const short = r.shortfall_deg;
  return {
    kind: 'rotation', frame: r.touchdown_frame, shown: false, severity: st.severity, anchor: idx[`${side}_ankle`],
    joints: ['q', '<', '<<'].includes(r.call) ? leg : [], check: 'rotation',
    text: `Touchdown · ${st.label}`,
    detail: `Blade turned ${Math.round(r.rotation_deg)}° from take-off to touchdown; reference ${replay.summary.jump} `
      + `${replay.summary.level} jumps turn ${Math.round(r.reference_deg)}° (${r.reference_n}). `
      + `${short >= 0 ? 'Short by' : 'Beyond by'} ${Math.abs(Math.round(short))}° (± ${Math.round(r.tolerance_deg)}°). `
      + `Touchdown at ${(r.touchdown_frame / replay.fps).toFixed(3)} s, spin ${Math.round(r.landing_spin_dps)}°/s.`
      + (r.call === 'uncertain' ? ` At ${Math.round(replay.fps)} fps the measurement is ±${Math.round(r.tolerance_deg)}°, wider than`
        + ' the quarter-turn bands; film at 120-240 fps for a q / < / << call.' : ''),
  };
}

function iceStrip(point, yawDeg, length, width, color, opacity, dashed = false, back = 0) {
  // A flat strip on the ice along world yaw `yawDeg`, from `back` behind `point` (replay x, y) to `length - back` ahead.
  const g = new THREE.Group();
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const dir = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  const start = v3(point[0], point[1], 0.006).addScaledVector(dir, -back);
  const pieces = dashed ? 7 : 1;
  for (let k = 0; k < pieces; k++) {
    if (dashed && k % 2) continue;
    const seg = length / pieces;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(seg, width), new THREE.MeshBasicMaterial({ color, transparent: true,
      opacity, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');
    m.position.copy(start).addScaledVector(dir, seg * (k + 0.5));
    m.renderOrder = 3;
    g.add(m);
  }
  return g;
}

function textSprite(text, color, extra = []) {
  // One line in a box framed in `color`; `extra` adds lines below it as [text, color] (text in that colour).
  const lines = [[text, null], ...extra];
  const c = document.createElement('canvas');
  c.width = 512; c.height = 16 + 80 * lines.length;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(6,10,20,0.78)';
  x.beginPath(); x.roundRect(4, 8, 504, c.height - 16, 18); x.fill();
  x.strokeStyle = `#${color.toString(16).padStart(6, '0')}`; x.lineWidth = 3; x.stroke();
  x.font = '600 40px ui-monospace, Menlo, monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
  lines.forEach(([t, col], i) => {
    x.fillStyle = col === null ? '#e6edf7' : `#${col.toString(16).padStart(6, '0')}`;
    x.fillText(t, 256, 50 + 80 * i);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(0.9, 0.17 * c.height / 96, 1);
  sp.renderOrder = 5;
  return sp;
}

function tagSprite(text, color) {
  // A short name in `color` on a dark box sized to the text, at textSprite's scale (512 px across 0.9 m).
  const font = '600 34px ui-monospace, Menlo, monospace';
  const c = document.createElement('canvas');
  const x = c.getContext('2d');
  x.font = font;
  c.width = Math.ceil(x.measureText(text).width) + 32; c.height = 56;
  x.fillStyle = 'rgba(6,10,20,0.78)';
  x.beginPath(); x.roundRect(2, 2, c.width - 4, c.height - 4, 14); x.fill();
  x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  x.fillText(text, c.width / 2, c.height / 2 + 1);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.scale.set(c.width * 0.9 / 512, c.height * 0.9 / 512, 1);
  sp.renderOrder = 5;
  return sp;
}

function iceArrowhead(point, yawDeg, size, color, opacity) {
  // A flat triangle on the ice centred on `point` (replay x, y), pointing along world yaw `yawDeg`.
  const shape = new THREE.Shape([new THREE.Vector2(size / 2, 0), new THREE.Vector2(-size / 2, size / 2),
    new THREE.Vector2(-size / 2, -size / 2)]);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, transparent: true,
    opacity, depthWrite: false, side: THREE.DoubleSide }));
  m.rotation.set(-Math.PI / 2, THREE.MathUtils.degToRad(yawDeg), 0, 'YXZ');
  m.position.copy(v3(point[0], point[1], 0.007));
  m.renderOrder = 3;
  return m;
}

// Rotation done on the ice, drawn where it happens as an angle with two named sides from the blade's contact point,
// both on the heel's side:
// - the glide line (white): the entry (or exit) path, on the side the heel points while gliding straight along it.
//   Gliding forwards (an Axel's entry) the heel trails, so it points back along the path the skater came in on;
//   gliding backwards (every other entry, every exit) the heel leads, so it points ahead in the direction of travel.
//   The line runs on through the point, dashed, with arrowheads in the direction of travel;
// - the blade at take-off (or touchdown), from toe to heel, in the angle's colour;
// - the arc between them, swept the jump's way round, with its value and an arrowhead in the direction the blade
//   turns: at take-off from the entry line to the take-off blade, after touchdown from the landing blade to the exit line.
// The glide side is the longer, so the two names stay apart at small angles.
const PRE_COLOR = 0xe879f9;
const UNDER_COLOR = 0x60a5fa;
const GLIDE_COLOR = 0xe6edf7;
const GLIDE_RAY_M = 1.25;
const BLADE_RAY_M = 0.85;
const ANGLE_ARC_M = 0.5;

function onIceAngle(point, travelDeg, glideDeg, sweepDeg, color, glideName, bladeName, valueDeg, toGlide = false) {
  const g = new THREE.Group();
  const at = (deg, r) => {
    const a = THREE.MathUtils.degToRad(deg);
    return [point[0] + r * Math.cos(a), point[1] + r * Math.sin(a)];
  };
  const name = (text, col, deg, r) => {
    const s = sceneLabel(tagSprite(text, col));
    const [x, y] = at(deg, r);
    s.position.copy(v3(x, y, 0.12));
    return s;
  };
  const bladeDeg = glideDeg + sweepDeg;
  g.add(iceStrip(point, glideDeg, GLIDE_RAY_M, 0.014, GLIDE_COLOR, 0.95));
  g.add(iceStrip(point, glideDeg + 180, GLIDE_RAY_M, 0.008, GLIDE_COLOR, 0.5, true));
  for (const r of [0.62, 0.98]) g.add(iceArrowhead(at(glideDeg + 180, r), travelDeg, 0.07, GLIDE_COLOR, 0.7));
  g.add(name(glideName, GLIDE_COLOR, glideDeg, GLIDE_RAY_M + 0.1));
  g.add(iceStrip(point, bladeDeg, BLADE_RAY_M, 0.014, color, 0.95));
  g.add(name(bladeName, color, bladeDeg, BLADE_RAY_M + 0.1));
  // Swept by the signed angle (not the shorter way round): a Salchow's blade turns past half a turn on the ice.
  const a0 = THREE.MathUtils.degToRad(glideDeg);
  const d = THREE.MathUtils.degToRad(sweepDeg);
  const arc = new THREE.Mesh(new THREE.RingGeometry(ANGLE_ARC_M, ANGLE_ARC_M + 0.014, 64, 1, Math.min(a0, a0 + d), Math.abs(d)),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false }));
  arc.rotation.x = -Math.PI / 2;
  arc.position.copy(v3(point[0], point[1], 0.008));
  arc.renderOrder = 3;
  g.add(arc);
  // The arrowhead's tip on the side the turn ends at, pointing along the arc.
  const size = 0.08;
  const dir = Math.sign(sweepDeg) * (toGlide ? -1 : 1);
  const endDeg = toGlide ? glideDeg : glideDeg + sweepDeg;
  const back = THREE.MathUtils.radToDeg(size / 2 / (ANGLE_ARC_M + 0.007));
  if (dir) g.add(iceArrowhead(at(endDeg - dir * back, ANGLE_ARC_M + 0.007), endDeg - dir * back + dir * 90, size, color, 0.95));
  const value = tagSprite(`${Math.round(valueDeg)}°`, color);
  const [x, y] = at(glideDeg + sweepDeg / 2, ANGLE_ARC_M + 0.16);
  value.position.copy(v3(x, y, 0.06));
  g.add(value);
  // Drawn over the body, like the centre-of-mass rings: the skater stands on the vertex at take-off and touchdown.
  g.traverse((o) => { if (o.material) o.material.depthTest = false; });
  return g;
}

function rotationMarkers(r) {
  rotationMarkerParts.length = 0;
  sceneLabels.length = 0;
  const g = new THREE.Group();
  const take = new THREE.Group();
  take.userData.from = r.takeoff_frame;
  const turn = r.direction === 'cw' ? -1 : 1;
  if (r.pre_rotation_deg !== undefined) {
    // Pre-rotation: from the heel gliding in along the entry line to the heel as the blade leaves the ice
    // (entry_blade_deg is where the toe points gliding in).
    take.add(onIceAngle(r.takeoff_point, r.entry_deg, r.entry_blade_deg + 180, turn * r.pre_rotation_deg, PRE_COLOR,
      'Entry line', 'Take-off blade', r.pre_rotation_deg));
    const label = sceneLabel(textSprite(`Pre-rotation ${Math.round(r.pre_rotation_deg)}°`, PRE_COLOR));
    label.position.copy(v3(r.takeoff_point[0], r.takeoff_point[1], 0.32));
    take.add(label);
  } else {
    take.add(iceStrip(r.takeoff_point, r.blade_yaw_takeoff_deg, 0.26, 0.006, 0x22c55e, 0.95, false, 0.2));
  }
  g.add(take);
  rotationMarkerParts.push(take);
  if (r.call === undefined) return g;
  const st = CALL_STYLE[r.call];
  const land = new THREE.Group();
  land.userData.from = r.touchdown_frame;
  land.add(iceStrip(r.landing_point, r.blade_yaw_touchdown_deg, 0.26, 0.007, st.color, 0.95, false, 0.2));
  // Where the blade would point after the reference jumps' rotation.
  const sign = r.direction === 'cw' ? -1 : 1;
  const refYaw = r.blade_yaw_takeoff_deg + sign * r.reference_deg;
  land.add(iceStrip(r.landing_point, refYaw, 0.26, 0.005, 0xe6edf7, 0.85, true, 0.2));
  const a0 = THREE.MathUtils.degToRad(r.blade_yaw_touchdown_deg);
  const d = wrapAngle(THREE.MathUtils.degToRad(refYaw) - a0);
  const arc = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.208, 48, 1, Math.min(a0, a0 + d), Math.abs(d)),
    new THREE.MeshBasicMaterial({ color: st.color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
  arc.rotation.x = -Math.PI / 2;
  arc.position.copy(v3(r.landing_point[0], r.landing_point[1], 0.007));
  arc.renderOrder = 3;
  land.add(arc);
  const short = Math.round(r.shortfall_deg);
  const verdict = r.call === 'full' ? 'FULL' : r.call === 'uncertain' ? `±${Math.round(r.tolerance_deg)}°` : r.call;
  const under = r.under_rotation_deg !== undefined;
  const label = sceneLabel(textSprite(`${short >= 0 ? short + '° short' : -short + '° beyond'} · ${verdict}`, st.color,
    under ? [[`Under-rotation ${Math.round(r.under_rotation_deg)}°`, UNDER_COLOR]] : []));
  label.position.copy(v3(r.landing_point[0], r.landing_point[1], under ? 0.4 : 0.32));
  land.add(label);
  if (under) {
    // Under-rotation: from the heel as the blade touches to the heel gliding out along the exit line, which gliding
    // backwards is the direction of travel.
    land.add(onIceAngle(r.landing_point, r.exit_deg, r.exit_deg, -turn * r.under_rotation_deg, UNDER_COLOR,
      'Exit line', 'Landing blade', r.under_rotation_deg, true));
  }
  g.add(land);
  rotationMarkerParts.push(land);
  return g;
}

// ---------- side panels ----------
const METRICS = [
  ['air_time_s', 'Air time', (v) => `${v.toFixed(2)} s`],
  ['height_from_air_time_m', 'Height (air time)', (v) => `${(v * 100).toFixed(0)} cm`],
  ['com_rise_m', 'CoM rise', (v) => `${(v * 100).toFixed(0)} cm`],
  ['turns_in_air', 'Turns in air', (v) => Math.abs(v).toFixed(2)],
  ['peak_rotation_speed_dps', 'Peak spin', (v) => `${v.toFixed(0)}°/s`],
  ['horizontal_distance_m', 'Distance', (v) => `${v.toFixed(2)} m`],
  ['horizontal_speed_mps', 'Speed', (v) => `${v.toFixed(2)} m/s`],
  ['pre_rotation_deg', 'Pre-rotation', (v) => `${v.toFixed(0)}°`],
  ['under_rotation_deg', 'Under-rotation', (v) => `${v.toFixed(0)}°`],
  ['free_foot_down_s', 'Free foot after landing', (v) => (v === null ? 'held up' : `down at ${v.toFixed(2)} s`)],
  ['step_out_s', 'Step-out', (v) => (v === null ? 'none' : `at ${v.toFixed(2)} s`)],
  ['fall_s', 'Fall', (v) => (v === null ? 'none' : `at ${v.toFixed(2)} s`)],
  ['hand_down_s', 'Hand down', (v) => (v === null ? 'none' : `at ${v.toFixed(2)} s`)],
  ['speed_kept', 'Speed kept', (v) => `${Math.round(v * 100)}%`],
];

function renderMetrics(tracks) {
  const head = `<tr class="head"><th></th>${tracks.map((t) => `<td style="color:${t.color}">${t.name}</td>`).join('')}</tr>`;
  // Under a value, the class's typical one where the replay carries it (track.reference, reference_library.json).
  const typical = (t, key, fmt) => {
    const r = t.reference?.[key];
    return r ? `<small title="${r.n} reference jumps, 10-90%: ${fmt(r.p10)}-${fmt(r.p90)}">typ. ${fmt(r.median)}</small>` : '';
  };
  const rows = METRICS.map(([key, label, fmt]) =>
    `<tr><th>${label}</th>${tracks.map((t) => `<td>${t.metrics && key in t.metrics ? fmt(t.metrics[key]) + typical(t, key, fmt) : '–'}</td>`).join('')}</tr>`);
  $('metrics-table').innerHTML = head + rows.join('');
}

// ---------- the on-ice angles, seen from above ----------
// The same angles as in the scene, drawn flat so no camera foreshortens them, each turned so the skater travels up the
// card: the glide line (white; solid on the heel's side, dashed on the other, with arrowheads in the direction of
// travel), the blade from toe to heel at take-off or touchdown (in colour) and the arc between them, with the
// arrowhead of the turn as in the scene.
function iceAngleSvg(travelDeg, glideDeg, sweepDeg, valueDeg, color, glideName, bladeName, toGlide = false) {
  const W = 140, H = 116, C = 70, CY = 58, R = 40, ARC = 15;
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  const glide = '#e6edf7';
  const at = (deg, r) => {
    const a = THREE.MathUtils.degToRad(deg - travelDeg + 90);
    return [C + r * Math.cos(a), CY - r * Math.sin(a)];
  };
  const f = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  const bladeDeg = glideDeg + sweepDeg;
  // Names. The glide ray runs straight up or down the card, so its name goes past the tip. The blade's goes past the
  // tip of a ray across the card, and beside the tip of one along it (past it is the glide line's name). Both stay
  // inside the card (8.5 px monospace runs about 5.1 px a character).
  const [gx, gy] = at(glideDeg, R + 6);
  const glideLabel = `<text x="${gx.toFixed(1)}" y="${(gy + 3).toFixed(1)}" text-anchor="middle" fill="${glide}">${glideName}</text>`;
  const [tx, ty] = at(bladeDeg, R);
  const across = Math.abs(tx - C) > Math.abs(ty - CY);
  const left = tx < C;
  const w = bladeName.length * 5.1;
  let bx = across ? at(bladeDeg, R + 5)[0] : tx + (left ? -5 : 5);
  bx = left ? Math.max(bx, 2 + w) : Math.min(bx, W - 2 - w);
  // Beside the tip it sits a little towards the centre, clear of the glide line's name past the same end.
  const by = across ? ty + 3 : ty < CY ? ty + 9 : ty - 3;
  const bladeLabel = `<text x="${bx.toFixed(1)}" y="${by.toFixed(1)}" text-anchor="${left ? 'end' : 'start'}" fill="${hex}">${bladeName}</text>`;
  const back = glideDeg + 180;
  const arrows = [0.45, 0.85].map((k) => {
    const [x, y] = at(back, R * k);
    return `<path d="M${x.toFixed(1)} ${(y - 4).toFixed(1)}L${(x - 3.2).toFixed(1)} ${(y + 2.4).toFixed(1)}L${(x + 3.2).toFixed(1)} ${(y + 2.4).toFixed(1)}Z" fill="${glide}" opacity="0.75"/>`;
  }).join('');
  const a0 = at(glideDeg, ARC), a1 = at(bladeDeg, ARC);
  // Swept the jump's way round: anticlockwise on the card is anticlockwise on the ice seen from above.
  const arc = Math.abs(sweepDeg) < 0.5 ? ''
    : `<path d="M${f(a0)}A${ARC} ${ARC} 0 ${Math.abs(sweepDeg) > 180 ? 1 : 0} ${sweepDeg > 0 ? 0 : 1} ${f(a1)}" fill="none" stroke="${hex}" stroke-width="1.6"/>`;
  const dir = Math.sign(sweepDeg) * (toGlide ? -1 : 1);
  const endDeg = toGlide ? glideDeg : bladeDeg;
  const tip = at(endDeg, ARC), mid = at(endDeg - dir * THREE.MathUtils.radToDeg(6.5 / ARC), ARC);
  const [ux, uy] = [(tip[0] - mid[0]) / 6.5, (tip[1] - mid[1]) / 6.5];
  const head = Math.abs(sweepDeg) < 0.5 ? ''
    : `<path d="M${f(tip)}L${f([mid[0] - 3.4 * uy, mid[1] + 3.4 * ux])}L${f([mid[0] + 3.4 * uy, mid[1] - 3.4 * ux])}Z" fill="${hex}"/>`;
  // The value sits on the bisector past the arc; for a narrow angle, beside the arc away from the blade instead.
  let [vx, vy] = at(glideDeg + sweepDeg / 2, ARC + 10);
  let vAnchor = 'middle';
  if (Math.abs(sweepDeg) < 30) {
    [vx, vy] = at(glideDeg + sweepDeg / 2, ARC);
    vAnchor = tx < C ? 'start' : 'end';
    vx = C + (tx < C ? 5 : -5);
  }
  return `<svg viewBox="0 0 ${W} ${H}" font-family="ui-monospace, Menlo, monospace" font-size="8.5">
    <line x1="${f(at(back, R)).replace(' ', '" y1="')}" x2="${C}" y2="${CY}" stroke="${glide}" stroke-width="1" stroke-dasharray="3 3" opacity="0.55"/>
    ${arrows}
    <line x1="${C}" y1="${CY}" x2="${f(at(glideDeg, R)).replace(' ', '" y2="')}" stroke="${glide}" stroke-width="2.2" stroke-linecap="round"/>
    <line x1="${C}" y1="${CY}" x2="${f(at(bladeDeg, R)).replace(' ', '" y2="')}" stroke="${hex}" stroke-width="2.6" stroke-linecap="round"/>
    ${arc}
    ${head}
    <circle cx="${C}" cy="${CY}" r="2.2" fill="${glide}"/>
    <text x="${vx.toFixed(1)}" y="${(vy + 3).toFixed(1)}" text-anchor="${vAnchor}" fill="${hex}" font-weight="700">${Math.round(valueDeg)}°</text>
    ${glideLabel}
    ${bladeLabel}
  </svg>`;
}

// The class's reference jumps (mocap): typical value and their 10-90% range.
const typical = (ref) => (ref ? ` Reference jumps: typically ${Math.round(ref.median)}° (${Math.round(ref.p10)}-${Math.round(ref.p90)}°, ${ref.n} jumps).` : '');

function renderIce(replay) {
  const r = replay.summary?.rotation;
  const turn = r?.direction === 'cw' ? -1 : 1;
  const cards = [];
  if (r?.pre_rotation_deg !== undefined) {
    const v = Math.round(r.pre_rotation_deg);
    cards.push([r.takeoff_frame, PRE_COLOR, 'Take-off', `Pre-rotation ${v}°`,
      iceAngleSvg(r.entry_deg, r.entry_blade_deg + 180, turn * r.pre_rotation_deg, r.pre_rotation_deg, PRE_COLOR, 'entry line', 'heel'),
      (v >= 0 ? `As it left the ice, the blade had already turned ${v}° from the entry line.`
        : `As it left the ice, the blade had turned ${-v}° against the jump from the entry line.`) + typical(r.pre_rotation_reference)]);
  }
  if (r?.under_rotation_deg !== undefined) {
    const v = Math.round(r.under_rotation_deg);
    cards.push([r.touchdown_frame, UNDER_COLOR, 'Landing', `Under-rotation ${v}°`,
      iceAngleSvg(r.exit_deg, r.exit_deg, -turn * r.under_rotation_deg, r.under_rotation_deg, UNDER_COLOR, 'exit line', 'heel', true),
      (v >= 0 ? `As it touched down, the blade was ${v}° short of the exit line; the rest is turned on the ice.`
        : `As it touched down, the blade was already ${-v}° past the exit line.`) + typical(r.under_rotation_reference)]);
  }
  $('ice-panel').style.display = cards.length ? 'block' : 'none';
  const grid = $('ice-grid');
  grid.innerHTML = cards.map(([frame, color, when, title, svg, caption]) => `<figure data-frame="${frame}" title="Go to this frame">
    <div class="eyebrow">${when}</div><b style="color:#${color.toString(16).padStart(6, '0')}">${title}</b>${svg}
    <figcaption>${caption}</figcaption></figure>`).join('')
    + (cards.length ? `<figcaption style="grid-column: 1 / -1">The skater travels up each card. Both lines run from where
      the blade leaves or meets the ice towards the heel's side. White: the glide line, back along the path for a forward
      entry (the Axel's), ahead for a backward one and for the landing. Colour: the blade, toe to heel.</figcaption>` : '');
  grid.querySelectorAll('figure').forEach((el) => el.addEventListener('click', () => { pause(); setFrame(+el.dataset.frame); }));
}

// ---------- metrics over time ----------
// The replay's per-frame metrics file (viewer/metrics/<replay>.json, skatesense/timeline.py), one chosen series at a
// time: left and right sides in two colours, the air shaded, take-off and touchdown marked, a cursor at the frame
// shown. Clicking the chart goes to that frame.
const SERIES = [
  ['knee_deg', 'Knee angle', '°'], ['hip_deg', 'Hip angle', '°'], ['ankle_deg', 'Ankle angle', '°'],
  ['elbow_deg', 'Elbow angle', '°'], ['shoulder_deg', 'Arm raised from the trunk', '°'],
  ['trunk_tilt_deg', 'Trunk tilt from vertical', '°'], ['trunk_lean_deg', 'Trunk lean (forward / left)', '°'],
  ['shoulder_hip_twist_deg', 'Shoulder-hip twist', '°'], ['turns_from_takeoff', 'Turns since take-off', ''],
  ['spin_dps', 'Spin rate', '°/s'], ['speed_mps', 'Horizontal speed', 'm/s'], ['com_height', 'Centre of mass height', 'm'],
  ['wrist_from_axis_pct', 'Wrist from the trunk axis', '% body'], ['ankle_separation_pct', 'Ankle separation', '% body'],
  ['blade_height_m', 'Blade height above the ice', 'm'], ['blade_pitch_deg', 'Blade pitch (toe up)', '°'],
];
const SIDE_COLORS = { l: '#22d3ee', r: '#f472b6', forward: '#22d3ee', left: '#f472b6' };
const SIDE_NAMES = { l: 'L', r: 'R', forward: 'fwd', left: 'left' };

// Reference bands (viewer/reference/series.json, scripts/build_series_reference.py): per jump class and series, the
// mocap jumps' 10/50/90% on a time line aligned at take-off and touchdown. Loaded once.
let seriesRef = null;
async function loadSeriesReference() {
  if (seriesRef !== null) return;
  try {
    const r = await fetch('reference/series.json', FRESH);
    seriesRef = r.ok ? await r.json() : false;
  } catch { seriesRef = false; }
}

async function loadSeries(file) {
  state.series = null;
  await loadSeriesReference();
  try {
    const res = await fetch(`metrics/${file}`, FRESH);
    if (res.ok) state.series = await res.json();
  } catch { /* no metrics file: the panel stays hidden */ }
  const f = state.series?.frames;
  $('series-panel').style.display = f ? 'block' : 'none';
  if (!f) return;
  const pick = $('series-pick');
  const have = SERIES.filter(([k]) => k === 'com_height' ? f.com_m : f[k]);
  pick.innerHTML = have.map(([k, label, unit]) => `<option value="${k}">${label}${unit ? ` (${unit})` : ''}</option>`).join('');
  if (have.some(([k]) => k === state.seriesKey)) pick.value = state.seriesKey;
  renderSeries();
}

function seriesLines(key) {
  const f = state.series.frames;
  if (key === 'com_height') return { '': f.com_m.map((c) => c?.[2] ?? null) };
  const v = f[key];
  return Array.isArray(v) ? { '': v } : v;
}

function renderSeries() {
  const f = state.series?.frames;
  if (!f) return;
  state.seriesKey = $('series-pick').value;
  const lines = seriesLines(state.seriesKey);
  const ev = state.series.events || {};
  // The class's reference band, mapped onto this replay's own take-off and touchdown.
  const cls = seriesRef?.classes?.[`${state.series.summary?.jump}_${state.series.summary?.level}`];
  const bands = [];
  // One camera's steady offset per phase (summary.series_error, scripts/eval_series.py) moves the band, so it shows
  // what one camera reads for the reference jumps: knees, for example, read 8-10° more bent in the air and on landing.
  const shift = state.series.summary?.series_error?.series?.[state.seriesKey]?.offset_by_phase;
  if (cls && ev.takeoff_frame != null && ev.touchdown_frame != null) {
    const g = seriesRef.grid, fps = state.series.fps, t0 = ev.takeoff_frame, t1 = ev.touchdown_frame;
    const at = [...g.pre_s.map((t) => t0 + t * fps), ...g.air_fraction.map((u) => t0 + u * (t1 - t0)),
      ...g.post_s.map((t) => t1 + t * fps)];
    // the phase of each grid point, as skatesense/timeline.py's phases(): take-off 0.35 s, landing 0.3 s
    const phase = [...g.pre_s.map((t) => (t >= -0.35 ? 'takeoff' : 'approach')), ...g.air_fraction.map(() => 'air'),
      ...g.post_s.map((t) => (t < 0.3 ? 'landing' : 'exit'))];
    for (const side of Object.keys(lines)) {
      let q = cls.series[side ? `${state.seriesKey}.${side}` : state.seriesKey];
      if (q && shift) q = q.map((row) => row.map((v, i) => (v === null ? null : v + (shift[phase[i]] ?? 0))));
      if (q) bands.push({ side, at, q });
    }
  }
  state.seriesBandN = bands.length ? cls.n : 0;
  state.seriesBandShifted = Boolean(bands.length && shift);
  const all = [...Object.values(lines).flat(), ...bands.flatMap((b) => [...b.q[0], ...b.q[2]])]
    .filter((v) => v !== null && Number.isFinite(v));
  if (!all.length) { $('series-chart').innerHTML = ''; return; }
  let lo = Math.min(...all), hi = Math.max(...all);
  const padY = Math.max((hi - lo) * 0.08, 1e-3);
  lo -= padY; hi += padY;
  const W = 270, H = 112, n = f.frame.length;
  const x = (i) => (i / Math.max(n - 1, 1)) * W;
  const y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
  const bandSvg = bands.map(({ side, at, q }) => {
    const pts = at.map((f, i) => [f, q[0][i], q[1][i], q[2][i]]).filter(([f, a, , b]) => f >= 0 && f <= n - 1 && a !== null && b !== null);
    if (pts.length < 2) return '';
    const color = SIDE_COLORS[side] || '#e6edf7';
    const upper = pts.map(([f, , , b], i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)},${y(b).toFixed(1)}`).join('');
    const lower = pts.slice().reverse().map(([f, a]) => `L${x(f).toFixed(1)},${y(a).toFixed(1)}`).join('');
    const mid = pts.map(([f, , m], i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)},${y(m).toFixed(1)}`).join('');
    return `<path d="${upper}${lower}Z" fill="${color}" fill-opacity="0.10" stroke="none"/>
      <path d="${mid}" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 3"/>`;
  }).join('');
  const shade = ev.takeoff_frame != null && ev.touchdown_frame != null
    ? `<rect x="${x(ev.takeoff_frame)}" y="0" width="${x(ev.touchdown_frame) - x(ev.takeoff_frame)}" height="${H}" fill="rgba(245,158,11,0.10)"/>
       <line x1="${x(ev.takeoff_frame)}" x2="${x(ev.takeoff_frame)}" y1="0" y2="${H}" stroke="#22c55e" stroke-width="1"/>
       <line x1="${x(ev.touchdown_frame)}" x2="${x(ev.touchdown_frame)}" y1="0" y2="${H}" stroke="#e6edf7" stroke-width="1"/>` : '';
  const zero = lo < 0 && hi > 0 ? `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(148,163,184,0.35)" stroke-dasharray="3 3"/>` : '';
  const paths = Object.entries(lines).map(([side, v]) => {
    let d = '', pen = false;
    v.forEach((val, i) => {
      if (val === null || !Number.isFinite(val)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(val).toFixed(1)}`;
      pen = true;
    });
    return `<path d="${d}" fill="none" stroke="${SIDE_COLORS[side] || 'rgba(230,237,247,0.85)'}" stroke-width="1.4"/>`;
  });
  $('series-chart').innerHTML = `${shade}${bandSvg}${zero}${paths.join('')}
    <text x="3" y="10" fill="#8b9bb4" font-size="8.5" font-family="ui-monospace, Menlo, monospace">${+hi.toPrecision(3)}</text>
    <text x="3" y="${H - 3}" fill="#8b9bb4" font-size="8.5" font-family="ui-monospace, Menlo, monospace">${+lo.toPrecision(3)}</text>
    <line id="series-cursor" x1="0" x2="0" y1="0" y2="${H}" stroke="#facc15" stroke-width="1.5"/>`;
  state.seriesChart = { x, n };
  updateSeriesCursor();
}

function updateSeriesCursor() {
  if (!state.series?.frames || !state.seriesChart) return;
  const i = THREE.MathUtils.clamp(Math.round(state.frame), 0, state.seriesChart.n - 1);
  const c = document.getElementById('series-cursor');
  if (c) { c.setAttribute('x1', state.seriesChart.x(i)); c.setAttribute('x2', state.seriesChart.x(i)); }
  const unit = SERIES.find(([k]) => k === state.seriesKey)?.[2] || '';
  const f = state.series.frames;
  const fmt = (v) => (v === null || v === undefined ? '–' : `${Math.abs(v) >= 100 ? Math.round(v) : (+v).toFixed(2)}${unit && !unit.startsWith('%') ? unit : ''}`);
  const read = Object.entries(seriesLines(state.seriesKey)).map(([side, v]) => `<span>${side ? `<i style="background:${SIDE_COLORS[side]}"></i>${SIDE_NAMES[side]}` : ''} ${fmt(v[i])}</span>`);
  const band = state.seriesBandN ? ` · band: ${state.seriesBandN} reference jumps, 10-90%${state.seriesBandShifted ? ', as one camera reads them' : ''}` : '';
  // One camera's typical error on this series at the clip's frame rate (summary.series_error, scripts/eval_series.py).
  const se = state.series.summary?.series_error?.series?.[state.seriesKey];
  const errUnit = unit === '°' ? '°' : unit ? ` ${unit}` : state.seriesKey === 'turns_from_takeoff' ? ' turns' : '';
  const fmtErr = (v) => `${+(+v).toPrecision(3)}${errUnit}`;
  const err = se ? `<br>one camera vs mocap: ±${fmtErr(se.median)} typical, ±${fmtErr(se.p90)} at the 90th percentile` : '';
  // The numbers are the measurement track's (source.track), not the smoothed body drawn, which can differ a little.
  const measured = state.series.source?.track?.startsWith('measurement') ? '<br>measured on the reconstruction, not on the smoothed body drawn' : '';
  $('series-read').innerHTML = `${read.join('')}<small>${f.phase[i]} · ${(+f.t_s[i]).toFixed(2)} s from take-off${band}${err}${measured}</small>`;
}

$('series-pick').addEventListener('change', renderSeries);
$('series-chart').addEventListener('click', (e) => {
  if (!state.seriesChart) return;
  const r = e.currentTarget.getBoundingClientRect();
  pause();
  setFrame(Math.round(((e.clientX - r.left) / r.width) * (state.seriesChart.n - 1)));
});

// ---------- the judge's view: GOE ----------
// The GOE range that what one camera measured allows (skatesense/goe.py, ISU Communication 2788, 2026/27): the
// bullets it can judge, the errors it found (seen: at both ends of the range; possible: only at the low end) and the
// bullets left to the judge's eye, which widen the range upwards.
const GOE_MARK = { yes: '✓', no: '✗', unsure: '?', judge: '·' };
const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');

function renderGoe(replay) {
  const g = replay.summary?.goe;
  $('goe-panel').style.display = g ? 'block' : 'none';
  if (!g) return;
  const [lo, hi] = g.goe;
  const x = (v) => ((v + 5) / 10) * 100;
  const ticks = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map((v) => `<span class="mark" style="left:${x(v)}%">${signed(v)}</span>`);
  $('goe-main').innerHTML = `<b>${lo === hi ? signed(lo) : `${signed(lo)} to ${signed(hi)}`}</b>
    <span>starting GOE ${signed(g.start[0])} to ${signed(g.start[1])},<br>then the reductions</span>`;
  const pts = (e) => (e.range[0] === e.range[1] ? signed(e.range[0]) : `${signed(e.range[0])} to ${signed(e.range[1])}`);
  const bullets = g.bullets.map((b) => `<div class="goe-row"><span class="goe-mark ${b.status}">${GOE_MARK[b.status]}</span>
    <span class="what">${b.n}. ${b.text}</span><span class="goe-pts">${b.status === 'yes' ? '+1' : b.status === 'unsure' ? '+1?' : ''}</span>
    <small>${b.status === 'judge' ? 'left to the judge: ' : ''}${b.why}</small></div>`);
  const errors = g.errors.length ? g.errors.map((e) => `<div class="goe-row${e.frame != null ? ' click' : ''}"${e.frame != null ? ` data-frame="${e.frame}" title="Go to this frame"` : ''}>
    <span class="goe-mark ${e.status === 'seen' ? 'no' : 'unsure'}">!</span><span class="what">${e.error}</span>
    <span class="goe-pts ${e.status}">${pts(e)}</span><small>${e.status === 'possible' ? 'possible: ' : ''}${e.why}</small></div>`)
    : ['<div class="goe-row"><span class="goe-mark yes">✓</span><span class="what">No error seen</span><span></span></div>'];
  $('goe-body').innerHTML = `<div class="goe-scale"><div class="track"></div>
      <div class="range" style="left:calc(${x(lo)}% - 6px); width:calc(${x(hi) - x(lo)}% + 12px)"></div>${ticks.join('')}</div>
    <div class="goe-h">Positive aspects</div>${bullets.join('')}
    <div class="goe-h">Reductions</div>${errors.join('')}
    <div class="goe-foot">Not checked yet: ${g.not_detected.join('; ')}. Rules: ${g.source}.</div>`;
  $('goe-body').querySelectorAll('[data-frame]').forEach((el) => el.addEventListener('click', () => { pause(); setFrame(+el.dataset.frame); }));
}

// ---------- take-off and landing frames, set by hand ----------
// The flight is found in the 3D reconstruction, checked against mocap on level cameras only (FS-Jump3D, within 5
// degrees). From a higher camera, depth errors turn into foot heights and the times can be frames off, so the panel
// says so and a coach steps to the last frame on the ice and the first frame back on it. Applying re-renders the
// replay with those instants (scripts/serve_viewer.py): the 3D body, the blades and every angle depend on them.
// The skater's height is set here too: one camera cannot tell a small skater near it from a tall one further away,
// so the height scales the CoM height, the distances and the speeds (README, "The skater's height sets the size").
const HIGH_CAMERA_DEG = 10;
const HEIGHT_RANGE_M = [1.0, 2.2];
const DEFAULT_HEIGHT_M = 1.7;

function heightValue() {
  const h = parseFloat($('timing-height').value);
  return Number.isFinite(h) && h >= HEIGHT_RANGE_M[0] && h <= HEIGHT_RANGE_M[1] ? Math.round(h * 100) / 100 : null;
}

function renderTiming(replay) {
  const r = replay.summary?.rotation;
  const render = replay.summary?.render;
  $('timing-panel').style.display = r && render ? 'block' : 'none';
  if (!r || !render) return;
  state.timingAuto = { takeoff: Math.floor(r.takeoff_frame), landing: Math.ceil(r.touchdown_frame) };
  state.timing = { ...state.timingAuto };
  const tilt = replay.summary.camera?.tilt_deg;
  $('timing-note').innerHTML = r.set_by_hand ? '<span class="chip ok"><span class="dot"></span>Set by hand</span>'
    : tilt > HIGH_CAMERA_DEG ? `<div class="timing-note">The camera looks down ${Math.round(tilt)}°. Take-off and
      landing are only verified for level cameras: step through the frames below to check them.</div>` : '';
  $('timing-auto').style.display = r.set_by_hand ? '' : 'none';
  state.heightAuto = replay.summary.skater_height_m ?? DEFAULT_HEIGHT_M;
  $('timing-height').value = state.heightAuto.toFixed(2);
  const given = render.args.some((a) => a === '--height' || a.startsWith('--height='));
  $('timing-height-note').textContent = given ? 'sets the size: CoM height, distances, speeds'
    : `not given: ${DEFAULT_HEIGHT_M.toFixed(2)} m assumed. It sets the CoM height, distances and speeds`;
  if (!state.rerendering) $('timing-status').textContent = '';
  updateTiming();
}

function updateTiming() {
  $('timing-takeoff').textContent = `f${state.timing.takeoff}`;
  $('timing-landing').textContent = `f${state.timing.landing}`;
  const h = heightValue();
  const changed = ['takeoff', 'landing'].some((k) => state.timing[k] !== state.timingAuto[k])
    || (h !== null && Math.abs(h - state.heightAuto) >= 0.005);
  $('timing-apply').disabled = !changed || h === null || state.rerendering;
  $('timing-auto').disabled = state.rerendering;
}

async function rerender(times, height = null) {
  const file = $('replay-select').value;
  const start = state.replay.summary.camera.start;
  const body = { replay: file, takeoff: null, touchdown: null, height };
  if (times) {
    // The instants between the frames the coach picked, on the video's frame clock.
    body.takeoff = start + times.takeoff + 0.5;
    body.touchdown = start + times.landing - 0.5;
  }
  const status = $('timing-status');
  let res;
  try {
    res = await fetch('api/rerender', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
  } catch {
    res = null;
  }
  if (!res || res.status === 404 || res.status === 501) {
    status.textContent = 'Re-rendering needs the local server: scripts/serve_viewer.py.';
    return;
  }
  if (!res.ok) {
    status.textContent = (await res.json().catch(() => ({}))).error || `Re-render refused (${res.status}).`;
    return;
  }
  state.rerendering = true;
  updateTiming();
  const t0 = performance.now();
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 2000));
    status.textContent = `Re-rendering… ${Math.round((performance.now() - t0) / 1000)} s`;
    const job = await (await fetch('api/rerender/status', FRESH)).json();
    if (job.running) continue;
    state.rerendering = false;
    if (job.returncode !== 0) {
      status.textContent = `Re-render failed: ${(job.log || []).slice(-1)[0] || 'see data/rerender.log'}`;
      updateTiming();
      return;
    }
    const took = Math.round((performance.now() - t0) / 1000);
    await loadReplay(file);
    status.textContent = `Re-rendered in ${took} s.`;
    return;
  }
}

document.querySelectorAll('#timing-panel .stepper button').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.key;
  const t = { ...state.timing, [key]: state.timing[key] + Number(b.dataset.step) };
  if (t.landing - t.takeoff < 3 || t[key] < 0 || t[key] >= state.nFrames) return;
  state.timing = t;
  pause();
  setFrame(t[key]);
  updateTiming();
}));
document.querySelectorAll('#timing-panel .stepper b').forEach((b) => b.addEventListener('click', () => {
  pause();
  setFrame(state.timing[b.dataset.key]);
}));
$('timing-apply').addEventListener('click', () => {
  // Frames go along only when the coach moved them, or when they were already set by hand: an unchanged automatic
  // flight is found again, so a height change alone does not freeze it.
  const moved = ['takeoff', 'landing'].some((k) => state.timing[k] !== state.timingAuto[k]);
  const keep = moved || state.replay.summary?.rotation?.set_by_hand;
  rerender(keep ? state.timing : null, heightValue()).catch(showError);
});
$('timing-auto').addEventListener('click', () => rerender(null, heightValue()).catch(showError));
$('timing-height').addEventListener('input', updateTiming);

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderNotes(replay) {
  const box = $('notes');
  const summary = replay.summary || {};
  box.innerHTML = '';
  if (summary.quality && summary.quality.ok === false) {
    box.insertAdjacentHTML('beforeend', `<div class="warning">${esc(summary.quality.advice)}</div>`);
    if (!state.notes.length) return;
  }
  if (!state.notes.some((n) => n.kind !== 'rotation')) {
    box.insertAdjacentHTML('beforeend', summary.reference
      ? `<div class="clean">✓ Clean jump: every check is within the reference range.</div>`
      : `<div class="clean" style="color:var(--muted)">No coach notes for this replay.</div>`);
  }
  state.notes.forEach((n, i) => {
    const b = document.createElement('button');
    b.className = 'note';
    b.innerHTML = `<span class="t">${(n.frame / state.fps).toFixed(2)}s</span><span class="title">${esc(n.text)}</span><span class="sev"><b>${esc(n.severity)}</b> · ${noteMeasure(n)}</span>`;
    b.addEventListener('click', () => { pause(); setFrame(n.frame); });
    n.el = b;
    box.appendChild(b);
  });
  if (summary.reference) {
    const ref = document.createElement('div');
    ref.className = 'insight';
    ref.textContent = `Compared with ${summary.reference}.` + (summary.insight ? ` ${summary.insight}` : '');
    box.appendChild(ref);
  }
}

function noteMeasure(n) {
  const r = state.replay.summary?.rotation;
  if (n.kind === 'rotation' && r) {
    const short = Math.round(r.shortfall_deg);
    return `blade ${Math.round(r.rotation_deg)}° vs ${Math.round(r.reference_deg)}° (${short >= 0 ? '−' + short : '+' + -short}°, ±${Math.round(r.tolerance_deg)}°)`;
  }
  if (n.check === 'takeoff_edge') return `boot roll ${state.replay.summary?.edge?.roll_deg?.toFixed(1)}°`;
  if (n.check === 'free_foot_down') return `free blade down ${n.after_s.toFixed(2)} s after touchdown`;
  if (n.check === 'step_out') return `landing blade up ${n.after_s.toFixed(2)} s after touchdown`;
  if (n.check === 'fall') return `hips down to the ice ${n.after_s.toFixed(2)} s after touchdown`;
  if (n.check === 'hand_down') return `hand on the ice ${n.after_s.toFixed(2)} s after touchdown`;
  return `${(n.score ?? 0).toFixed(1)}σ from reference`;
}

const EDGE_LABEL = { outside: 'Outside edge', inside: 'Inside edge' };
const VERDICT = {
  correct: ['ok', '✓ Correct edge'],
  'wrong edge': ['bad', 'Wrong edge (e)'],
  unclear: ['air', 'Unclear edge (!)'],
  'camera angle': ['air', 'Camera angle: low confidence'],
  'no data': ['', 'No edge data'],
};

function renderEdge(replay) {
  const e = replay.summary?.edge;
  const panel = $('edge-panel');
  if (!e) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const [cls, text] = VERDICT[e.verdict] || ['', e.verdict];
  const kind = e.verdict === 'unclear' ? 'unclear' : e.measured;
  const label = e.verdict === 'unclear' ? 'Nearly flat' : EDGE_LABEL[e.measured] || '–';
  $('edge-main').innerHTML = `<span class="edge-dot ${kind}"></span>${label}
    <span class="chip ${cls}">${text}</span>`;
  const acc = e.accuracy ? `${Math.round(e.accuracy * 100)}% measured accuracy` : '';
  $('edge-facts').innerHTML = `
    <div><b>${e.roll_deg > 0 ? '+' : ''}${e.roll_deg.toFixed(1)}°</b><span>boot roll</span></div>
    <div><b>${e.view_angle_deg.toFixed(0)}°</b><span>camera off blade</span></div>
    <div><b>${e.required ? e.required : '–'}</b><span>${esc(e.jump)} needs</span></div>`;
  $('edge-note').textContent = [
    e.verdict === 'camera angle' ? 'Film in line with the take-off (in front of or behind) to read the edge.' : '',
    acc ? `Call from the boot tilt 0.40–0.10 s before take-off · ${acc}.` : '',
  ].filter(Boolean).join(' ');
  drawRollChart();
}

function drawRollChart() {
  const svg = $('edge-chart');
  const sk = state.skaters[0]?.track.skate;
  const e = state.replay?.summary?.edge;
  if (!sk || !e) { svg.innerHTML = ''; return; }
  const W = 270, H = 64, pad = 4, lim = 15;
  const tk = state.skaters[0].track.events?.takeoff ?? e.window[1];
  // Only the frames on the ice: once the take-off foot leaves, its roll means nothing.
  const pts = sk.frames.map((f, i) => [f, sk.roll[i]]).filter(([f]) => f <= tk);
  if (!pts.length) { svg.innerHTML = ''; return; }
  const f0 = pts[0][0], f1 = tk;
  const x = (f) => pad + ((f - f0) / Math.max(f1 - f0, 1)) * (W - 2 * pad);
  const y = (r) => H / 2 + (Math.max(-lim, Math.min(lim, r)) / lim) * (H / 2 - pad);   // + roll (inner side down) plots lower
  const path = pts.map(([f, r], i) => `${i ? 'L' : 'M'}${x(f).toFixed(1)},${y(r).toFixed(1)}`).join('');
  const [w0, w1] = e.window;
  const color = e.verdict === 'unclear' ? '#9ca3af' : e.measured === 'outside' ? '#f97316' : '#3b82f6';
  svg.innerHTML = `
    <rect x="${x(w0)}" y="0" width="${Math.max(x(w1) - x(w0), 1)}" height="${H}" fill="rgba(148,163,184,0.12)"/>
    <line x1="${pad}" x2="${W - pad}" y1="${H / 2}" y2="${H / 2}" stroke="rgba(148,163,184,0.35)" stroke-dasharray="3 3"/>
    <text x="${pad}" y="10" fill="#f97316" font-size="9" font-family="ui-monospace">outer side down</text>
    <text x="${pad}" y="${H - 3}" fill="#3b82f6" font-size="9" font-family="ui-monospace">inner side down</text>
    <text x="${W - pad}" y="10" text-anchor="end" fill="#f59e0b" font-size="9" font-family="ui-monospace">take-off</text>
    <line x1="${x(tk)}" x2="${x(tk)}" y1="0" y2="${H}" stroke="#f59e0b" stroke-width="1"/>
    <path d="${path}" fill="none" stroke="rgba(230,237,247,0.75)" stroke-width="1.3"/>
    <line x1="${x(w0)}" x2="${x(w1)}" y1="${y(e.roll_deg)}" y2="${y(e.roll_deg)}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>
    <line id="edge-cursor" x1="0" x2="0" y1="0" y2="${H}" stroke="#22d3ee" stroke-width="1.5"/>`;
  state.edgeChart = { x, f0, f1 };
}

function updateEdgeView() {
  const sk = state.skaters[0];
  const e = state.replay?.summary?.edge;
  if (!sk || !e || !sk.skate) return;
  const f = Math.round(state.frame);
  const tk = sk.track.events?.takeoff ?? e.window[1];
  const inWindow = f >= e.window[0] && f <= tk;
  const kind = e.verdict === 'unclear' ? 'unclear' : e.measured;
  sk.setEdgeColor('l', inWindow ? kind : null);
  const cursor = document.getElementById('edge-cursor');
  if (cursor && state.edgeChart) {
    const { x, f0, f1 } = state.edgeChart;
    const on = f >= f0 && f <= f1;
    cursor.setAttribute('visibility', on ? 'visible' : 'hidden');
    if (on) { cursor.setAttribute('x1', x(f)); cursor.setAttribute('x2', x(f)); }
  }
  const tag = $('edge-tag');
  const m = sk.skate.get(f);
  if (inWindow && m && state.showLabels) {
    const c = new THREE.Vector3().add(m.l[0]).add(m.l[1]).multiplyScalar(0.5).project(camera);
    tag.style.display = 'block';
    tag.style.left = `${((c.x + 1) / 2) * window.innerWidth + 14}px`;
    tag.style.top = `${((1 - c.y) / 2) * window.innerHeight + 10}px`;
    tag.className = `edge-tag ${kind}`;
    // The take-off call (median over the window), not this frame's noisy roll.
    tag.textContent = `${e.verdict === 'unclear' ? 'FLAT' : e.measured.toUpperCase()} EDGE · ${e.roll_deg > 0 ? '+' : ''}${e.roll_deg.toFixed(1)}°`;
  } else {
    tag.style.display = 'none';
  }
}

function renderChips(replay) {
  const s = replay.summary || {};
  const chips = [];
  if (s.jump) chips.push(`<span class="chip accent">${esc([s.level, s.jump].filter(Boolean).join(' '))}</span>`);
  const edgeValid = s.edge && s.edge.verdict !== 'camera angle';
  if (s.quality) chips.push(s.quality.ok ? '<span class="chip ok"><span class="dot"></span>Tracking OK</span>'
    : edgeValid ? '<span class="chip air"><span class="dot"></span>3D: side view needed</span>'
      : '<span class="chip bad"><span class="dot"></span>Re-film advised</span>');
  const faults = state.notes.filter((n) => n.severity !== 'info').length;
  if (s.reference) chips.push(faults ? `<span class="chip bad">${faults} note${faults > 1 ? 's' : ''}</span>`
    : '<span class="chip ok">Clean</span>');
  $('chips').innerHTML = chips.join('');
}

function renderLegend() {
  $('legend').innerHTML = '';
  state.skaters.forEach((s, i) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" checked><span class="swatch" style="background:${s.track.color}"></span>${esc(s.track.name)}`;
    label.querySelector('input').addEventListener('change', (e) => {
      s.group.visible = e.target.checked;
      s.tracing.visible = e.target.checked;
      s.overlays.visible = e.target.checked;
    });
    $('legend').appendChild(label);
  });
}

function renderTimeline() {
  const ev = state.skaters[0]?.track.events || {};
  const pct = (f) => `${(100 * f) / Math.max(state.nFrames - 1, 1)}%`;
  const band = $('flight-band');
  if (ev.landing > ev.takeoff) {
    band.style.display = 'block';
    band.style.left = pct(ev.takeoff);
    band.style.width = `calc(${pct(ev.landing - 1)} - ${pct(ev.takeoff)})`;
  } else band.style.display = 'none';
  const rot = state.replay?.summary?.rotation;
  const exact = rot ? [[rot.takeoff_frame, 'takeoff', 'Take-off'], [rot.touchdown_frame, 'touchdown', 'Touchdown']]
    .map(([f, cls, label]) => `<div class="tick ${cls}" style="left:${pct(f)}" title="${label} ${(f / state.fps).toFixed(3)} s"></div>`).join('') : '';
  $('ticks').innerHTML = state.notes.filter((n) => n.kind !== 'rotation')
    .map((n) => `<div class="tick" style="left:${pct(n.frame)}"></div>`).join('') + exact;
}

// ---------- loading ----------
const dynamic = new THREE.Group();
scene.add(dynamic);

async function loadReplay(file) {
  const res = await fetch(`replays/${file}`, FRESH);
  if (!res.ok) throw new Error(`Could not load ${file} (${res.status})`);
  const replay = await res.json();
  dynamic.clear();
  state.replay = replay;
  state.fps = replay.fps;
  state.notes = (replay.annotations || []).map((n) => ({ ...n, shown: false }));
  const rotNote = rotationNote(replay);
  if (rotNote) state.notes = [...state.notes, rotNote].sort((a, b) => a.frame - b.frame);
  state.activeNote = null;
  state.hold = null;
  state.skaters = replay.tracks.map((t) => new Skater(t, replay));
  state.nFrames = Math.max(...state.skaters.map((s) => s.points.length));
  for (const s of state.skaters) {
    if (!s.track.mesh) continue;
    s.meshBuffer = await (await fetch(`replays/${s.track.mesh.file}`, FRESH)).arrayBuffer();
    s.attachBody(new BodyMesh(s.track.mesh, s.meshBuffer, replay.bones));
    await loadHair(s);
  }
  $('body-mode').disabled = !state.skaters.some((s) => s.body);
  const variants = Object.keys(state.skaters[0]?.track.mesh?.variants || {});
  $('body-type').style.display = variants.length > 1 ? '' : 'none';
  $('body-type').textContent = BODY_LABEL[state.skaters[0]?.track.mesh?.variant] || 'Body';
  for (const s of state.skaters) {
    s.overlays = buildOverlays(s, s.track.events);
    if (s === state.skaters[0] && replay.summary?.rotation) s.overlays.add(rotationMarkers(replay.summary.rotation));
    dynamic.add(s.group, s.tracing, s.overlays);
  }
  const primary = state.skaters[0];
  const ev = primary.track.events || {};
  if (ev.landing > ev.takeoff) {
    const d = new THREE.Vector3().subVectors(primary.com[ev.landing - 1], primary.com[ev.takeoff]).setY(0);
    state.jumpDir = d.lengthSq() > 1e-6 ? d.normalize() : new THREE.Vector3(1, 0, 0);
  }
  const video = $('pip-video');
  if (video.dataset.blob) URL.revokeObjectURL(video.dataset.blob);
  if (replay.video) {
    // Load the clip as a blob so seeking works even on servers without HTTP range support.
    const blob = await (await fetch(replay.video, FRESH)).blob();
    video.dataset.blob = URL.createObjectURL(blob);
    video.src = video.dataset.blob;
    $('pip').style.display = state.showVideo ? 'block' : 'none';
    $('video-toggle').disabled = false;
  } else {
    video.removeAttribute('src');
    $('pip').style.display = 'none';
    $('video-toggle').disabled = true;
  }
  const fc = filmingCamera();
  if (backdrop.dataset.blob) URL.revokeObjectURL(backdrop.dataset.blob);
  backdrop.removeAttribute('src');
  delete backdrop.dataset.blob;
  if (fc?.video) {
    const blob = await (await fetch(fc.video, FRESH)).blob();
    backdrop.dataset.blob = URL.createObjectURL(blob);
    backdrop.src = backdrop.dataset.blob;
  }
  $('camera-view').disabled = !fc?.video;
  $('title').textContent = replay.title;
  $('source').textContent = replay.source;
  $('scrub').max = String(state.nFrames - 1);
  renderMetrics(replay.tracks);
  renderEdge(replay);
  renderIce(replay);
  renderGoe(replay);
  if (!HERO) await loadSeries(file);
  renderTiming(replay);
  renderNotes(replay);
  renderChips(replay);
  renderLegend();
  renderTimeline();
  document.querySelectorAll('button.event').forEach((b) => { b.disabled = !(b.dataset.event in ev); });
  pause();
  setFrame(ev.takeoff !== undefined ? Math.max(0, ev.takeoff - Math.round(state.fps * 0.7)) : 0);
  setView(fc?.video ? 'camera' : 'side');
}

async function init() {
  try {
    const list = await (await fetch('replays/index.json', FRESH)).json();
    const select = $('replay-select');
    for (const r of list) select.add(new Option(r.title, r.file));
    const wanted = new URLSearchParams(location.search).get('replay');
    const file = list.some((r) => r.file === wanted) ? wanted : list[0]?.file;
    if (!file) throw new Error('No replays found in viewer/replays/.');
    select.value = file;
    select.addEventListener('change', () => {
      const url = new URL(location.href);
      url.searchParams.set('replay', select.value);
      history.replaceState(null, '', url);
      loadReplay(select.value).catch(showError);
    });
    await loadReplay(file);
    if (HERO) heroStart();
  } catch (err) {
    showError(err);
  }
}

function showError(err) {
  const box = $('error');
  box.style.display = 'flex';
  box.textContent = `Error: ${err.message}`;
  console.error(err);
}

// ---------- playback, notes, camera ----------
function setFrame(f) {
  state.frame = THREE.MathUtils.clamp(f, 0, state.nFrames - 1);
  for (const s of state.skaters) s.setFrame(state.frame);
  for (const m of rotationMarkerParts) m.visible = state.frame >= m.userData.from - 1e-3;
  const pct = (100 * state.frame) / Math.max(state.nFrames - 1, 1);
  $('scrub').value = String(state.frame);
  $('progress').style.width = `${pct}%`;
  $('thumb').style.left = `${pct}%`;
  $('time').textContent = `${(state.frame / state.fps).toFixed(2)} s · f${Math.floor(state.frame)}`;
  const ev = state.skaters[0]?.track.events || {};
  const inAir = ev.takeoff !== undefined && state.frame >= ev.takeoff && state.frame < ev.landing;
  $('phase').textContent = inAir ? 'In the air' : 'On ice';
  $('phase').className = inAir ? 'chip air' : 'chip';
  if (!state.hold) {
    const near = state.notes.filter((n) => Math.abs(n.frame - state.frame) <= state.fps * 0.12);
    setActiveNote(state.playing ? null : near.sort((a, b) => Math.abs(a.frame - state.frame) - Math.abs(b.frame - state.frame))[0] || null);
  }
  updateSeriesCursor();
  if (HERO) heroHud();
}

function setActiveNote(note) {
  if (state.activeNote === note) return;
  state.activeNote = note;
  state.skaters[0]?.setHighlight(note ? note.joints : null);
  state.notes.forEach((n) => n.el?.classList.toggle('active', n === note));
  $('callout').style.display = note ? 'block' : 'none';
  $('leader').setAttribute('visibility', note ? 'visible' : 'hidden');
  $('ring').setAttribute('visibility', note ? 'visible' : 'hidden');
  if (note) {
    $('callout-sev').className = `chip ${note.severity === 'info' ? 'ok' : note.severity === 'minor' ? 'air' : 'bad'}`;
    $('callout-sev').lastElementChild.textContent = `${note.severity} · ${(note.frame / state.fps).toFixed(2)} s`;
    $('callout-title').textContent = note.text;
    $('callout-detail').textContent = note.detail;
  }
}

function positionCallout() {
  const note = state.activeNote;
  if (!note) return;
  const p = state.skaters[0].pose[note.anchor].clone().project(camera);
  const w = window.innerWidth, h = window.innerHeight;
  const ax = ((p.x + 1) / 2) * w, ay = ((1 - p.y) / 2) * h;
  if (!Number.isFinite(ax) || !Number.isFinite(ay)) return;
  const card = $('callout');
  const cw = card.offsetWidth, ch = card.offsetHeight;
  const left = (HERO && heroShift() > 0) || ax < w * 0.55 ? ax + 70 : ax - 70 - cw;
  const top = THREE.MathUtils.clamp(ay - ch - 40, 12, h - ch - 170);
  card.style.left = `${THREE.MathUtils.clamp(left, 12, w - cw - 12)}px`;
  card.style.top = `${top}px`;
  const cx = parseFloat(card.style.left) + cw / 2 > ax ? parseFloat(card.style.left) : parseFloat(card.style.left) + cw;
  const leader = $('leader');
  leader.setAttribute('x1', ax); leader.setAttribute('y1', ay);
  leader.setAttribute('x2', cx); leader.setAttribute('y2', top + ch / 2);
  const ring = $('ring');
  ring.setAttribute('cx', ax); ring.setAttribute('cy', ay);
}

function play() {
  if (state.frame >= state.nFrames - 1) setFrame(0);
  state.notes.forEach((n) => { if (n.frame > state.frame) n.shown = false; });
  state.playing = true;
  $('play').textContent = '❚❚';
  setActiveNote(null);
}

function pause() {
  state.playing = false;
  state.hold = null;
  $('hold').firstElementChild.style.width = '0';
  $('play').textContent = '▶';
  setFrame(state.frame);
}

function togglePlay() { (state.playing ? pause : play)(); }

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.style.opacity = '1';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.style.opacity = '0'; }, 600);
}

function followPoint() {
  const c = state.skaters[0]?.followAt(state.frame) || new THREE.Vector3();
  return new THREE.Vector3(c.x, 1.0, c.z);
}

// ---------- the filming camera: the 3D seen through the phone's own lens, footage behind ----------
// The footage is drawn by WebGL as the first pass of every frame (a full-screen quad sampling the clip through
// the lens window), not as a CSS-scaled <video> layer: resizing a 4000 px video layer every frame cost
// 25-30 ms frames, and a separate layer can present a different video frame than the one the 3D was drawn for.
const backdrop = $('backdrop');
const footageTex = new THREE.VideoTexture(backdrop);
footageTex.colorSpace = THREE.NoColorSpace;  // pass the video's sRGB values straight to the sRGB canvas
footageTex.generateMipmaps = false;
footageTex.minFilter = THREE.LinearFilter;
const footage = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { map: { value: footageTex }, win: { value: new THREE.Vector4(0, 0, 1, 1) }, opacity: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D map; uniform vec4 win; uniform float opacity; varying vec2 vUv;
    void main() {
      // win = (u0, v0, uw, vh) as fractions of the frame, v measured down from the top.
      vec2 t = vec2(win.x + vUv.x * win.z, 1.0 - (win.y + (1.0 - vUv.y) * win.w));
      bool inside = all(greaterThanEqual(t, vec2(0.0))) && all(lessThanEqual(t, vec2(1.0)));
      gl_FragColor = vec4(inside ? texture2D(map, t).rgb : vec3(0.0), opacity);
    }`,
  depthTest: false, depthWrite: false, transparent: true, toneMapped: false,
}));
footage.frustumCulled = false;
const footageScene = new THREE.Scene();
footageScene.add(footage);
const footageCam = new THREE.Camera();
let footageTarget = 0;  // fades to this opacity
renderer.autoClear = false;

// The clip is a k-times slow motion with interpolated in-between frames (summary.camera.video_slowmo):
// replay frame i is at clip time k * i / fps.
const slowmo = () => state.replay?.summary?.camera?.video_slowmo || 1;
let presented = null;  // media time of the clip frame on screen now
function watchFrames() {
  if (!backdrop.requestVideoFrameCallback) return;
  const cb = (now, meta) => { presented = meta.mediaTime; backdrop.requestVideoFrameCallback(cb); };
  backdrop.requestVideoFrameCallback(cb);
}
watchFrames();

function clipReady() {
  return state.cameraView && !!backdrop.dataset.blob && backdrop.readyState >= 2;
}

function filmingCamera() {
  // summary.camera: pinhole solved by the reconstruction; reconstruction-frame point X maps to camera X R + origin.
  const c = state.replay?.summary?.camera;
  if (!c || typeof c !== 'object' || !c.R) return null;
  const R = c.R, o = c.origin, [sx, sy] = c.shift_xy || [0, 0];
  const centre = [0, 1, 2].map((i) => -(o[0] * R[i][0] + o[1] * R[i][1] + o[2] * R[i][2]));
  const col = (k) => v3(R[0][k], R[1][k], R[2][k]).normalize();
  const [w, h] = c.size || [2 * c.cx, 2 * c.cy];
  let fwd = col(2), up = col(1).negate();
  if (c.motion) {
    // Handheld phone: frame t's camera axis k, in reference-camera coordinates, is row k of R_t (motion[t]).
    const axis = (m, k) => v3(...[0, 1, 2].map((i) => R[i][0] * m[3 * k] + R[i][1] * m[3 * k + 1] + R[i][2] * m[3 * k + 2]));
    const n = c.motion.length, f = THREE.MathUtils.clamp(state.frame, 0, n - 1);
    const i = Math.floor(f), j = Math.min(i + 1, n - 1), a = f - i;
    const at = (k) => axis(c.motion[i], k).lerp(axis(c.motion[j], k), a).normalize();
    fwd = at(2);
    up = at(1).negate();
  }
  return { pos: v3(centre[0] - sx, centre[1] - sy, centre[2]), fwd, up, f: c.f, w, h, video: c.video, handheld: !!c.motion };
}

function aimFilmingCamera() {
  // A handheld phone turns while it films; the 3D camera takes this frame's orientation so it stays on the footage.
  const fc = filmingCamera();
  if (!state.cameraView || !fc?.handheld) return;
  const d = Math.max(controls.target.distanceTo(camera.position), 1);
  camera.position.copy(fc.pos);
  camera.up.copy(fc.up);
  controls.target.copy(fc.pos).addScaledVector(fc.fwd, d);
  camera.lookAt(controls.target);
}

// The lens view shows a window (u0, v0, uw, vh) of the footage, in source pixels. The video element and
// the 3D camera (setViewOffset on the full lens frustum) crop the same window, so they stay registered
// while the window follows and zooms on the skater.
const lensCam = new THREE.PerspectiveCamera();
let lens = null;

function stageSize() {
  return { W: $('stage').clientWidth, H: Math.max($('stage').clientHeight, 1) };
}

// Follow framing in the filming-camera view, like a camera operator: the window is centred on the smoothed centre of
// mass at a fixed height (it does not bob with the jump) and sized by the skater's distance. Framing the pose's
// outline instead made the window breathe and drift every time the arms opened or closed.
const FRAME_M = 4.6;  // window height at the skater, metres: the skater, the jump's rise and some ice
const FRAME_CENTRE_M = 0.8;  // below the hips, so the skater sits above the controls at the bottom

function lensTarget(fc) {
  const { W, H } = stageSize();
  const a = W / H;
  const full = Math.max(fc.h, fc.w / a);  // window height that shows the whole frame ("contain")
  const s0 = state.skaters[0];
  let vh = full, cx = fc.w / 2, cy = fc.h / 2;
  if (state.follow && s0) {
    lensCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(fc.h / 2 / fc.f));
    lensCam.aspect = fc.w / fc.h;
    lensCam.updateProjectionMatrix();
    lensCam.position.copy(camera.position);
    lensCam.quaternion.copy(camera.quaternion);
    lensCam.updateMatrixWorld();
    const c = s0.followAt(state.frame);
    const aim = new THREE.Vector3(c.x, FRAME_CENTRE_M, c.z);
    const depth = aim.clone().sub(lensCam.position).dot(lensCam.getWorldDirection(new THREE.Vector3()));
    if (depth > 0.5) {
      const n = aim.project(lensCam);
      vh = THREE.MathUtils.clamp(FRAME_M * fc.f / depth, fc.h * 0.25, full);
      cx = ((n.x + 1) / 2) * fc.w;
      cy = ((1 - n.y) / 2) * fc.h;
    }
  }
  const uw = vh * a;
  const clampAxis = (c, size, total) => (size >= total ? (total - size) / 2 : THREE.MathUtils.clamp(c - size / 2, 0, total - size));
  return { u0: clampAxis(cx, uw, fc.w), v0: clampAxis(cy, vh, fc.h), uw, vh };
}

function applyLens(fc, L) {
  footage.material.uniforms.win.value.set(L.u0 / fc.w, L.v0 / fc.h, L.uw / fc.w, L.vh / fc.h);
  lensCam.fov = camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(fc.h / 2 / fc.f));
  lensCam.aspect = camera.aspect = fc.w / fc.h;
  lensCam.updateProjectionMatrix();
  camera.setViewOffset(fc.w, fc.h, L.u0, L.v0, L.uw, L.vh);
}

function updateLens(dt) {
  const fc = filmingCamera();
  if (!state.cameraView || !fc) return;
  const target = lensTarget(fc);
  if (!Object.values(target).every(Number.isFinite)) return;  // stage not laid out yet (hidden pane, zero size)
  if (!lens || !Object.values(lens).every(Number.isFinite)) lens = target;
  else {
    const k = 1 - Math.exp(-dt / 0.3);  // glide, so tracking noise and scrubbing do not shake the frame
    for (const key of Object.keys(lens)) lens[key] += (target[key] - lens[key]) * k;
  }
  applyLens(fc, lens);
}

function leaveLens() {
  // Swap the cropped lens for an ordinary camera looking through the window's centre, with the same zoom.
  const fc = filmingCamera();
  if (!lens || !fc) { camera.clearViewOffset(); return; }
  const centre = new THREE.Vector3(0, 0, 0.5).unproject(camera);
  const dir = centre.sub(camera.position).normalize();
  const d = Math.max(new THREE.Vector3().subVectors(state.skaters[0].comAt(state.frame), camera.position).dot(dir), 1);
  camera.clearViewOffset();
  const { W, H } = stageSize();
  camera.aspect = W / H;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(lens.vh / 2 / fc.f));
  camera.updateProjectionMatrix();
  controls.target.copy(camera.position).addScaledVector(dir, d);
  lens = null;
}

function setCameraLook(on) {
  if (!on && state.cameraView) leaveLens();
  state.cameraView = on;
  footageTarget = on ? 1 : 0;
  rink.visible = !on;
  shadowCatcher.visible = on;
  scene.background = on ? null : SKY;
  scene.fog = on ? null : FOG;
  for (const s of state.skaters) s.body?.setOpacity(on ? 0.6 : 1);
  $('pip').style.display = !on && state.showVideo && state.replay?.video ? 'block' : 'none';
  $('camera-view').classList.toggle('active', on);
  $('camera-hint').style.opacity = on ? '1' : '0';
  if (!on) camera.up.set(0, 1, 0);
}

function enterCameraView() {
  const fc = filmingCamera();
  if (!fc) return;
  setCameraLook(true);
  camera.up.copy(fc.up);  // keep the phone's slight roll, so the 3D lines up with the footage
  camera.position.copy(fc.pos);
  const com = state.skaters[0].comAt(state.frame);
  const d = Math.max(new THREE.Vector3().subVectors(com, fc.pos).dot(fc.fwd), 1);
  controls.target.copy(fc.pos).addScaledVector(fc.fwd, d);
  controls.update();
  lens = null;
  updateLens(0);
  lastFollow = followPoint();  // later frame jumps move the camera along with the skater
}

// Dragging away from the filming camera turns the footage off and shows the full 3D scene.
controls.addEventListener('start', () => { if (state.cameraView) setCameraLook(false); });

let lastFollow = null;
function setView(name) {
  if (name === 'camera') { enterCameraView(); return; }
  if (state.cameraView) setCameraLook(false);
  camera.fov = 40;
  camera.updateProjectionMatrix();
  const target = followPoint();
  const ev = state.skaters[0]?.track.events;
  if (!state.follow && ev?.apex !== undefined) target.copy(state.skaters[0].com[ev.apex]).setY(1.0);
  const dir = state.jumpDir.clone();
  const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
  const dist = 6.5;
  const offsets = {
    side: side.clone().multiplyScalar(dist).add(new THREE.Vector3(0, 0.6, 0)),
    front: dir.clone().multiplyScalar(dist).add(new THREE.Vector3(0, 0.6, 0)),
    back: dir.clone().multiplyScalar(-dist).add(new THREE.Vector3(0, 0.6, 0)),
    top: dir.clone().multiplyScalar(0.01).add(new THREE.Vector3(0, dist + 1.5, 0)),
  };
  controls.target.copy(target);
  camera.position.copy(target).add(offsets[name]);
  controls.update();
  lastFollow = followPoint();  // later frame jumps move the camera along with the skater
}

// Tap (short press without dragging) on the scene toggles playback; drags still orbit.
let press = null;
renderer.domElement.addEventListener('pointerdown', (e) => { press = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!press || press.id !== e.pointerId) return;
  const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  if (performance.now() - press.t < TAP_MS && moved < TAP_PX && e.button === 0) {
    togglePlay();
    toast(state.playing ? '▶  PLAY' : '❚❚  PAUSED');
  }
  press = null;
});

$('play').addEventListener('click', togglePlay);
$('scrub').addEventListener('input', (e) => { if (state.playing) pause(); setFrame(parseFloat(e.target.value)); });
$('speed').addEventListener('change', (e) => { state.speed = parseFloat(e.target.value); });
document.querySelectorAll('button.event').forEach((b) => b.addEventListener('click', () => {
  const ev = state.skaters[0]?.track.events;
  const rot = state.replay?.summary?.rotation;
  const exact = rot && { takeoff: rot.takeoff_frame, landing: rot.touchdown_frame }[b.dataset.event];
  if (ev && b.dataset.event in ev) { pause(); setFrame(exact ?? ev[b.dataset.event]); }
}));
document.querySelectorAll('button[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('follow').addEventListener('click', () => {
  state.follow = !state.follow;
  $('follow').classList.toggle('active', state.follow);
});
$('video-toggle').addEventListener('click', () => {
  state.showVideo = !state.showVideo;
  $('video-toggle').classList.toggle('active', state.showVideo);
  $('pip').style.display = state.showVideo && state.replay?.video && !state.cameraView ? 'block' : 'none';
});
$('labels-toggle').addEventListener('click', () => {
  state.showLabels = !state.showLabels;
  $('labels-toggle').classList.toggle('active', state.showLabels);
  for (const o of sceneLabels) o.visible = state.showLabels;
  updateEdgeView();
});
$('side-toggle').addEventListener('click', () => $('side').classList.toggle('open'));
const BODY_MODES = [['both', 'Mesh + keypoints'], ['skeleton', 'Keypoints'], ['mesh', 'Mesh']];
async function loadHair(s) {
  // The hairstyle fitted to the shown build's head (a short cut, or a bun for the female build).
  const h = s.track.mesh?.hair?.[s.track.mesh.variant];
  if (!h || !s.body) return;
  s.hairBuffers ||= {};
  s.hairBuffers[h.file] ||= await (await fetch(`replays/${h.file}`, FRESH)).arrayBuffer();
  s.body.setHair(h, s.hairBuffers[h.file]);
}
// Body shapes exported by scripts/body_variants.py: SAM's fitted shape, or a male / female build of it.
const BODY_LABEL = { male: 'Build: male', female: 'Build: female', fitted: 'Build: as measured', estimated: 'Build: per frame' };
const BODY_ORDER = ['male', 'female', 'fitted'];
$('body-type').addEventListener('click', async () => {
  const s0 = state.skaters[0];
  const mesh = s0?.track.mesh;
  if (!mesh?.variants || !s0.body) return;
  const names = BODY_ORDER.filter((n) => n in mesh.variants);
  const next = names[(names.indexOf(mesh.variant) + 1) % names.length];
  s0.variantBuffers ||= { [mesh.variant]: s0.meshBuffer };
  s0.variantBuffers[next] ||= await (await fetch(`replays/${mesh.variants[next]}`, FRESH)).arrayBuffer();
  mesh.variant = next;
  s0.meshBuffer = s0.variantBuffers[next];
  s0.body.setBuffer(s0.meshBuffer);
  await loadHair(s0);
  $('body-type').textContent = BODY_LABEL[next];
  toast(BODY_LABEL[next].toUpperCase());
});
$('body-mode').addEventListener('click', () => {
  const i = (BODY_MODES.findIndex(([m]) => m === state.bodyMode) + 1) % BODY_MODES.length;
  state.bodyMode = BODY_MODES[i][0];
  $('body-mode').textContent = BODY_MODES[i][1];
  for (const s of state.skaters) if (s.body) s.setBodyMode(state.bodyMode);
});
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight') { pause(); setFrame(Math.floor(state.frame) + 1); }
  if (e.code === 'ArrowLeft') { pause(); setFrame(Math.ceil(state.frame) - 1); }
});

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = $('stage');
  if (!w || !h) return;  // hidden or collapsed: keep the last size (a zero aspect turns every projection into NaN)
  renderer.setSize(w, h, false);
  if (state.cameraView) { updateLens(1); return; }
  camera.aspect = w / Math.max(h, 1);
  if (HERO) applyHeroShift();
  camera.updateProjectionMatrix();
}).observe($('stage'));

function syncVideo() {
  syncClip($('pip-video'), state.replay?.video && state.showVideo && !state.cameraView, 1, false);
  syncClip(backdrop, state.cameraView && backdrop.dataset.blob, slowmo(), true);
}

function syncClip(video, enabled, k, master) {
  // `master`: the 3D follows this clip's presented frame, so it is never re-seeked while it plays.
  if (!enabled || video.readyState < 1) { if (!video.paused) video.pause(); return; }
  const target = (state.frame * k) / state.fps;
  const running = state.playing && !state.hold;
  if (running) {
    const rate = HERO ? Math.max(0.0625, Math.round(heroSpeed() * k * 20) / 20) : state.speed * k;
    if (video.playbackRate !== rate) video.playbackRate = rate;
    if (video.paused) {
      video.currentTime = target;
      if (master) presented = null;  // frames presented before this seek are not the clock any more
      video.play().catch(() => {});
    }
    else if (!master && Math.abs(video.currentTime - target) > 2.5 / state.fps) video.currentTime = target;
  } else {
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - target) > (0.5 * k) / state.fps && !video.seeking) {
      video.currentTime = target;
      if (master) presented = null;
    }
  }
}

// A shadow camera that slides with the skater makes shadow edges shimmer; move it in whole shadow-map texels.
const SUN_OFFSET = new THREE.Vector3(4, 10, 3);
function placeSun(target) {
  const cam = sun.shadow.camera;
  const texel = (cam.right - cam.left) / sun.shadow.mapSize.x;
  const fwd = SUN_OFFSET.clone().negate().normalize();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const snap = (v) => Math.round(v / texel) * texel;
  const t = new THREE.Vector3().addScaledVector(right, snap(target.dot(right))).addScaledVector(up, snap(target.dot(up)))
    .addScaledVector(fwd, target.dot(fwd));
  sun.target.position.copy(t);
  sun.position.copy(t).add(SUN_OFFSET);
}


// ---------- website hero: autoplay loop, slow motion around the jump, a camera that keeps circling ----------
const HERO = true;
const hero = {
  endAt: 0, user: false, resumeAt: 0, t: 0, visible: true,
  reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
};

function heroEvents() {
  const r = state.replay?.summary?.rotation;
  const ev = state.skaters[0]?.track.events || {};
  return { takeoff: r?.takeoff_frame ?? ev.takeoff, landing: r?.touchdown_frame ?? ev.landing, apex: ev.apex };
}

function heroSpeed() {
  const { takeoff, landing } = heroEvents();
  if (takeoff === undefined) return 0.4;
  const a = takeoff - state.fps * 0.3, b = landing + state.fps * 0.35, ramp = state.fps * 0.3;
  const d = state.frame < a ? a - state.frame : state.frame > b ? state.frame - b : 0;
  const k = Math.min(1, Math.max(0, d) / ramp);
  return 0.17 + (0.55 - 0.17) * k * k * (3 - 2 * k);
}

function heroStartFrame() {
  const { takeoff } = heroEvents();
  return takeoff === undefined ? 0 : Math.max(0, takeoff - state.fps * 1.2);
}

function heroStart() {
  for (const o of sceneLabels) o.visible = true;
  setFrame(heroStartFrame());
  setView('side');
  play();
  document.body.classList.add('ready');
}

function heroEnd(now) {
  if (!hero.endAt) { hero.endAt = now + 1400; return; }
}

function heroShift() {
  return 0;  // the skater stays centred; the page puts its headline in the empty sky at the top left
}

function applyHeroShift() {
  // Move the skater right of centre on wide screens: filmOffset shifts the frustum sideways (three.js film units).
  const s = heroShift();
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.filmOffset = -s * 2 * tanHalf * camera.aspect * camera.getFilmWidth();
}

// Drag (mouse) or swipe (finger) to turn the view like in the full viewer; the directed camera takes over again a
// few seconds after the last touch, gliding from wherever the visitor left it. No zoom or pan: the page must keep
// scrolling with the wheel, and a vertical swipe on a phone scrolls the page.
controls.enableZoom = false;
controls.enablePan = false;
controls.addEventListener('start', () => { hero.user = true; hero.resumeAt = 0; });
controls.addEventListener('end', () => { hero.resumeAt = performance.now() + 3000; });
if (window.matchMedia('(pointer: coarse)').matches) {
  renderer.domElement.style.touchAction = 'pan-y';
  document.body.classList.add('touch');
}

// Directed camera: one shot per phase of the jump, blended smoothly, always following the skater.
// azimuth: 0 = square to the line of travel on the filming camera's side, + = toward the front; elevation above the ice.
function heroShots() {
  const { takeoff, landing } = heroEvents();
  const f = state.fps;
  const mid = (takeoff + landing) / 2;
  return [
    // [frame, azimuth deg, elevation deg, distance m, look-at height m]
    [takeoff - f * 1.3, 28, 9, 6.4, 0.95],     // run-up: three-quarter front, low
    [takeoff - f * 0.4, 8, 13, 5.6, 0.85],     // into the take-off: side on
    [takeoff + f * 0.02, -12, 33, 5.0, 0.55],  // take-off: raised, the pre-rotation angle on the ice is in view
    [mid, -42, 11, 5.3, 1.05],                 // in the air: swing round low, the rotation reads against the sky
    [landing - f * 0.03, -72, 18, 5.2, 0.8],
    [landing + f * 0.3, -100, 38, 5.2, 0.4],   // landing: raised over the under-rotation angle on the ice
    [landing + f * 1.4, -140, 15, 6.4, 0.8],   // glide-out
  ];
}

// The user found the changing angles dizzying (2026-11-08): one steady side view, slightly raised so the angles on
// the ice stay readable, following the skater. heroShots() is kept for reference.
const HERO_SIDE_SHOT = [0, 14, 5.8, 0.85];  // azimuth deg, elevation deg, distance m, look-at height m

function heroShotAt(frame) {
  if (HERO_SIDE_SHOT) return HERO_SIDE_SHOT;
  const keys = heroShots();
  if (frame <= keys[0][0]) return keys[0].slice(1);
  for (let i = 1; i < keys.length; i++) {
    if (frame <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      let k = (frame - a[0]) / Math.max(b[0] - a[0], 1e-6);
      k = k * k * (3 - 2 * k);
      return [1, 2, 3, 4].map((j) => a[j] + (b[j] - a[j]) * k);
    }
  }
  return keys[keys.length - 1].slice(1);
}

function heroSide() {
  const dir = state.jumpDir.clone();
  const side = new THREE.Vector3().crossVectors(UP, dir).normalize();
  const fc = filmingCamera();
  if (fc && side.dot(new THREE.Vector3().subVectors(fc.pos, controls.target)) < 0) side.negate();
  return { dir, side };
}

function heroTick(dt, now) {
  if (hero.endAt && now >= hero.endAt) {
    hero.endAt = 0;
    for (const n of state.notes) n.shown = false;
    setFrame(heroStartFrame());
    hero.blend = 0;
    if (!state.playing) play();
  }
  if (hero.user && hero.resumeAt && now >= hero.resumeAt) { hero.user = false; hero.resumeAt = 0; hero.blend = 0; }
  if (hero.user || hero.reduced || !state.skaters[0]) return;
  if (!hero.basis) hero.basis = heroSide();
  const { dir, side } = hero.basis;
  const [az, el, dist, look] = heroShotAt(state.frame);
  // Look-at height on top of the follow point (fixed at 1 m): lower for the shots that show angles on the ice.
  hero.lift ??= 0;
  const lift = hero.lift + (look - 1.0 - hero.lift) * (1 - Math.exp(-dt / 0.35));
  controls.target.y += lift - hero.lift;
  camera.position.y += lift - hero.lift;
  hero.lift = lift;
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  const flat = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(dir, Math.sin(a));
  const radius = dist * (camera.aspect < 0.9 ? 1.25 : 1);
  const want = flat.multiplyScalar(Math.cos(e)).addScaledVector(UP, Math.sin(e)).multiplyScalar(radius);
  // Glide toward the shot: quick enough to keep up with the jump, slow after a hand-over or a loop restart.
  hero.blend = Math.min(1, (hero.blend ?? 1) + dt / 1.5);
  const tau = 0.18 + 0.9 * (1 - hero.blend);
  const off = new THREE.Vector3().subVectors(camera.position, controls.target);
  const r = off.length() + (radius - off.length()) * (1 - Math.exp(-dt / tau));
  off.normalize().lerp(want.clone().normalize(), 1 - Math.exp(-dt / tau)).normalize().multiplyScalar(r);
  camera.position.copy(controls.target).add(off);
}

const HUD_METRICS = [
  ['pre', 'Pre-rotation', (m, r) => `${Math.round(r.pre_rotation_deg)}°`, (r) => r.pre_rotation_reference && `typical ${Math.round(r.pre_rotation_reference.median)}°`],
  ['air', 'Air time', (m) => `${m.air_time_s.toFixed(2)} s`, () => ''],
  ['height', 'Height', (m) => `${Math.round(m.height_from_air_time_m * 100)} cm`, () => 'from air time'],
  ['turn', 'Rotation in the air', (m, r) => `${Math.round(r.rotation_deg)}°`, (r) => `reference ${Math.round(r.reference_deg)}°`],
  ['under', 'Under-rotation', (m, r) => `${Math.round(r.under_rotation_deg)}°`, (r) => r.under_rotation_reference && `typical ${Math.round(r.under_rotation_reference.median)}°`],
];

function heroHudBuild() {
  const box = $('hero-hud');
  const m = state.skaters[0]?.track.metrics;
  const r = state.replay?.summary?.rotation;
  if (!box || !m || !r) return;
  const s = state.replay.summary;
  $('hero-jump').textContent = `${s.level ? s.level[0].toUpperCase() + s.level.slice(1) + ' ' : ''}${s.jump}`;
  box.innerHTML = HUD_METRICS.map(([k, label, val, sub]) => `<div class="hm" data-k="${k}"><span class="hl">${label}</span>`
    + `<b>${val(m, r)}</b><small>${sub(r) || ''}</small></div>`).join('');
}

function heroHud() {
  const { takeoff, landing, apex } = heroEvents();
  if (takeoff === undefined) return;
  if (!$('hero-hud').firstElementChild) heroHudBuild();
  const f = state.frame;
  const lit = { pre: f >= takeoff, air: f >= landing, height: f >= (apex ?? takeoff), turn: f >= landing, under: f >= landing };
  for (const el of $('hero-hud').children) el.classList.toggle('lit', !!lit[el.dataset.k]);
  const phase = f < takeoff - state.fps * 0.25 ? 'Run-up' : f < takeoff ? 'Take-off' : f < landing ? 'In the air'
    : f < landing + state.fps * 0.3 ? 'Landing' : 'Glide-out';
  const ph = $('hero-phase');
  if (ph.textContent !== phase) { ph.textContent = phase; ph.className = `chip ${phase === 'In the air' ? 'air' : 'accent'}`; }
  $('hero-time').textContent = `t ${(f / state.fps).toFixed(2)} s · ${heroSpeed() < 0.3 ? 'slow motion' : 'replay'}`;
}

// The page that embeds this replay tells it when it scrolls out of view, so it stops drawing.
window.addEventListener('message', (e) => {
  if (e.data && e.data.arckinex === 'visible') {
    hero.visible = !!e.data.value;
    renderer.setAnimationLoop(hero.visible ? loop : null);
    clock.getDelta();
  }
});

const clock = new THREE.Clock();
const loop = () => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  if (state.playing && state.replay) {
    if (state.hold) {
      const k = (now - state.hold.start) / HOLD_MS;
      $('hold').firstElementChild.style.width = `${Math.min(100, k * 100)}%`;
      if (k >= 1) {
        state.hold = null;
        $('hold').firstElementChild.style.width = '0';
        setActiveNote(null);
      }
    } else {
      let f = state.frame + dt * state.fps * (HERO ? heroSpeed() : state.speed);
      if (clipReady() && !backdrop.paused && presented !== null) {
        // Show exactly the frame the footage shows (it has 4x interpolated frames, so this is smooth).
        const fv = (presented * state.fps) / slowmo();
        f = Math.max(state.frame, Math.min(fv, state.nFrames - 1));
      }
      const due = state.notes.find((n) => !n.shown && n.frame > state.frame - 0.01 && n.frame <= f);
      if (due) {
        due.shown = true;
        f = due.frame;
        state.hold = { start: now };
        setFrame(f);
        setActiveNote(due);
      } else if (f >= state.nFrames - 1) {
        setFrame(state.nFrames - 1);
        if (HERO) heroEnd(now); else pause();
      } else setFrame(f);
    }
  }
  if (state.replay) {
    const target = followPoint();
    if (state.follow && lastFollow && !state.cameraView) {
      const delta = new THREE.Vector3().subVectors(target, lastFollow);
      camera.position.add(delta);
      controls.target.add(delta);
    }
    lastFollow = target;
    placeSun(target);
    rim.position.copy(target).add(new THREE.Vector3(-5, 4, -6));
    const pulse = 0.5 + 0.5 * Math.sin(now / 160);
    hotMat.emissiveIntensity = 0.5 + 0.7 * pulse;
    bodyUniforms.uPulse.value = pulse;
    haloMat.opacity = 0.12 + 0.22 * pulse;
    $('ring').setAttribute('r', String(12 + 6 * pulse));
    syncVideo();
  }
  if (HERO && state.replay) heroTick(dt, now);
  controls.update();
  aimFilmingCamera();
  updateLens(dt);
  const fo = footage.material.uniforms.opacity;
  fo.value += (footageTarget - fo.value) * (1 - Math.exp(-dt / 0.12));
  if (Math.abs(fo.value - footageTarget) < 0.01) fo.value = footageTarget;
  renderer.clear();
  if (fo.value > 0) renderer.render(footageScene, footageCam);
  renderer.render(scene, camera);
  positionCallout();
  updateEdgeView();
};
renderer.setAnimationLoop(loop);

// Console access for debugging (e.g. __skatesense.state.frame).
window.__skatesense = { state, camera, controls, filmingCamera, lensTarget, THREE, renderer, footage, footageScene, footageCam };

init();
