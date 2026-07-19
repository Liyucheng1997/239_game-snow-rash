import * as THREE from 'three';

// ---- 坡面参数 ----
export const SLOPE = 0.30;        // 整体坡度（下坡方向为 -Z）
export const PISTE_HALF = 26;     // 雪道平滑区半宽
const CHUNK_LEN = 90;             // 每段地形长度
const CHUNK_W = 260;              // 地形宽度
const NUM_CHUNKS = 9;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 地形高度（解析函数，物理与网格共用同一来源）
export function groundY(x, z) {
  let y = z * SLOPE;
  // 起伏：雪道中心平缓，两侧蘑菇包更明显
  let b =
    Math.sin(x * 0.043 + z * 0.021) * Math.sin(z * 0.017 + 1.7) * 1.15 +
    Math.sin(x * 0.11 + 2.0 + z * 0.043) * 0.42 +
    Math.sin(z * 0.055 + x * 0.021) * 0.5;
  const off = smoothstep(PISTE_HALF * 0.55, PISTE_HALF * 1.7, Math.abs(x));
  b *= 0.3 + 0.7 * off;
  y += b;
  // 轻微的沟槽让玩家自然回到雪道中央
  y += x * x * 0.0035;
  // 两侧雪坡抬升，形成峡谷感
  const e = smoothstep(34, 95, Math.abs(x));
  y += e * e * 26;
  return y;
}

export function groundNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.6;
  const dx = (groundY(x + e, z) - groundY(x - e, z)) / (2 * e);
  const dz = (groundY(x, z + e) - groundY(x, z - e)) / (2 * e);
  return out.set(-dx, 1, -dz).normalize();
}

// ---- 雪面材质：带阳光下的闪光颗粒 ----
export function makeSnowMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xf4f8ff,
    roughness: 0.88,
    metalness: 0.0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed,1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWp;
        float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
      `)
      .replace('#include <opaque_fragment>', `
        // 雪面闪光：细密颗粒 + 视角抖动，移动时呈现随机闪烁
        vec3 vDir = normalize(cameraPosition - vWp);
        float camDist = length(cameraPosition - vWp);
        float sparkleCell = hash21(floor(vWp.xz * 55.0));
        float sparkle = smoothstep(0.9985, 1.0, sparkleCell) * smoothstep(60.0, 25.0, camDist);
        // 阴面偏蓝，向阳偏暖白
        float upness = clamp(normal.y, 0.0, 1.0);
        outgoingLight = mix(outgoingLight * vec3(0.88, 0.93, 1.06), outgoingLight, upness);
        outgoingLight += sparkle * 0.85 * upness;
        #include <opaque_fragment>
      `);
  };
  return mat;
}

// ---- 无尽地形块管理 ----
export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.material = makeSnowMaterial();
    this.chunks = [];
    // 从玩家起点后方一段开始铺
    for (let i = 0; i < NUM_CHUNKS; i++) {
      const mesh = this._buildChunk(60 - i * CHUNK_LEN);
      this.chunks.push(mesh);
      scene.add(mesh);
    }
  }

  _buildChunk(z0) {
    // 区间 [z0 - CHUNK_LEN, z0]
    const geo = new THREE.PlaneGeometry(CHUNK_W, CHUNK_LEN, 96, 40);
    geo.rotateX(-Math.PI / 2);
    this._displace(geo, z0);
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.userData.z0 = z0;
    return mesh;
  }

  _displace(geo, z0) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i) + z0 - CHUNK_LEN / 2;
      pos.setY(i, groundY(x, z));
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  // 若有地形块被回收到最前方，返回新铺区间 {zTop, zBottom} 供障碍物生成
  update(playerZ) {
    let minZ0 = Infinity;
    let backChunk = null;
    for (const c of this.chunks) {
      minZ0 = Math.min(minZ0, c.userData.z0);
      // 区间为 [z0 - L, z0]，最靠下坡的边缘已在玩家身后一段距离
      if (c.userData.z0 - CHUNK_LEN > playerZ + 80) backChunk = c;
    }
    if (backChunk) {
      const newZ0 = minZ0 - CHUNK_LEN; // 铺到最前方（更小的 z）
      this._displace(backChunk.geometry, newZ0);
      backChunk.userData.z0 = newZ0;
      return { zTop: newZ0 - 0, zBottom: newZ0 - CHUNK_LEN };
    }
    return null;
  }
}
