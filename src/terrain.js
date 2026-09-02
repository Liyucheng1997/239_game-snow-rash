import * as THREE from 'three';

// ---- 坡面参数 ----
export const SLOPE = 0.30;        // 整体坡度（下坡方向为 -Z）
export const PISTE_HALF = 26;     // 雪道平滑区半宽
export const CHUNK_LEN = 90;      // 每段地形长度
export const CHUNK_W = 360;       // 地形宽度
export const NUM_CHUNKS = 9;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// 地形高度（解析函数，物理与网格共用同一来源）
export function groundY(x, z) {
  let y = z * SLOPE;
  const ax = Math.abs(x);
  // 大起伏：雪道中心平缓，两侧更明显
  let b =
    Math.sin(x * 0.043 + z * 0.021) * Math.sin(z * 0.017 + 1.7) * 1.15 +
    Math.sin(x * 0.11 + 2.0 + z * 0.043) * 0.42 +
    Math.sin(z * 0.055 + x * 0.021) * 0.5;
  const off = smoothstep(PISTE_HALF * 0.55, PISTE_HALF * 1.7, ax);
  b *= 0.3 + 0.7 * off;
  // 野雪区蘑菇包
  b += Math.sin(x * 0.37 + z * 0.11) * Math.sin(z * 0.31 - x * 0.07) * 0.32 * off;
  y += b;
  // 轻微的沟槽让玩家自然回到雪道中央
  y += x * x * 0.0035;
  // 雪道边缘压雪机推出的雪坎
  const berm = ax - (PISTE_HALF + 3);
  y += Math.exp(-berm * berm / 6) * 0.35;
  // 两侧雪坡抬升，形成山谷感
  const e = smoothstep(36, 160, ax);
  y += e * e * 48;
  return y;
}

export function groundNormal(x, z, out = new THREE.Vector3()) {
  const e = 0.6;
  const dx = (groundY(x + e, z) - groundY(x - e, z)) / (2 * e);
  const dz = (groundY(x, z + e) - groundY(x, z - e)) / (2 * e);
  return out.set(-dx, 1, -dz).normalize();
}

