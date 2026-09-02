import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { groundY, groundNormal, PISTE_HALF, CHUNK_LEN, NUM_CHUNKS } from './terrain.js';

const MODEL_LIST = [
  'tree-snow-a', 'tree-snow-b', 'tree-snow-c', 'tree-decorated-snow',
  'rocks-large', 'rocks-medium', 'rocks-small',
  'snowman', 'snow-pile', 'sled',
  'candy-cane-red', 'candy-cane-green',
  'snowflake-a', 'snowflake-b', 'snowflake-c',
];

export async function loadModels() {
  const loader = new GLTFLoader();
  const models = {};
  await Promise.all(
    MODEL_LIST.map(async (name) => {
      const gltf = await loader.loadAsync(`models/${name}.glb`);
      const scene = gltf.scene;
      scene.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          if (o.material) o.material.roughness = Math.min(0.95, o.material.roughness ?? 0.8);
        }
      });
      models[name] = scene;
    })
  );
  return models;
}

const TREES = ['tree-snow-a', 'tree-snow-b', 'tree-snow-c'];
const ROCKS = ['rocks-large', 'rocks-medium', 'rocks-small'];
const FLAKES = ['snowflake-a', 'snowflake-b', 'snowflake-c'];

// ---------- 程序化雪松（合并几何 + 顶点色，供实例化森林） ----------
function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function makeConiferGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.035, 0.06, 0.32, 7);
  trunk.translate(0, 0.16, 0);
  parts.push(colored(trunk, 0x5a3b26));
  // 三层树冠，每层上方盖一层雪
  const tiers = [[0.42, 0.55, 0.22], [0.34, 0.5, 0.48], [0.24, 0.42, 0.72]];
  for (const [r, h, y] of tiers) {
    const cone = new THREE.ConeGeometry(r, h, 8);
    cone.translate(0, y + h / 2, 0);
    parts.push(colored(cone, 0x2f6b3f));
    const snow = new THREE.ConeGeometry(r * 0.78, h * 0.55, 8);
    snow.translate(0, y + h * 0.45 + (h * 0.55) / 2, 0);
    parts.push(colored(snow, 0xf4f7fb));
  }
  const tip = new THREE.ConeGeometry(0.06, 0.12, 6);
  tip.translate(0, 1.12, 0);
  parts.push(colored(tip, 0xf4f7fb));
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// ---------- 密林：按地形块循环的实例化雪松 ----------
export class Forest {
  constructor(scene, perChunk = 170) {
    this.scene = scene;
    this.perChunk = perChunk;
    this.geo = makeConiferGeometry();
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
    this.blocks = [];
    this.tmp = new THREE.Object3D();
    this.col = new THREE.Color();
    for (let i = 0; i < NUM_CHUNKS; i++) {
      const m = new THREE.InstancedMesh(this.geo, this.mat, perChunk);
      m.castShadow = true;
      m.frustumCulled = false;
      m.userData.z0 = 60 - i * CHUNK_LEN;
      this._fill(m, m.userData.z0);
      scene.add(m);
      this.blocks.push(m);
    }
  }

  _fill(m, z0) {
    const zTop = z0, zBottom = z0 - CHUNK_LEN;
    for (let i = 0; i < this.perChunk; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      // 靠近雪道稀疏，远处渐密
      const u = Math.pow(Math.random(), 0.7);
      const x = side * (PISTE_HALF + 9 + u * 150);
      const z = zBottom + Math.random() * (zTop - zBottom);
      const s = 3.4 + Math.random() * 4.2;
      this.tmp.position.set(x, groundY(x, z) - 0.15, z);
      this.tmp.rotation.set(0, Math.random() * Math.PI * 2, 0);
      this.tmp.scale.set(s * (0.85 + Math.random() * 0.3), s, s * (0.85 + Math.random() * 0.3));
      this.tmp.updateMatrix();
      m.setMatrixAt(i, this.tmp.matrix);
      this.col.setHSL(0.36 + Math.random() * 0.06, 0.3 + Math.random() * 0.2, 0.3 + Math.random() * 0.14);
      m.setColorAt(i, this.col);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.userData.z0 = z0;
  }

  update(playerZ) {
    let minZ0 = Infinity, back = null;
    for (const b of this.blocks) {
      minZ0 = Math.min(minZ0, b.userData.z0);
      if (b.userData.z0 - CHUNK_LEN > playerZ + 80) back = b;
    }
    if (back) this._fill(back, minZ0 - CHUNK_LEN);
  }
}

// ---------- 雪道边界杆 ----------
function makeMarker(color) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.2, 6), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
  pole.position.y = 1.1;
  pole.castShadow = true;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0x111418, roughness: 0.6 }));
  band.position.y = 1.7;
  g.add(pole, band);
  return g;
}

export class ObstacleManager {
  constructor(scene, models) {
    this.scene = scene;
    this.models = models;
    this.items = [];      // {obj, x, z, r, kind}
    this.nextGateZ = -160;
    this.nextMarkerZ = 40;
    this.markerProto = [makeMarker(0xff6a1f), makeMarker(0x1f7dff)];
  }

  _place(name, x, z, scale, kind, r, yOff = 0, alignNormal = false, h = 99) {
    const obj = this.models[name].clone();
    obj.scale.setScalar(scale);
    const y = groundY(x, z);
    obj.position.set(x, y + yOff, z);
    obj.rotation.y = Math.random() * Math.PI * 2;
    if (alignNormal) {
      const n = groundNormal(x, z);
      obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    }
    this.scene.add(obj);
    const item = { obj, x, z, r, kind, h };
    this.items.push(item);
    return item;
  }

