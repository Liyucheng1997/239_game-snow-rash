import * as THREE from 'three';

// ============================================================
//  滑雪者：分段关节 + 两骨腿部 IK + 姿态状态机
//  层级：
//  root(位置/航向) → tilt(贴合坡面) → pivot(雪板/身体整体偏转，滑动转向)
//     ├ stance(雪板 + 雪靴；空中可整体抬起)
//     └ lean(全身内倾，支点在雪面) → body(站姿朝向) → pelvis
//           ├ thighL/R → shinL/R   (IK 解算，脚踝钉在雪靴上)
//           └ spine → chest → head / shoulderL/R → upperArm → forearm → hand(+雪杖)
// ============================================================

const L1 = 0.40;            // 大腿
const L2 = 0.38;            // 小腿（膝盖到靴口）
const HIP_STAND = 0.93;     // 放松站立髋高

const SCHEMES = {
  ski: {
    jacket: 0xd7382b, panel: 0x1d2432, pants: 0x1b2130, helmet: 0xf3f5f8,
    lens: 0x2f8bf5, gloves: 0x1a1d24, boots: 0x161a21, accent: 0xff7d1f,
    top: 0xffc632, topStripe: 0xffffff, base: 0x101216, pole: 0xc2cad6, bib: 7,
  },
  board: {
    jacket: 0x1fa3b1, panel: 0xf4a62a, pants: 0x3a3f4b, helmet: 0x1a1d24,
    lens: 0xff8a2a, gloves: 0x2a2e3a, boots: 0x262a33, accent: 0xf4a62a,
    top: 0x6a3fd0, topStripe: 0xf2f2f2, base: 0x101216, pole: 0xc2cad6, bib: 0,
  },
};

function std(color, roughness = 0.8, metalness = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}
function mesh(geo, material) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  return m;
}
function capsule(r, len, material, seg = 10) {
  return mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len), 4, seg), material);
}
// 从关节向下（-Y）伸出的肢体
function limb(r, L, material) {
  const m = capsule(r, L - 2 * r, material);
  m.position.y = -L / 2;
  return m;
}

