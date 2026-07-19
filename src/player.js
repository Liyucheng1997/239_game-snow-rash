import * as THREE from 'three';

const COLORS = {
  jacketSki: 0xe84e3c,     // 双板：红色冲锋衣
  jacketBoard: 0x2ea8e0,   // 单板：蓝色滑手服
  pants: 0x2b3a55,
  skin: 0xf2c9a0,
  beanieSki: 0x333a4d,
  beanieBoard: 0xf5b53f,
  goggles: 0x37e0c8,
  ski: 0xffd24a,
  board: 0x9b59e0,
  boots: 0x22262e,
  pole: 0x888e99,
};

function box(w, h, d, color, opts = {}) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.75, metalness: opts.metal ?? 0 })
  );
  m.castShadow = true;
  return m;
}

// 构造一支雪板（type: 'ski' 单支雪板 | 'board' 单板）
function makeBoard(type) {
  const g = new THREE.Group();
  const [w, l, color] = type === 'ski' ? [0.13, 1.75, COLORS.ski] : [0.32, 1.55, COLORS.board];
  const body = box(w, 0.045, l, color, { rough: 0.35 });
  body.position.y = 0.022;
  g.add(body);
  // 翘起的板头（单板双头翘）
  const tip = box(w, 0.045, 0.22, color, { rough: 0.35 });
  tip.position.set(0, 0.08, -l / 2 - 0.07);
  tip.rotation.x = -0.6;
  g.add(tip);
  if (type === 'board') {
    const tail = tip.clone();
    tail.position.z = l / 2 + 0.07;
    tail.rotation.x = 0.6;
    g.add(tail);
  }
  // 板面装饰条
  const stripe = box(w * 0.55, 0.01, l * 0.6, 0xffffff, { rough: 0.3 });
  stripe.position.y = 0.05;
  g.add(stripe);
  return g;
}

export class Player {
  constructor(scene, mode /* 'ski' | 'board' */) {
    this.mode = mode;
    this.root = new THREE.Group();      // 位置 + 朝向（航向）
    this.tilt = new THREE.Group();      // 贴合坡面
    this.rig = new THREE.Group();       // 压弯侧倾 / 蹲伏
    this.root.add(this.tilt);
    this.tilt.add(this.rig);
    scene.add(this.root);
    this._build();

    // 姿态动画状态
    this.leanCur = 0;
    this.crouchCur = 0;
  }