  _placeMarker(x, z, which) {
    const obj = this.markerProto[which].clone();
    obj.position.set(x, groundY(x, z) - 0.1, z);
    obj.rotation.z = (Math.random() - 0.5) * 0.08;
    this.scene.add(obj);
    this.items.push({ obj, x, z, r: 0, kind: 'deco', h: 0 });
  }

  // 为新地形区间 [zBottom, zTop] 生成内容，difficulty 0..1
  populate(zTop, zBottom, difficulty) {
    const len = zTop - zBottom;
    const rand = (a, b) => a + Math.random() * (b - a);

    // 雪道边界杆（左橙右蓝，每 22m 一对）
    while (this.nextMarkerZ > zBottom) {
      if (this.nextMarkerZ <= zTop) {
        this._placeMarker(-(PISTE_HALF + 2.5), this.nextMarkerZ, 0);
        this._placeMarker(PISTE_HALF + 2.5, this.nextMarkerZ, 1);
      }
      this.nextMarkerZ -= 22;
    }

    // 雪道边缘的 Kenney 雪树（较近，与密林衔接）
    const sideTrees = Math.floor(len / 12);
    for (let i = 0; i < sideTrees; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * rand(PISTE_HALF + 5, PISTE_HALF + 16);
      const z = rand(zBottom, zTop);
      const s = rand(2.4, 4.2);
      this._place(TREES[(Math.random() * 3) | 0], x, z, s, 'crash', 0.5 * s * 0.5);
    }

    // 雪道内障碍：树 / 岩石 / 雪人，密度随难度增加
    const inPiste = Math.floor(len / 30 * (1.2 + difficulty * 2.6));
    for (let i = 0; i < inPiste; i++) {
      const x = rand(-PISTE_HALF - 4, PISTE_HALF + 4);
      const z = rand(zBottom, zTop - 8);
      const roll = Math.random();
      if (roll < 0.45) {
        const s = rand(2.0, 3.2);
        this._place(TREES[(Math.random() * 3) | 0], x, z, s, 'crash', 0.5 * s * 0.5);
      } else if (roll < 0.75) {
        const which = (Math.random() * 3) | 0;
        const s = rand(1.6, 2.6);
        this._place(ROCKS[which], x, z, s, 'crash', (0.9 - which * 0.22) * s, -0.1, true, 0.8 * s);
      } else if (roll < 0.87) {
        this._place('snowman', x, z, rand(1.4, 1.9), 'crash', 0.7, 0, false, 2.6);
      } else {
        // 雪堆 = 跳台
        this._place('snow-pile', x, z, rand(2.4, 3.4), 'ramp', 2.2, -0.15, true);
      }
    }

    if (Math.random() < 0.3) {
      const side = Math.random() < 0.5 ? -1 : 1;
      this._place('tree-decorated-snow', side * rand(PISTE_HALF + 6, 40), rand(zBottom, zTop), 3.2, 'crash', 0.9);
    }
    if (Math.random() < 0.15) {
      this._place('sled', rand(-PISTE_HALF, PISTE_HALF), rand(zBottom, zTop), 1.5, 'crash', 0.6, 0, true, 1.0);
    }

    // 旗门（红绿糖果杖成对，穿过得分）
    while (this.nextGateZ > zBottom) {
      if (this.nextGateZ <= zTop) {
        const cx = rand(-14, 14);
        const half = 5.5;
        const z = this.nextGateZ;
        const l = this._place('candy-cane-red', cx - half, z, 5.5, 'gatepole', 0.35);
        const rr = this._place('candy-cane-green', cx + half, z, 5.5, 'gatepole', 0.35);
        l.obj.rotation.y = Math.PI / 2;
        rr.obj.rotation.y = -Math.PI / 2;
        this.items.push({ obj: null, x: cx, z, r: half, kind: 'gate', passed: false });
      }
      this.nextGateZ -= 140 + Math.random() * 80;
    }

    // 雪花收集线（沿雪道排布）
    const flakeLines = Math.random() < 0.75 ? 1 : 2;
    for (let i = 0; i < flakeLines; i++) {
      const n = 4 + ((Math.random() * 3) | 0);
      const x0 = rand(-16, 16);
      const z0 = rand(zBottom + 20, zTop - 10);
      const curve = rand(-0.8, 0.8);
      for (let j = 0; j < n; j++) {
        const z = z0 - j * 5;
        const x = x0 + Math.sin(j * 0.6) * curve * 6;
        const it = this._place(FLAKES[(Math.random() * 3) | 0], x, z, 0.85, 'flake', 1.7, 1.2);
        it.spin = Math.random() * Math.PI * 2;
      }
    }
  }

  // 移除玩家身后的物体
  cull(playerZ) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.z > playerZ + 60) {
        if (it.obj) this.scene.remove(it.obj);
        this.items.splice(i, 1);
      }
    }
  }

  // 雪花旋转动画
  animate(t) {
    for (const it of this.items) {
      if (it.kind === 'flake' && it.obj) {
        it.obj.rotation.y = t * 2 + (it.spin || 0);
        it.obj.position.y = groundY(it.x, it.z) + 1.1 + Math.sin(t * 3 + it.spin) * 0.15;
      }
    }
  }
}