// ---------- 雪板扫掠几何（带侧切、翘头、拱形） ----------
function sweep(samples, thick, mats) {
  const n = samples.length;
  const pos = [];
  const idx = [];
  const strips = [
    (s) => [[-s.hw, s.y + thick, s.z], [s.hw, s.y + thick, s.z]],
    (s) => [[s.hw, s.y, s.z], [-s.hw, s.y, s.z]],
    (s) => [[-s.hw, s.y, s.z], [-s.hw, s.y + thick, s.z]],
    (s) => [[s.hw, s.y + thick, s.z], [s.hw, s.y, s.z]],
  ];
  let base = 0;
  const starts = [];
  for (let st = 0; st < 4; st++) {
    starts.push(idx.length);
    for (let i = 0; i < n; i++) {
      const [a, b] = strips[st](samples[i]);
      pos.push(...a, ...b);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    base += n * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.addGroup(0, starts[1], 0);
  geo.addGroup(starts[1], idx.length - starts[1], 1);
  geo.computeVertexNormals();
  return mesh(geo, mats);
}

function roundEnd(hw, d, r) {
  if (d >= r) return hw;
  const k = 1 - d / r;
  return hw * Math.sqrt(Math.max(0, 1 - k * k));
}

function skiSamples(L = 1.72) {
  const out = [];
  const N = 48;
  for (let i = 0; i < N; i++) {
    const z = -L / 2 + (i / (N - 1)) * L;
    const u = z / (L / 2);
    let hw = 0.05 + (u < 0 ? 0.018 : 0.011) * u * u;
    const dTip = z + L / 2, dTail = L / 2 - z;
    hw = roundEnd(hw, dTip, 0.17);
    hw = roundEnd(hw, dTail, 0.05);
    let y = (1 - u * u) * 0.006;
    if (dTip < 0.34) { const k = 1 - dTip / 0.34; y += k * k * 0.085; }
    if (dTail < 0.12) { const k = 1 - dTail / 0.12; y += k * k * 0.02; }
    out.push({ z, y, hw: Math.max(hw, 0.003) });
  }
  return out;
}

function boardSamples(L = 1.54) {
  const out = [];
  const N = 56;
  for (let i = 0; i < N; i++) {
    const z = -L / 2 + (i / (N - 1)) * L;
    const u = z / (L / 2);
    let hw = 0.123 + 0.024 * u * u;
    const dTip = z + L / 2, dTail = L / 2 - z;
    hw = roundEnd(hw, dTip, 0.24);
    hw = roundEnd(hw, dTail, 0.22);
    let y = (1 - u * u) * 0.005;
    if (dTip < 0.34) { const k = 1 - dTip / 0.34; y += k * k * 0.06; }
    if (dTail < 0.3) { const k = 1 - dTail / 0.3; y += k * k * 0.05; }
    out.push({ z, y, hw: Math.max(hw, 0.003) });
  }
  return out;
}

// ---------- 雪靴 ----------
function makeBoot(C, soft) {
  const g = new THREE.Group();
  const shell = std(C.boots, soft ? 0.85 : 0.45);
  // 鞋壳：横躺的胶囊，前脚掌略高
  const body = capsule(0.052, 0.19, shell, 12);
  body.rotation.x = Math.PI / 2;
  body.scale.set(1, 1.15, 1);
  body.position.set(0, 0.062, -0.01);
  g.add(body);
  // 靴筒（前倾）
  const cuff = mesh(new THREE.CylinderGeometry(0.058, 0.062, 0.17, 12), shell);
  cuff.position.set(0, 0.17, 0.02);
  cuff.rotation.x = -0.22;
  g.add(cuff);
  // 靴扣 / 鞋带
  const acc = std(C.accent, 0.4, 0.3);
  for (let i = 0; i < (soft ? 2 : 3); i++) {
    const b = mesh(new THREE.BoxGeometry(0.075, 0.018, 0.02), acc);
    b.position.set(0, 0.11 + i * 0.05, -0.052 + i * 0.012);
    b.rotation.x = -0.22;
    g.add(b);
  }
  // 脚踝锚点（IK 目标 = 靴口）
  const anchor = new THREE.Object3D();
  anchor.position.set(0, 0.09, 0);
  cuff.add(anchor);
  g.userData.anchor = anchor;
  return g;
}

// ---------- 单支双板（含固定器、雪靴） ----------
function makeSki(C) {
  const g = new THREE.Group();
  const th = 0.014;
  const s = skiSamples();
  const topMat = std(C.top, 0.35, 0.05);
  const baseMat = std(C.base, 0.5, 0.2);
  const ski = sweep(s, th, [topMat, baseMat]);
  g.add(ski);
  // 板面装饰条
  const stripe = sweep(s.map((p) => ({ z: p.z, y: p.y + th + 0.0015, hw: p.hw * 0.28 })), 0.001,
    [std(C.topStripe, 0.35), std(C.topStripe, 0.35)]);
  g.add(stripe);
  // 固定器
  const dark = std(0x1c1f26, 0.5, 0.2);
  const plate = mesh(new THREE.BoxGeometry(0.07, 0.012, 0.36), dark);
  plate.position.set(0, th + 0.006, 0.02);
  const toe = mesh(new THREE.BoxGeometry(0.085, 0.045, 0.07), dark);
  toe.position.set(0, th + 0.03, -0.14);
  const heel = mesh(new THREE.BoxGeometry(0.085, 0.07, 0.075), std(C.accent, 0.45, 0.2));
  heel.position.set(0, th + 0.045, 0.165);
  g.add(plate, toe, heel);
  const boot = makeBoot(C, false);
  boot.position.set(0, th + 0.012, 0);
  g.add(boot);
  g.userData.anchor = boot.userData.anchor;
  return g;
}

// ---------- 单板（含两个固定器、雪靴） ----------
function makeSnowboard(C) {
  const g = new THREE.Group();
  const th = 0.014;
  const s = boardSamples();
  const board = sweep(s, th, [std(C.top, 0.3, 0.05), std(C.base, 0.5, 0.2)]);
  g.add(board);
  const stripe = sweep(s.map((p) => ({ z: p.z * 0.92, y: p.y + th + 0.0015, hw: p.hw * 0.3 })), 0.001,
    [std(C.topStripe, 0.35), std(C.topStripe, 0.35)]);
  g.add(stripe);
  const anchors = [];
  const dark = std(0x1c1f26, 0.55, 0.15);
  const acc = std(C.accent, 0.5, 0.1);
  // 前脚 +18°（朝板头），后脚 -6°
  for (const [z, ang] of [[-0.29, 0.31], [0.29, -0.1]]) {
    const b = new THREE.Group();
    b.position.set(0, th, z);
    b.rotation.y = -Math.PI / 2 + ang;
    const plate = mesh(new THREE.BoxGeometry(0.17, 0.014, 0.27), dark);
    plate.position.y = 0.007;
    const high = mesh(new THREE.BoxGeometry(0.14, 0.2, 0.018), dark);
    high.position.set(0, 0.13, 0.13);
    high.rotation.x = -0.28;
    const strapA = mesh(new THREE.TorusGeometry(0.07, 0.013, 6, 14, Math.PI), acc);
    strapA.position.set(0, 0.085, 0.03);
    const strapT = mesh(new THREE.TorusGeometry(0.058, 0.011, 6, 14, Math.PI), acc);
    strapT.position.set(0, 0.06, -0.075);
    strapT.rotation.x = 0.5;
    const boot = makeBoot(C, true);
    boot.position.y = 0.014;
    b.add(plate, high, strapA, strapT, boot);
    g.add(b);
    anchors.push(boot.userData.anchor);
  }
  g.userData.anchors = anchors;
  return g;
}

// ---------- 雪杖 ----------
function makePole(C) {
  const g = new THREE.Group();
  const L = 1.15;
  const shaft = mesh(new THREE.CylinderGeometry(0.009, 0.007, L, 8), std(C.pole, 0.35, 0.7));
  shaft.position.y = -L / 2 + 0.06;
  const grip = mesh(new THREE.CylinderGeometry(0.02, 0.017, 0.13, 8), std(0x1c1f26, 0.7));
  grip.position.y = 0.0;
  const basket = mesh(new THREE.TorusGeometry(0.04, 0.008, 6, 12), std(0x1c1f26, 0.7));
  basket.rotation.x = Math.PI / 2;
  basket.position.y = -L + 0.13;
  const tip = mesh(new THREE.ConeGeometry(0.008, 0.06, 6), std(0x777d88, 0.4, 0.8));
  tip.position.y = -L + 0.04;
  tip.rotation.x = Math.PI;
  g.add(shaft, grip, basket, tip);
  return g;
}

function makeBibTexture(num) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 96;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(0, 0, 128, 96);
  ctx.fillStyle = '#d7382b';
  ctx.fillRect(0, 0, 128, 18);
  ctx.strokeStyle = '#1d2432';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 122, 90);
  ctx.fillStyle = '#1d2432';
  ctx.font = 'bold 74px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), 64, 56);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 两骨 IK：thigh 的父坐标系中，把小腿末端放到 target，膝盖朝 hint 方向弯
const _d = new THREE.Vector3(), _axis = new THREE.Vector3(), _td = new THREE.Vector3();
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
const _m = new THREE.Matrix4();
function solveLeg(thigh, shin, target, hint) {
  _d.copy(target).sub(thigh.position);
  let dist = _d.length();
  const maxD = (L1 + L2) * 0.995, minD = Math.abs(L1 - L2) + 0.02;
  dist = THREE.MathUtils.clamp(dist, minD, maxD);
  _d.normalize();
  const cosA = THREE.MathUtils.clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
  const cosB = THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1);
  const A = Math.acos(cosA), B = Math.acos(cosB);
  _axis.crossVectors(_d, hint);
  if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0); else _axis.normalize();
  _td.copy(_d).applyAxisAngle(_axis, A);
  _by.copy(_td).negate();
  _bx.copy(_axis);
  _bz.crossVectors(_bx, _by).normalize();
  _m.makeBasis(_bx, _by, _bz);
  thigh.quaternion.setFromRotationMatrix(_m);
  shin.rotation.set(-(Math.PI - B), 0, 0);
}