// ---- 雪面材质：细节法线 + 压雪纹 + 野雪粉雪 + 阳光闪光 ----
export function makeSnowMaterial(sunDir) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xf6f9ff,
    roughness: 0.92,
    metalness: 0.0,
  });
  mat.userData.uniforms = {
    uSun: { value: sunDir.clone() },
    uPisteHalf: { value: PISTE_HALF },
    uTime: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed,1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWp;
        uniform vec3 uSun;
        uniform float uPisteHalf;
        float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        float vnoise(vec2 p){
          vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
          float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
          return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
        }
        float fbm(vec2 p){ return vnoise(p)*0.55 + vnoise(p*2.13+7.1)*0.28 + vnoise(p*4.7+3.3)*0.17; }
      `)
      // 法线细节：雪道内压雪纹（顺坡细条纹）+ 野雪粉雪凹凸
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float camDist = length(cameraPosition - vWp);
        float detailFade = smoothstep(120.0, 20.0, camDist);
        float ax = abs(vWp.x);
        float piste = 1.0 - smoothstep(uPisteHalf + 1.0, uPisteHalf + 5.0, ax);
        // 压雪纹：周期 0.28m，随距离淡出
        float cordFade = smoothstep(55.0, 12.0, camDist);
        vec2 gCord = vec2(cos(vWp.x * 22.4) * 0.022, 0.0) * cordFade * piste;
        // 粉雪：两层噪声的梯度
        float e = 0.35;
        float n0 = fbm(vWp.xz * 0.9);
        float nx = fbm((vWp.xz + vec2(e,0.0)) * 0.9);
        float nz = fbm((vWp.xz + vec2(0.0,e)) * 0.9);
        vec2 gPow = vec2(nx - n0, nz - n0) / e * (0.55 * (1.0 - piste) + 0.10 * piste) * detailFade;
        // 中尺度雪浪（野雪）
        float m0 = vnoise(vWp.xz * 0.18);
        float mx = vnoise((vWp.xz + vec2(1.0,0.0)) * 0.18);
        float mz = vnoise((vWp.xz + vec2(0.0,1.0)) * 0.18);
        vec2 gMid = vec2(mx - m0, mz - m0) * 0.9 * (1.0 - piste);
        vec3 offW = vec3(-(gCord.x + gPow.x + gMid.x), 0.0, -(gCord.y + gPow.y + gMid.y));
        normal = normalize(normal + mat3(viewMatrix) * offW);
      `)
      // 雪面细微反照率变化：大尺度轻微灰蓝斑块，压雪道更均匀
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float ax0 = abs(vWp.x);
          float piste0 = 1.0 - smoothstep(uPisteHalf + 1.0, uPisteHalf + 5.0, ax0);
          float big = vnoise(vWp.xz * 0.07) * 0.6 + vnoise(vWp.xz * 0.23 + 5.0) * 0.4;
          float shade = 1.0 - (0.5 - big) * (0.05 + 0.06 * (1.0 - piste0));
          diffuseColor.rgb *= vec3(shade, shade, mix(1.0, shade, 0.6));
        }
      `)
      .replace('#include <opaque_fragment>', `
        vec3 vDir = normalize(cameraPosition - vWp);
        vec3 nW = inverseTransformDirection(normal, viewMatrix);
        // 阳光闪光：面向太阳反射方向的细小颗粒，视角移动时随机闪烁
        vec3 h = normalize(uSun + vDir);
        float facing = pow(max(dot(nW, h), 0.0), 6.0);
        float cell = hash21(floor(vWp.xz * 70.0) + floor(vDir.xz * 9.0));
        float sparkle = smoothstep(0.993, 1.0, cell) * smoothstep(60.0, 15.0, camDist) * facing;
        // 阴面偏蓝（天光反射），向阳偏暖白；雪道压雪略灰
        float upness = clamp(nW.y, 0.0, 1.0);
        float sunlit = clamp(dot(nW, uSun), 0.0, 1.0);
        outgoingLight = mix(outgoingLight * vec3(0.82, 0.90, 1.10), outgoingLight, upness * 0.6 + sunlit * 0.4);
        // 雪的次表面散射感：受光边缘微微透亮
        outgoingLight += vec3(0.06, 0.05, 0.03) * pow(sunlit, 0.5) * (1.0 - piste * 0.4);
        outgoingLight *= 1.0 - piste * 0.035;
        outgoingLight += sparkle * 1.1;
        #include <opaque_fragment>
      `);
  };
  return mat;
}

// ---- 无尽地形块管理 ----
export class Terrain {
  constructor(scene, sunDir) {
    this.scene = scene;
    this.material = makeSnowMaterial(sunDir);
    this.chunks = [];
    for (let i = 0; i < NUM_CHUNKS; i++) {
      const mesh = this._buildChunk(60 - i * CHUNK_LEN);
      this.chunks.push(mesh);
      scene.add(mesh);
    }
  }

  _buildChunk(z0) {
    // 区间 [z0 - CHUNK_LEN, z0]
    const geo = new THREE.PlaneGeometry(CHUNK_W, CHUNK_LEN, 150, 56);
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
      // 雪道内加密采样：把 x 向中间压缩
      let x = pos.getX(i);
      const z = pos.getZ(i) + z0 - CHUNK_LEN / 2;
      pos.setY(i, groundY(x, z));
      pos.setZ(i, z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  // 若有地形块被回收到最前方，返回新铺区间 {zTop, zBottom} 供障碍物生成
  update(playerZ) {
    let minZ0 = Infinity;
    let backChunk = null;
    for (const c of this.chunks) {
      minZ0 = Math.min(minZ0, c.userData.z0);
      if (c.userData.z0 - CHUNK_LEN > playerZ + 80) backChunk = c;
    }
    if (backChunk) {
      const newZ0 = minZ0 - CHUNK_LEN;
      this._displace(backChunk.geometry, newZ0);
      backChunk.userData.z0 = newZ0;
      return { zTop: newZ0, zBottom: newZ0 - CHUNK_LEN };
    }
    return null;
  }
}
