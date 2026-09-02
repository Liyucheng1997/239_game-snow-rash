import * as THREE from 'three';

// 圆形柔边粒子贴图
function makeDotTexture(soft = true) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(soft ? 0.35 : 0.7, 'rgba(255,255,255,.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const DOT = makeDotTexture(true);
const DOT_HARD = makeDotTexture(false);

// ---- 漫天飘雪（自定义点着色器：每片大小/透明度不同，带风） ----
export class Snowfall {
  constructor(scene, count = 2600) {
    this.count = count;
    this.box = new THREE.Vector3(150, 70, 170);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const alpha = new Float32Array(count);
    this.drift = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.box.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * this.box.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      const near = Math.random() < 0.25;
      size[i] = near ? 0.25 + Math.random() * 0.3 : 0.1 + Math.random() * 0.14;
      alpha[i] = near ? 0.9 : 0.55 + Math.random() * 0.3;
      this.drift[i * 2] = Math.random() * Math.PI * 2;
      this.drift[i * 2 + 1] = 0.6 + Math.random() * 0.9;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: DOT }, uScale: { value: 400 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; varying float vA;
        uniform float uScale;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / -mv.z;
          vA = aAlpha * smoothstep(90.0, 30.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying float vA;
        void main(){
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vec3(1.0), t.a * vA);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  update(center, dt, t) {
    this.points.position.copy(center);
    const pos = this.points.geometry.attributes.position;
    const arr = pos.array;
    const wind = Math.sin(t * 0.25) * 1.2;
    for (let i = 0; i < this.count; i++) {
      const sp = this.drift[i * 2 + 1];
      arr[i * 3 + 1] -= dt * (1.6 * sp);
      arr[i * 3] += (Math.sin(t * 1.3 + this.drift[i * 2]) * 0.6 + wind) * dt;
      arr[i * 3 + 2] += Math.cos(t * 0.9 + this.drift[i * 2]) * 0.4 * dt;
      if (arr[i * 3 + 1] < -this.box.y / 2) {
        arr[i * 3 + 1] += this.box.y;
        arr[i * 3] = (Math.random() - 0.5) * this.box.x;
        arr[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      }
    }
    pos.needsUpdate = true;
  }
}

// ---- 喷雪粒子（转弯 / 刹车 / 落地）：随寿命膨胀并淡出 ----
export class SnowSpray {
  constructor(scene, max = 900) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.life0 = new Float32Array(max);
    this.size = new Float32Array(max);
    this.aLife = new Float32Array(max);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aLife', new THREE.BufferAttribute(this.aLife, 1));
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { map: { value: DOT }, uScale: { value: 420 } },
      vertexShader: `
        attribute float aSize; attribute float aLife; varying float vL;
        uniform float uScale;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float grow = 1.0 + (1.0 - aLife) * 1.6;
          gl_PointSize = aSize * grow * uScale / -mv.z;
          vL = aLife;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying float vL;
        void main(){
          vec4 t = texture2D(map, gl_PointCoord);
          float a = t.a * smoothstep(0.0, 0.25, vL) * 0.8;
          gl_FragColor = vec4(vec3(0.96, 0.98, 1.0), a);
        }`,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    for (let i = 0; i < max; i++) this.pos[i * 3 + 1] = -9999;
  }

  emit(origin, baseVel, count, spread = 1.6, size = 0.55) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.35;
      this.pos[i * 3 + 1] = origin.y + Math.random() * 0.15;
      this.pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.35;
      this.vel[i * 3] = baseVel.x + (Math.random() - 0.5) * spread;
      this.vel[i * 3 + 1] = baseVel.y + Math.random() * spread;
      this.vel[i * 3 + 2] = baseVel.z + (Math.random() - 0.5) * spread;
      this.life[i] = this.life0[i] = 0.45 + Math.random() * 0.6;
      this.size[i] = size * (0.6 + Math.random() * 0.8);
      this.aLife[i] = 1;
    }
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -9999; this.aLife[i] = 0; continue; }
      this.aLife[i] = this.life[i] / this.life0[i];
      this.vel[i * 3 + 1] -= 7.5 * dt;
      // 空气阻力
      const d = 1 - 1.8 * dt;
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aLife.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

// ---- 雪板刻痕尾迹：中间深、两侧翻起的雪沿 ----
export class Trail {
  constructor(scene, width = 0.12, maxSeg = 260) {
    this.width = width;
    this.maxSeg = maxSeg;
    this.head = 0;
    this.positions = new Float32Array(maxSeg * 2 * 3);
    this.alphas = new Float32Array(maxSeg * 2).fill(0);
    const us = new Float32Array(maxSeg * 2);
    for (let i = 0; i < maxSeg; i++) { us[i * 2] = 0; us[i * 2 + 1] = 1; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
    const idx = [];
    for (let i = 0; i < maxSeg - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      vertexShader: `
        attribute float aAlpha; attribute float aU; varying float vA; varying float vU;
        void main(){ vA = aAlpha; vU = aU; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying float vA; varying float vU;
        void main(){
          float c = sin(vU * 3.14159);
          vec3 groove = vec3(0.55, 0.66, 0.84);
          vec3 edge = vec3(1.0, 1.0, 1.0);
          vec3 col = mix(edge, groove, c);
          float a = vA * (0.25 + 0.5 * c);
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.lastPos = null;
    scene.add(this.mesh);
  }

  push(center, sideDir, widthScale = 1) {
    if (this.lastPos && this.lastPos.distanceTo(center) < 0.35) return;
    this.lastPos = (this.lastPos || new THREE.Vector3()).copy(center);
    const i = this.head;
    this.head = (this.head + 1) % this.maxSeg;
    const hw = (this.width * widthScale) / 2;
    this.positions[i * 6] = center.x - sideDir.x * hw;
    this.positions[i * 6 + 1] = center.y + 0.05;
    this.positions[i * 6 + 2] = center.z - sideDir.z * hw;
    this.positions[i * 6 + 3] = center.x + sideDir.x * hw;
    this.positions[i * 6 + 4] = center.y + 0.05;
    this.positions[i * 6 + 5] = center.z + sideDir.z * hw;
    this.alphas[i * 2] = this.alphas[i * 2 + 1] = 1;
    const seam = this.head;
    this.alphas[seam * 2] = this.alphas[seam * 2 + 1] = 0;
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }

  fade(dt) {
    let dirty = false;
    for (let i = 0; i < this.alphas.length; i++) {
      if (this.alphas[i] > 0) { this.alphas[i] = Math.max(0, this.alphas[i] - dt * 0.1); dirty = true; }
    }
    if (dirty) this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

// ---- 天空：渐变 + 太阳 + 程序云 ----
export function makeSky(scene, sunDir) {
  const geo = new THREE.SphereGeometry(1500, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: sunDir.clone() }, uTime: { value: 0 } },
    vertexShader: `
      varying vec3 vDir;
      void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uSun; uniform float uTime;
      float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
      float vnoise(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        float a = hash21(i), b = hash21(i+vec2(1,0)), c = hash21(i+vec2(0,1)), d = hash21(i+vec2(1,1));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      float fbm(vec2 p){
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
        return v;
      }
      void main(){
        float h = clamp(vDir.y, -0.1, 1.0);
        vec3 horizon = vec3(0.86, 0.90, 0.96);
        vec3 mid     = vec3(0.55, 0.72, 0.93);
        vec3 zenith  = vec3(0.20, 0.42, 0.80);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.18, h));
        col = mix(col, zenith, smoothstep(0.15, 0.75, h));
        // 太阳与光晕
        float sd = max(dot(vDir, uSun), 0.0);
        float sun = pow(sd, 900.0);
        float halo = pow(sd, 12.0);
        float glow = pow(sd, 2.5);
        col += vec3(1.0, 0.97, 0.9) * sun * 2.0 + vec3(1.0, 0.92, 0.75) * halo * 0.35 + vec3(0.9, 0.85, 0.7) * glow * 0.12;
        // 云层：把方向投影到高空平面
        if (vDir.y > 0.02) {
          vec2 uv = vDir.xz / (vDir.y + 0.25) * 1.6 + vec2(uTime * 0.004, uTime * 0.0015);
          float n = fbm(uv);
          float cover = smoothstep(0.48, 0.72, n) * smoothstep(0.02, 0.2, vDir.y);
          float shade = smoothstep(0.5, 0.9, n);
          vec3 cloud = mix(vec3(0.78, 0.83, 0.9), vec3(1.0, 1.0, 1.0), shade);
          cloud += vec3(1.0, 0.95, 0.85) * halo * 0.3;
          col = mix(col, cloud, cover * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  scene.add(sky);
  return sky;
}

// ---- 远山：环形高度场，按坡度混合岩石 / 积雪 ----
function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}
function fbm(x, y, oct = 5) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x * f, y * f); f *= 2.05; a *= 0.5; }
  return v;
}

export function makeMountains(scene) {
  const group = new THREE.Group();
  const NA = 400, NR = 16;
  const R0 = 300, R1 = 1450;
  const positions = [];
  const colors = [];
  const idx = [];
  const snow = new THREE.Color(0xf2f5fa), rock = new THREE.Color(0x6f7787), rockLit = new THREE.Color(0x9aa3b3);
  const heights = [];
  for (let j = 0; j <= NR; j++) {
    const t = j / NR;
    const r = R0 * Math.pow(R1 / R0, t);
    for (let i = 0; i < NA; i++) {
      const th = (i / NA) * Math.PI * 2;
      const cx = Math.cos(th), sz = Math.sin(th);
      const x = cx * r, z = sz * r;
      // 前方（-Z）是山谷，两侧与后方山体更高
      const ahead = Math.max(0, -sz);
      const dirF = 1.0 - ahead * 0.55;
      const base = 70 + 520 * Math.pow(t, 0.85);
      // 脊线噪声按方位角采样（各圈频率一致），1-|2n-1| 产生尖锐山脊
      const u = th * 3.2, v = t * 4.0;
      const n1 = fbm(u + 3.1, v + 7.7, 4);
      const r1 = 1 - Math.abs(2 * n1 - 1);
      const n2 = fbm(u * 3.1 + 1.3, v * 2.0 + 4.2, 3);
      const r2 = 1 - Math.abs(2 * n2 - 1);
      const ridge = fbm(u * 0.5, v * 0.7, 3);
      let h = base * dirF * (0.2 + 0.8 * Math.pow(r1, 1.8) + 0.25 * r2 * r1) * (0.5 + ridge);
      // 内圈压低，藏在地形边缘之后
      h *= 0.35 + 0.65 * Math.min(1, t * 3);
      h += 20;
      heights.push(h);
      positions.push(x, h, z);
    }
  }
  const at = (j, i) => j * NA + ((i % NA) + NA) % NA;
  for (let j = 0; j < NR; j++) {
    for (let i = 0; i < NA; i++) {
      const a = at(j, i), b = at(j, i + 1), c = at(j + 1, i), d = at(j + 1, i + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal;
  const tmp = new THREE.Color();
  for (let v = 0; v < nrm.count; v++) {
    const ny = nrm.getY(v);
    const h = heights[v];
    const steep = 1 - THREE.MathUtils.smoothstep(ny, 0.5, 0.8);
    const alt = THREE.MathUtils.smoothstep(h, 120, 420);
    tmp.copy(rock).lerp(rockLit, 0.4).lerp(snow, THREE.MathUtils.clamp(1 - steep * (1 - alt * 0.45), 0, 1));
    colors.push(tmp.r, tmp.g, tmp.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  group.add(m);
  scene.add(group);
  return group;
}