const _up = new THREE.Vector3(0, 1, 0);
const _nLocal = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hint = new THREE.Vector3();
const _t = new THREE.Vector3();

export class Player {
  constructor(scene, mode) {
    this.mode = mode;
    this.isSki = mode === 'ski';
    const C = (this.C = SCHEMES[mode]);

    this.root = new THREE.Group();
    this.tilt = new THREE.Group();
    this.pivot = new THREE.Group();
    this.stance = new THREE.Group();
    this.lean = new THREE.Group();
    this.body = new THREE.Group();
    this.pelvis = new THREE.Group();
    this.root.add(this.tilt);
    this.tilt.add(this.pivot);
    this.pivot.add(this.stance, this.lean);
    this.lean.add(this.body);
    this.body.add(this.pelvis);
    scene.add(this.root);

    if (!this.isSki) this.body.rotation.y = -(Math.PI / 2 - 0.35);

    this._buildGear(C);
    this._buildBody(C);

    // 姿态当前值（全部数值化便于插值）
    this.cur = this._pose('idle');
    this.plantL = 0; this.plantR = 0;
    this.plantTimerL = 0; this.plantTimerR = 0;
    this.prevSteer = 0;
    this.absorb = 0; this.absorbV = 0;
    this.time = 0;
    this.airT = 0;
    this._applyPose(this.cur);
  }