  _build() {
    const isSki = this.mode === 'ski';
    const rig = this.rig;
    const jacket = isSki ? COLORS.jacketSki : COLORS.jacketBoard;
    const beanie = isSki ? COLORS.beanieSki : COLORS.beanieBoard;

    // ---- 雪板 ----
    if (isSki) {
      this.boardL = makeBoard('ski'); this.boardL.position.set(-0.14, 0, 0);
      this.boardR = makeBoard('ski'); this.boardR.position.set(0.14, 0, 0);
      rig.add(this.boardL, this.boardR);
    } else {
      this.board = makeBoard('board');
      this.board.rotation.y = Math.PI / 2 - 0.35; // 横向站姿，稍带角度
      rig.add(this.board);
    }

    // ---- 身体（挂在 body 组上便于蹲伏） ----
    const body = new THREE.Group();
    this.body = body;
    rig.add(body);

    // 腿
    this.legL = new THREE.Group();
    this.legR = new THREE.Group();
    const stance = isSki ? 0.14 : 0.24;
    this.legL.position.set(-stance, 0.62, isSki ? 0 : -0.1);
    this.legR.position.set(stance, 0.62, isSki ? 0 : 0.1);
    for (const [leg, side] of [[this.legL, -1], [this.legR, 1]]) {
      const thigh = box(0.15, 0.34, 0.17, COLORS.pants);
      thigh.position.y = -0.14;
      const shin = box(0.13, 0.3, 0.15, COLORS.pants);
      shin.position.y = -0.45;
      const boot = box(0.16, 0.16, 0.3, COLORS.boots);
      boot.position.set(0, -0.56, 0.02);
      leg.add(thigh, shin, boot);
      body.add(leg);
    }

    // 躯干
    this.torso = new THREE.Group();
    this.torso.position.y = 0.62;
    const chest = box(0.44, 0.5, 0.26, jacket);
    chest.position.y = 0.26;
    const zipper = box(0.05, 0.44, 0.02, 0xffffff);
    zipper.position.set(0, 0.26, 0.135);
    this.torso.add(chest, zipper);
    body.add(this.torso);

    // 头
    this.head = new THREE.Group();
    this.head.position.y = 0.62;
    const face = box(0.26, 0.26, 0.24, COLORS.skin);
    const hat = box(0.3, 0.14, 0.28, beanie);
    hat.position.y = 0.17;
    const pom = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })
    );
    pom.position.y = 0.27; pom.castShadow = true;
    const goggle = box(0.28, 0.09, 0.06, COLORS.goggles, { rough: 0.15 });
    goggle.position.set(0, 0.04, 0.13);
    this.head.add(face, hat, pom, goggle);
    this.torso.add(this.head);

    // 手臂（+雪杖）
    this.armL = new THREE.Group();
    this.armR = new THREE.Group();
    this.armL.position.set(-0.26, 0.44, 0);
    this.armR.position.set(0.26, 0.44, 0);
    for (const [arm, side] of [[this.armL, -1], [this.armR, 1]]) {
      const upper = box(0.12, 0.3, 0.14, jacket);
      upper.position.y = -0.12;
      const glove = box(0.12, 0.12, 0.12, COLORS.boots);
      glove.position.y = -0.32;
      arm.add(upper, glove);
      if (isSki) {
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.015, 1.0),
          new THREE.MeshStandardMaterial({ color: COLORS.pole, roughness: 0.4, metalness: 0.6 })
        );
        pole.position.set(0, -0.7, -0.1);
        pole.rotation.x = 0.25;
        pole.castShadow = true;
        arm.add(pole);
      }
      arm.rotation.x = isSki ? 0.5 : 0.15;
      arm.rotation.z = side * (isSki ? 0.25 : 0.55);
      this.torso.add(arm);
    }

    if (!isSki) {
      // 单板站姿：身体侧向
      body.rotation.y = Math.PI / 2 - 0.5;
      this.head.rotation.y = 0.45; // 头看向前进方向
    }
  }

  // steer: -1..1，crouch: 0..1，air: 是否空中，dt
  pose(steer, crouch, air, speed01, dt) {
    const k = 1 - Math.pow(0.0001, dt); // 平滑系数
    const leanTgt = steer * (this.mode === 'board' ? 0.5 : 0.38) * (0.4 + 0.6 * speed01);
    this.leanCur += (leanTgt - this.leanCur) * k;
    const crouchTgt = air ? 0.55 : crouch;
    this.crouchCur += (crouchTgt - this.crouchCur) * k;

    // 压弯：整体侧倾（滑行者向弯心倾斜）
    this.rig.rotation.z = -this.leanCur;
    // 上身反向拧转保持平衡
    this.torso.rotation.z = this.leanCur * 0.45;
    this.torso.rotation.y = (this.mode === 'board' ? 0 : -this.leanCur * 0.4);

    // 蹲伏
    const c = this.crouchCur;
    this.body.position.y = -c * 0.22;
    this.legL.scale.y = this.legR.scale.y = 1 - c * 0.32;
    this.legL.position.y = this.legR.position.y = 0.62 - c * 0.2;
    this.torso.rotation.x = c * (this.mode === 'ski' ? 0.55 : 0.3);
    this.head.rotation.x = -c * 0.4;

    if (air) {
      // 空中抓板姿态
      this.armL.rotation.z = -1.2;
      this.armR.rotation.z = 1.2;
      this.rig.rotation.z = -this.leanCur * 0.4;
    } else {
      const isSki = this.mode === 'ski';
      this.armL.rotation.z = -(isSki ? 0.25 : 0.55) - this.leanCur * 0.3;
      this.armR.rotation.z = (isSki ? 0.25 : 0.55) - this.leanCur * 0.3;
    }

    // 高速时轻微抖动传递速度感
    this.body.position.x = (Math.random() - 0.5) * 0.01 * speed01;
  }

  // 摔倒动画（简单翻滚）
  tumble(t) {
    this.rig.rotation.x = -t * 7;
    this.rig.rotation.z = t * 4;
    this.rig.position.y = Math.max(0, Math.sin(Math.min(t * 6, Math.PI)) * 0.8);
  }
}
