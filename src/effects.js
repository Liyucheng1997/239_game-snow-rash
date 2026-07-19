import * as THREE from 'three';
import { groundY, SLOPE } from './terrain.js';

// 圆形柔边粒子贴图
function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.6, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}
const DOT = makeDotTexture();

// ---- 漫天飘雪 ----
export class Snowfall {
  constructor(scene, count = 1800) {
    this.count = count;
    this.box = new THREE.Vector3(140, 70, 160);
    const pos = new Float32Array(count * 3);
    this.drift = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.box.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * this.box.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      this.drift[i * 2] = Math.random() * Math.PI * 2;
      this.drift[i * 2 + 1] = 0.5 + Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.32, map: DOT, transparent: true, opacity: 0.85,
      depthWrite: false, sizeAttenuation: true, color: 0xffffff,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(center, dt, t) {
    this.points.position.copy(center);
    const pos = this.points.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < this.count; i++) {
      const sp = this.drift[i * 2 + 1];
      arr[i * 3 + 1] -= dt * (2.2 * sp);
      arr[i * 3] += Math.sin(t * 1.3 + this.drift[i * 2]) * dt * 0.7;
      if (arr[i * 3 + 1] < -this.box.y / 2) {
        arr[i * 3 + 1] += this.box.y;
        arr[i * 3] = (Math.random() - 0.5) * this.box.x;
        arr[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      }
    }
    pos.needsUpdate = true;
  }
}

// ---- 喷雪粒子（转弯 / 刹车 / 落地） ----
export class SnowSpray {
  constructor(scene, max = 500) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.55, map: DOT, transparent: true, opacity: 0.9,
      depthWrite: false, color: 0xf0f6ff,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -9999;
  }

  emit(origin, baseVel, count, spread = 1.6) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.3;
      this.pos[i * 3 + 1] = origin.y + Math.random() * 0.15;
      this.pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.3;
      this.vel[i * 3] = baseVel.x + (Math.random() - 0.5) * spread;
      this.vel[i * 3 + 1] = baseVel.y + Math.random() * spread;
      this.vel[i * 3 + 2] = baseVel.z + (Math.random() - 0.5) * spread;
      this.life[i] = 0.5 + Math.random() * 0.5;
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; continue; }
      this.vel[i * 3 + 1] -= 9.8 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ---- 雪板刻痕尾迹 ----
export class Trail {
  constructor(scene, width = 0.12, maxSeg = 220) {
    this.width = width;
    this.maxSeg = maxSeg;
    this.head = 0;
    this.count = 0;
    this.positions = new Float32Array(maxSeg * 2 * 3);
    this.alphas = new Float32Array(maxSeg * 2).fill(0);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    // 索引：连接相邻两排顶点为条带
    const idx = [];
    for (let i = 0; i < maxSeg - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {},
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying float vA;
        void main(){ gl_FragColor = vec4(0.62, 0.72, 0.86, vA * 0.55); }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.lastPos = null;
    scene.add(this.mesh);
  }

  push(center, sideDir) {
    if (this.lastPos && this.lastPos.distanceTo(center) < 0.4) return;
    this.lastPos = (this.lastPos || new THREE.Vector3()).copy(center);
    const i = this.head;
    this.head = (this.head + 1) % this.maxSeg;
    const hw = this.width / 2;
    this.positions[i * 6] = center.x - sideDir.x * hw;
    this.positions[i * 6 + 1] = center.y + 0.04;
    this.positions[i * 6 + 2] = center.z - sideDir.z * hw;
    this.positions[i * 6 + 3] = center.x + sideDir.x * hw;
    this.positions[i * 6 + 4] = center.y + 0.04;
    this.positions[i * 6 + 5] = center.z + sideDir.z * hw;
    this.alphas[i * 2] = this.alphas[i * 2 + 1] = 1;
    // 环形缓冲接缝处透明，避免首尾相连
    const seam = this.head;
    this.alphas[seam * 2] = this.alphas[seam * 2 + 1] = 0;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }

  fade(dt) {
    let dirty = false;
    for (let i = 0; i < this.alphas.length; i++) {
      if (this.alphas[i] > 0) { this.alphas[i] = Math.max(0, this.alphas[i] - dt * 0.12); dirty = true; }
    }
    if (dirty) this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

// ---- 天空 + 远山 ----
export function makeSky(scene) {
  const geo = new THREE.SphereGeometry(900, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y * 1.4 + 0.18, 0.0, 1.0);
        vec3 horizon = vec3(0.82, 0.88, 0.96);
        vec3 zenith  = vec3(0.32, 0.55, 0.88);
        vec3 col = mix(horizon, zenith, pow(h, 0.8));
        // 太阳光晕
        vec3 sunDir = normalize(vec3(0.45, 0.5, 0.35));
        float sun = pow(max(dot(vDir, sunDir), 0.0), 220.0);
        float halo = pow(max(dot(vDir, sunDir), 0.0), 8.0);
        col += vec3(1.0, 0.95, 0.8) * sun * 1.2 + vec3(1.0, 0.9, 0.7) * halo * 0.22;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  scene.add(sky);
  return sky;
}

export function makeMountains(scene) {
  const group = new THREE.Group();
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xe8eef8, roughness: 0.95, flatShading: true });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x9aa7bd, roughness: 0.95, flatShading: true });
  for (let i = 0; i < 16; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const h = 90 + Math.random() * 160;
    const r = h * (0.55 + Math.random() * 0.35);
    const geo = new THREE.ConeGeometry(r, h, 7 + ((Math.random() * 4) | 0));
    // 顶点扰动让山形不规则
    const p = geo.attributes.position;
    for (let v = 0; v < p.count; v++) {
      p.setX(v, p.getX(v) * (0.85 + Math.random() * 0.3));
      p.setZ(v, p.getZ(v) * (0.85 + Math.random() * 0.3));
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, Math.random() < 0.7 ? snowMat : rockMat);
    const dist = 190 + Math.random() * 320;
    const zoff = -500 + (i / 16) * 1000;
    m.position.set(side * dist * (0.7 + Math.random() * 0.5), h * 0.28, zoff);
    group.add(m);
  }
  scene.add(group);
  return group;
}