  // ---------------- 装备 ----------------
  _buildGear(C) {
    if (this.isSki) {
      this.skiL = makeSki(C); this.skiR = makeSki(C);
      this.skiL.position.x = -0.17; this.skiR.position.x = 0.17;
      this.stance.add(this.skiL, this.skiR);
      this.anchors = [this.skiL.userData.anchor, this.skiR.userData.anchor];
    } else {
      this.board = makeSnowboard(C);
      this.stance.add(this.board);
      this.anchors = this.board.userData.anchors;
    }
  }

  // ---------------- 身体 ----------------
  _buildBody(C) {
    const jacket = std(C.jacket, 0.82);
    const panel = std(C.panel, 0.82);
    const pants = std(C.pants, 0.85);
    const skin = std(0xf0c39c, 0.7);
    const glove = std(C.gloves, 0.75);

    // 骨盆
    const pelvisGeo = new THREE.LatheGeometry(
      [new THREE.Vector2(0.11, -0.14), new THREE.Vector2(0.165, -0.07), new THREE.Vector2(0.17, 0.0),
       new THREE.Vector2(0.15, 0.04), new THREE.Vector2(0.0, 0.05)], 18);
    pelvisGeo.scale(1, 1, 0.72);
    this.pelvis.add(mesh(pelvisGeo, pants));

    // 腿
    const hipW = 0.105;
    this.thighL = new THREE.Group(); this.thighR = new THREE.Group();
    this.shinL = new THREE.Group(); this.shinR = new THREE.Group();
    for (const [thigh, shin, sx] of [[this.thighL, this.shinL, -1], [this.thighR, this.shinR, 1]]) {
      thigh.position.set(sx * hipW, -0.06, 0);
      thigh.add(limb(0.085, L1, pants));
      const knee = mesh(new THREE.SphereGeometry(0.075, 12, 10), pants);
      knee.position.y = -L1;
      thigh.add(knee);
      shin.position.y = -L1;
      shin.add(limb(0.068, L2, pants));
      thigh.add(shin);
      this.pelvis.add(thigh);
    }

    // 脊柱 → 胸
    this.spine = new THREE.Group();
    this.spine.position.y = 0.02;
    this.pelvis.add(this.spine);
    this.chest = new THREE.Group();
    this.spine.add(this.chest);
    const chestGeo = new THREE.LatheGeometry(
      [new THREE.Vector2(0.15, 0.0), new THREE.Vector2(0.185, 0.08), new THREE.Vector2(0.19, 0.2),
       new THREE.Vector2(0.2, 0.34), new THREE.Vector2(0.205, 0.43), new THREE.Vector2(0.18, 0.5),
       new THREE.Vector2(0.09, 0.545), new THREE.Vector2(0.0, 0.55)], 22);
    chestGeo.scale(1, 1, 0.7);
    this.chest.add(mesh(chestGeo, jacket));
    // 拉链 / 前襟 / 口袋 / 肩部拼色
    const zip = mesh(new THREE.BoxGeometry(0.022, 0.4, 0.01), std(0xe9edf2, 0.5, 0.3));
    zip.position.set(0, 0.24, -0.142);
    this.chest.add(zip);
    for (const sx of [-1, 1]) {
      const pocket = mesh(new THREE.BoxGeometry(0.09, 0.07, 0.012), panel);
      pocket.position.set(sx * 0.085, 0.1, -0.135);
      this.chest.add(pocket);
      const yoke = mesh(new THREE.BoxGeometry(0.1, 0.05, 0.16), panel);
      yoke.position.set(sx * 0.155, 0.47, 0);
      yoke.rotation.z = sx * 0.35;
      this.chest.add(yoke);
    }
    const collar = mesh(new THREE.TorusGeometry(0.085, 0.03, 8, 16), jacket);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.55;
    this.chest.add(collar);
    if (C.bib) {
      const bib = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.15),
        new THREE.MeshStandardMaterial({ map: makeBibTexture(C.bib), roughness: 0.9 }));
      bib.position.set(0, 0.3, -0.154);
      bib.rotation.y = Math.PI;
      this.chest.add(bib);
    }

    // 头
    this.head = new THREE.Group();
    this.head.position.y = 0.6;
    this.chest.add(this.head);
    const neck = mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 10), skin);
    neck.position.y = -0.05;
    const face = mesh(new THREE.SphereGeometry(0.115, 18, 14), skin);
    face.position.y = 0.05;
    const gaiter = mesh(new THREE.CylinderGeometry(0.1, 0.085, 0.1, 12), panel);
    gaiter.position.y = -0.01;
    const helmet = mesh(new THREE.SphereGeometry(0.14, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), std(C.helmet, 0.3, 0.1));
    helmet.position.y = 0.05;
    helmet.scale.set(1, 1, 1.08);
    const strap = mesh(new THREE.TorusGeometry(0.143, 0.011, 6, 20), std(0x1c1f26, 0.7));
    strap.rotation.x = Math.PI / 2;
    strap.position.y = 0.08;
    const goggle = capsule(0.045, 0.14, std(C.lens, 0.12, 0.9), 12);
    goggle.rotation.z = Math.PI / 2;
    goggle.position.set(0, 0.075, -0.105);
    const frame = capsule(0.05, 0.145, std(0x1c1f26, 0.6), 10);
    frame.rotation.z = Math.PI / 2;
    frame.position.set(0, 0.075, -0.09);
    const visor = mesh(new THREE.BoxGeometry(0.2, 0.012, 0.08), std(C.helmet, 0.3, 0.1));
    visor.position.set(0, 0.13, -0.12);
    visor.rotation.x = 0.2;
    this.head.add(neck, face, gaiter, helmet, strap, frame, goggle, visor);

    // 手臂
    this.upperL = new THREE.Group(); this.upperR = new THREE.Group();
    this.foreL = new THREE.Group(); this.foreR = new THREE.Group();
    this.handL = new THREE.Group(); this.handR = new THREE.Group();
    const UA = 0.28, FA = 0.26;
    for (const [upper, fore, hand, sx] of [[this.upperL, this.foreL, this.handL, -1], [this.upperR, this.foreR, this.handR, 1]]) {
      upper.position.set(sx * 0.215, 0.46, 0);
      const shoulder = mesh(new THREE.SphereGeometry(0.075, 12, 10), sx < 0 ? panel : jacket);
      upper.add(shoulder, limb(0.062, UA, jacket));
      fore.position.y = -UA;
      const elbow = mesh(new THREE.SphereGeometry(0.058, 10, 8), jacket);
      fore.add(elbow, limb(0.052, FA, jacket));
      const cuff = mesh(new THREE.CylinderGeometry(0.058, 0.05, 0.06, 10), panel);
      cuff.position.y = -FA + 0.02;
      fore.add(cuff);
      hand.position.y = -FA;
      const mitt = mesh(new THREE.SphereGeometry(0.05, 10, 8), glove);
      mitt.scale.set(1, 0.85, 1.35);
      mitt.position.y = -0.03;
      hand.add(mitt);
      upper.add(fore);
      fore.add(hand);
      this.chest.add(upper);
    }
    if (this.isSki) {
      this.poleL = makePole(C); this.poleR = makePole(C);
      this.poleL.position.y = -0.02; this.poleR.position.y = -0.02;
      this.handL.add(this.poleL); this.handR.add(this.poleR);
    }
  }

  // ---------------- 姿态目标 ----------------
  _pose(kind, s = 0, speed01 = 0) {
    // 默认：放松滑行
    const p = {
      hipY: HIP_STAND, hipX: 0, hipZ: 0,
      lean: 0, pivotYaw: 0, stanceY: 0,
      spineX: 0.25, spineY: 0, spineZ: 0, headX: -0.15, headY: 0,
      uLx: 0.55, uLz: -0.3, uLy: 0, fLx: 0.55,
      uRx: 0.55, uRz: 0.3, uRy: 0, fRx: 0.55,
      poleX: -0.45,
      skiLz: 0, skiRz: 0, skiLyaw: 0, skiRyaw: 0, skiLroll: 0, skiRroll: 0, skiLx: -0.17, skiRx: 0.17, skiPitch: 0,
      boardRoll: 0, boardPitch: 0,
      kneeX: 0, kneeIn: 0,
    };
    if (!this.isSki) {
      // 单板基础站姿：前手指向板头，后手放松，头看向前进方向
      Object.assign(p, {
        hipY: HIP_STAND - 0.15, spineX: 0.2, spineY: 0.35, headY: 0.7, headX: -0.1,
        uLx: 0.15, uLz: -0.95, uLy: 0.2, fLx: 0.35,
        uRx: 0.2, uRz: 0.55, uRy: 0, fRx: 0.45,
      });
    }
    return p;
  }

  // steer -1..1；brake 0/1；tuck 0/1；air bool；speed01 0..1
  _target(steer, brake, tuck, air, speed01) {
    const p = this._pose();
    const isSki = this.isSki;
    const a = Math.abs(steer);
    const sgn = Math.sign(steer);
    // 内倾角：速度越快倾角越大
    const incl = steer * (0.22 + 0.45 * speed01);
    const carve = 0.35 + 0.65 * speed01;   // 高速走刃，低速搓雪

    if (isSki) {
      p.hipY = HIP_STAND - 0.06 * speed01 - a * 0.08;
      p.lean = incl;
      p.pivotYaw = steer * 0.22 * (1 - carve * 0.6);       // 板子比速度方向多转一点（搓雪）
      p.spineZ = -incl * 0.55;                              // 上身反向 → 肩膀保持水平（角度平衡）
      p.spineY = -steer * 0.3;                              // 上身面向落线（反拧）
      p.hipX = -steer * 0.05;
      p.skiLroll = incl * 1.15; p.skiRroll = incl * 1.15;   // 立刃
      p.skiLz = -0.12 * Math.max(0, steer); p.skiRz = -0.12 * Math.max(0, -steer); // 内侧板领先
      p.spineX = 0.32 + a * 0.12;
      p.kneeX = -steer * 0.5;
      // 手：前伸，内侧手略高
      p.uLx = 0.6 + Math.max(0, steer) * 0.25; p.uRx = 0.6 + Math.max(0, -steer) * 0.25;
      p.uLz = -0.35 - Math.max(0, -steer) * 0.15; p.uRz = 0.35 + Math.max(0, steer) * 0.15;
      p.fLx = 0.6; p.fRx = 0.6;
      p.poleX = -0.5;

      if (brake) {
        // 犁式刹车：板尾张开、板头靠拢、内刃立起，身体直立、手前伸
        const w = 0.32;
        p.skiLyaw = -w; p.skiRyaw = w;
        p.skiLx = -0.24; p.skiRx = 0.24;
        p.skiLroll = -0.22 + incl * 0.5; p.skiRroll = 0.22 + incl * 0.5;
        p.hipY = HIP_STAND - 0.16;
        p.hipZ = 0.04;
        p.spineX = 0.28; p.lean = incl * 0.5; p.pivotYaw = steer * 0.12;
        p.uLx = 0.85; p.uRx = 0.85; p.uLz = -0.4; p.uRz = 0.4; p.fLx = 0.3; p.fRx = 0.3;
        p.poleX = -0.9;
        p.kneeIn = 0.4; // 双膝内扣
      }
      if (tuck && !brake) {
        // tuck：深蹲、上身水平、雪杖夹在腋下向后
        p.hipY = HIP_STAND - 0.42;
        p.hipZ = -0.02;
        p.spineX = 1.25; p.headX = -0.95;
        p.spineZ = -incl * 0.3;
        p.uLx = 0.2; p.uRx = 0.2; p.uLz = -0.18; p.uRz = 0.18; p.fLx = 0.55; p.fRx = 0.55;
        p.poleX = -1.45;
        p.skiLx = -0.13; p.skiRx = 0.13;
        p.pivotYaw = steer * 0.08;
      }
      if (air) {
        // 空中：收腿抬板、板头微翘、双臂展开找平衡
        p.stanceY = 0.22;
        p.skiPitch = 0.18;
        p.hipY = HIP_STAND - 0.2;
        p.lean = incl * 0.3; p.pivotYaw = 0;
        p.spineX = 0.35; p.spineZ = 0; p.spineY = 0;
        p.uLx = 0.25; p.uRx = 0.25; p.uLz = -1.25; p.uRz = 1.25; p.fLx = 0.35; p.fRx = 0.35;
        p.poleX = -0.6;
        p.skiLroll = 0; p.skiRroll = 0; p.skiLz = 0; p.skiRz = 0;
      }
    } else {
      // ---------- 单板 ----------
      // steer>0 左转 = 后刃（脚跟侧）；steer<0 右转 = 前刃（脚尖侧）
      const heel = Math.max(0, steer), toe = Math.max(0, -steer);
      p.lean = incl;
      p.boardRoll = incl * 1.2;
      p.pivotYaw = steer * 0.32 * (1 - carve * 0.5);
      p.hipY = HIP_STAND - 0.12 - a * 0.12 - heel * 0.08;
      p.hipZ = heel * 0.1 - toe * 0.07;       // 后刃坐髋在脚跟上，前刃髋压向脚尖
      p.hipX = 0.0;
      p.spineX = 0.2 + toe * 0.35 + heel * 0.05;   // 前刃上身前压，后刃上身直立平衡
      p.spineZ = -incl * 0.4;
      p.spineY = 0.35 + heel * 0.15 - toe * 0.2;   // 后刃肩膀更开，前刃略反拧
      p.headY = 0.7;
      p.headX = -0.1 - toe * 0.2;
      p.uLx = 0.15 + toe * 0.25; p.uLz = -0.95 - heel * 0.25; p.uLy = 0.2;
      p.uRx = 0.2 + heel * 0.35; p.uRz = 0.55 + toe * 0.3;
      p.fLx = 0.35; p.fRx = 0.45;
      p.kneeX = 0;

      if (brake) {
        // 横板后刃刹车
        p.pivotYaw = -1.0;
        p.lean = 0.24;
        p.boardRoll = 0.32;
        p.hipY = HIP_STAND - 0.34; p.hipZ = 0.12;
        p.spineX = 0.5; p.spineY = 0.1; p.spineZ = -0.12; p.headY = 0.2;
        p.uLx = 0.4; p.uLz = -0.9; p.uRx = 0.4; p.uRz = 0.9;
      }
      if (tuck && !brake) {
        p.hipY = HIP_STAND - 0.42;
        p.spineX = 0.75; p.headX = -0.5;
        p.uLx = 0.55; p.uLz = -0.4; p.uRx = 0.55; p.uRz = 0.35; p.fLx = 0.9; p.fRx = 0.9;
      }
      if (air) {
        // Indy 抓板：收膝抬板，后手（右手）向下抓板前刃，前手举起
        p.stanceY = 0.3;
        p.boardPitch = 0.12;
        p.hipY = HIP_STAND - 0.3;
        p.lean = 0.1; p.pivotYaw = 0;
        p.spineX = 0.75; p.spineZ = 0.15; p.spineY = 0.3;
        p.uLx = 0.1; p.uLz = -1.5; p.fLx = 0.3;
        p.uRx = 0.85; p.uRz = 0.15; p.fRx = 0.25;
        p.boardRoll = 0.1;
      }
    }
    return p;
  }

  _applyPose(p) {
    const plantL = this.plantL, plantR = this.plantR;
    this.lean.rotation.z = p.lean;
    this.pivot.rotation.y = p.pivotYaw;
    this.stance.position.y = p.stanceY;

    this.pelvis.position.set(p.hipX, p.hipY - this.absorb * 0.16, p.hipZ);
    this.spine.rotation.set(p.spineX + this.absorb * 0.25, p.spineY, p.spineZ);
    this.head.rotation.set(p.headX - this.absorb * 0.2, p.headY, 0);

    // 手臂（点杖时内侧手前推、杖尖下落）
    this.upperL.rotation.set(p.uLx + plantL * 0.9, p.uLy, p.uLz + plantL * 0.15);
    this.foreL.rotation.set(p.fLx - plantL * 0.3, 0, 0);
    this.upperR.rotation.set(p.uRx + plantR * 0.9, p.uRy, p.uRz - plantR * 0.15);
    this.foreR.rotation.set(p.fRx - plantR * 0.3, 0, 0);

    if (this.isSki) {
      const chainL = p.spineX + this.upperL.rotation.x + this.foreL.rotation.x;
      const chainR = p.spineX + this.upperR.rotation.x + this.foreR.rotation.x;
      // 雪杖在世界系里保持后倾 poleX；点杖时立直
      this.poleL.rotation.x = (p.poleX * (1 - plantL) + 0.15 * plantL) - chainL;
      this.poleR.rotation.x = (p.poleX * (1 - plantR) + 0.15 * plantR) - chainR;
      this.poleL.rotation.z = 0.08; this.poleR.rotation.z = -0.08;

      this.skiL.position.set(p.skiLx, 0, p.skiLz);
      this.skiR.position.set(p.skiRx, 0, p.skiRz);
      this.skiL.rotation.set(p.skiPitch, p.skiLyaw, p.skiLroll);
      this.skiR.rotation.set(p.skiPitch, p.skiRyaw, p.skiRroll);
    } else {
      this.board.rotation.set(p.boardPitch, 0, p.boardRoll);
    }

    // ---- 腿部 IK ----
    this.root.updateMatrixWorld(true);
    for (const [thigh, shin, anchor, sx] of [[this.thighL, this.shinL, this.anchors[0], -1], [this.thighR, this.shinR, this.anchors[1], 1]]) {
      anchor.getWorldPosition(_t);
      this.pelvis.worldToLocal(_t);
      // 双板：膝盖随转向内压 / 刹车时内扣；单板：膝盖朝身体前方并略向外
      if (this.isSki) _hint.set(p.kneeX - sx * p.kneeIn, 0, -1).normalize();
      else _hint.set(sx * 0.25, 0, -1).normalize();
      solveLeg(thigh, shin, _t, _hint);
    }
  }

  // 触发点杖（side: -1 左 / 1 右）
  plant(side) {
    if (side < 0) this.plantTimerL = 0.42; else this.plantTimerR = 0.42;
  }

  // 落地缓冲
  land(strength = 1) {
    this.absorbV += 6 * strength;
  }

  /**
   * @param {object} s  { steer, brake, tuck, air, speed01, normal(世界系坡面法线或 null), heading, dt }
   */
  update(s) {
    const dt = s.dt;
    this.time += dt;

    // 换弯点杖：转向从 0/反向切换到新方向，且有一定速度
    if (this.isSki && s.speed01 > 0.12 && !s.air) {
      if (s.steer !== 0 && Math.sign(s.steer) !== Math.sign(this.prevSteer)) this.plant(s.steer > 0 ? -1 : 1);
    }
    this.prevSteer = s.steer;
    for (const side of ['L', 'R']) {
      const key = 'plantTimer' + side;
      if (this[key] > 0) {
        this[key] = Math.max(0, this[key] - dt);
        this['plant' + side] = Math.sin(Math.PI * (1 - this[key] / 0.42));
      } else this['plant' + side] = 0;
    }

    // 落地缓冲弹簧
    const k = 90, c = 12;
    this.absorbV += (-k * this.absorb - c * this.absorbV) * dt;
    this.absorb = Math.max(0, this.absorb + this.absorbV * dt);
    if (this.absorb === 0 && this.absorbV < 0) this.absorbV = 0;

    this.airT = s.air ? this.airT + dt : 0;

    // 目标姿态 + 平滑
    const tgt = this._target(s.steer, s.brake, s.tuck, s.air, s.speed01);
    const rate = s.air ? 6 : 9;
    const kk = 1 - Math.exp(-rate * dt);
    for (const key in tgt) this.cur[key] += (tgt[key] - this.cur[key]) * kk;

    // 呼吸 / 微颤（速度感）
    const p = this.cur;
    const jitter = s.air ? 0 : s.speed01 * 0.006;
    p.hipY += (Math.random() - 0.5) * jitter;

    // 贴合坡面
    if (s.normal) {
      _nLocal.copy(s.normal).applyAxisAngle(_up, -s.heading);
      _q.setFromUnitVectors(_up, _nLocal);
      this.tilt.quaternion.slerp(_q, 1 - Math.pow(0.0005, dt));
    } else {
      _q.identity();
      // 空中：轻微前倾/后仰随滞空时间
      _q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.sin(this.airT * 3) * 0.06);
      this.tilt.quaternion.slerp(_q, 1 - Math.pow(0.02, dt));
    }

    this.lean.position.y = 0;
    this._applyPose(p);
  }

  // 摔倒：整体翻滚 + 四肢甩动
  tumble(t) {
    this.lean.rotation.x = -t * 7;
    this.lean.rotation.z = t * 4;
    this.lean.position.y = Math.max(0, Math.sin(Math.min(t * 6, Math.PI)) * 0.8);
    const f = Math.sin(t * 18);
    this.upperL.rotation.set(1.6 + f * 0.6, 0, -1.4);
    this.upperR.rotation.set(1.2 - f * 0.6, 0, 1.4);
    this.foreL.rotation.x = 0.6; this.foreR.rotation.x = 0.6;
    this.spine.rotation.set(0.5 + f * 0.2, 0, 0);
    this.stance.rotation.set(t * 5, t * 3, 0);
    this.stance.position.y = Math.max(0, Math.sin(Math.min(t * 6, Math.PI)) * 0.4);
    this.root.updateMatrixWorld(true);
    _hint.set(0, 0, -1);
    for (const [thigh, shin, anchor] of [[this.thighL, this.shinL, this.anchors[0]], [this.thighR, this.shinR, this.anchors[1]]]) {
      anchor.getWorldPosition(_t);
      this.pelvis.worldToLocal(_t);
      solveLeg(thigh, shin, _t, _hint);
    }
  }
}
