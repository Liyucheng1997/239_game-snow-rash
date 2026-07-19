import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { groundY, groundNormal, PISTE_HALF } from './terrain.js';

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
      const gltf = await loader.loadAsync(`/models/${name}.glb`);
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

export class ObstacleManager {
  constructor(scene, models) {
    this.scene = scene;
    this.models = models;
    this.items = [];      // {obj, x, z, r, kind}
    this.nextGateZ = -160;
    this.gateCount = 0;
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

  // 为新地形区间 [zBottom, zTop] 生成内容，difficulty 0..1
  populate(zTop, zBottom, difficulty) {
    const len = zTop - zBottom;
    const rand = (a, b) => a + Math.random() * (b - a);

    // 雪道两侧的密林（装饰 + 边界威慑）
    const sideTrees = Math.floor(len / 7);
    for (let i = 0; i < sideTrees; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const x = side * rand(PISTE_HALF + 8, 95);
      const z = rand(zBottom, zTop);
      const s = rand(2.2, 4.2);
      this._place(TREES[(Math.random() * 3) | 0], x, z, s, 'deco', 0);
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

    // 圣诞树彩灯树（稀有装饰）
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
