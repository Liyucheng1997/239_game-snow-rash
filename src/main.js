import * as THREE from 'three';
import { Terrain, groundY, groundNormal } from './terrain.js';
import { Player } from './player.js';
import { loadModels, ObstacleManager } from './obstacles.js';
import { Snowfall, SnowSpray, Trail, makeSky, makeMountains } from './effects.js';
import { GameAudio } from './audio.js';

// ---------- 基础场景 ----------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd6e2ef, 70, 430);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(0, 8, 14);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 光照
const hemi = new THREE.HemisphereLight(0xbdd6f5, 0xe8ecf5, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 260;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.15;
scene.add(sun, sun.target);

const sky = makeSky(scene);
const mountains = makeMountains(scene);
const terrain = new Terrain(scene);
const snowfall = new Snowfall(scene);
const spray = new SnowSpray(scene);
const audio = new GameAudio();

// ---------- UI 引用 ----------
const $ = (id) => document.getElementById(id);
const ui = {
  menu: $('menu'), gameover: $('gameover'), hud: $('hud'), loading: $('loading'),
  dist: $('hudDist'), score: $('hudScore'), speed: $('hudSpeed'), arc: $('speedArc'),
  toast: $('toast'), combo: $('combo'),
  goDist: $('goDist'), goScore: $('goScore'), goMax: $('goMax'),
  goTitle: $('goTitle'), newBest: $('newBest'), mute: $('muteBtn'),
};

// ---------- 游戏状态 ----------
const G = {
  state: 'menu',        // menu | playing | crashed
  mode: 'ski',
  models: null,
  player: null,
  obstacles: null,
  trails: [],
  // 物理
  pos: new THREE.Vector3(0, 0, 0),
  heading: 0,           // 0 = 正下坡(-Z)
  speed: 0,
  vy: 0,
  grounded: true,
  airTime: 0,
  // 计分
  score: 0,
  maxKmh: 0,
  crashT: 0,
  time: 0,
};

const MODE_PARAMS = {
  ski:   { turnRate: 1.7, carveDrag: 0.20, drag2: 0.0022, tuckDrag2: 0.0012, label: '双板' },
  board: { turnRate: 2.5, carveDrag: 0.30, drag2: 0.0028, tuckDrag2: 0.0017, label: '单板' },
};

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyR' && (G.state === 'crashed' || G.state === 'playing')) startGame(G.mode);
  if (e.code === 'KeyM') toggleMute();
});
window.addEventListener('keyup', (e) => (keys[e.code] = false));
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

function toggleMute() {
  audio.setMuted(!audio.muted);
  ui.mute.textContent = audio.muted ? '🔇' : '🔊';
}
ui.mute.addEventListener('click', toggleMute);

let toastTimer = 0;
function toast(text, color = '#ffe066') {
  ui.toast.textContent = text;
  ui.toast.style.color = color;
  ui.toast.classList.add('pop');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('pop'), 900);
}

// ---------- 开始 / 重开 ----------
function startGame(mode) {
  G.mode = mode;
  G.state = 'playing';
  G.pos.set(0, groundY(0, 0), 0);
  G.heading = 0;
  G.speed = 4;
  G.vy = 0;
  G.grounded = true;
  G.airTime = 0;
  G.score = 0;
  G.maxKmh = 0;
  G.crashT = 0;

  if (G.player) scene.remove(G.player.root);
  G.player = new Player(scene, mode);

  if (G.obstacles) for (const it of G.obstacles.items) it.obj && scene.remove(it.obj);
  G.obstacles = new ObstacleManager(scene, G.models);
  // 初始地形铺障碍（起点前 60m 留出安全区）
  for (let z = -60; z > -660; z -= 90) G.obstacles.populate(z, z - 90, difficulty(-z));

  for (const t of G.trails) scene.remove(t.mesh);
  G.trails = mode === 'ski'
    ? [new Trail(scene, 0.1), new Trail(scene, 0.1)]
    : [new Trail(scene, 0.32)];

  ui.menu.classList.add('hidden');
  ui.gameover.classList.add('hidden');
  ui.hud.classList.add('on');
  ui.newBest.style.display = 'none';
  audio.resume();
}

function difficulty(dist) {
  return Math.min(1, dist / 2600);
}

function endGame() {
  G.state = 'crashed';
  G.crashT = 0;
  audio.crash();
  audio.updateLoops(0, 0);
  const dist = Math.floor(-G.pos.z);
  const finalScore = G.score + Math.floor(dist / 10);
  ui.goDist.textContent = `${dist} m`;
  ui.goScore.textContent = finalScore;
  ui.goMax.textContent = `${Math.round(G.maxKmh)} km/h`;
  const bestKey = 'skiBest';
  const best = Number(localStorage.getItem(bestKey) || 0);
  if (finalScore > best) {
    localStorage.setItem(bestKey, String(finalScore));
    ui.newBest.style.display = 'block';
  }
  setTimeout(() => ui.gameover.classList.remove('hidden'), 1100);
}

$('pickSki').addEventListener('click', () => G.models && startGame('ski'));
$('pickBoard').addEventListener('click', () => G.models && startGame('board'));
$('btnRetry').addEventListener('click', () => startGame(G.mode));
$('btnMenu').addEventListener('click', () => {
  ui.gameover.classList.add('hidden');
  ui.hud.classList.remove('on');
  ui.menu.classList.remove('hidden');
  G.state = 'menu';
});

// ---------- 物理更新 ----------
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nLocal = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

function headingDir(out) {
  return out.set(-Math.sin(G.heading), 0, -Math.cos(G.heading));
}

function updatePlaying(dt) {
  const P = MODE_PARAMS[G.mode];
  const steer = (keys['ArrowLeft'] || keys['KeyA'] ? 1 : 0) - (keys['ArrowRight'] || keys['KeyD'] ? 1 : 0);
  const brake = keys['ArrowDown'] || keys['KeyS'] ? 1 : 0;
  const tuck = keys['ShiftLeft'] || keys['ShiftRight'] ? 1 : 0;

  headingDir(_dir);
  _side.set(-_dir.z, 0, _dir.x);

  const speed01 = Math.min(1, G.speed / 38);

  if (G.grounded) {
    // 沿坡度的重力分量（投影到航向）
    const e = 0.7;
    const gx = (groundY(G.pos.x + e, G.pos.z) - groundY(G.pos.x - e, G.pos.z)) / (2 * e);
    const gz = (groundY(G.pos.x, G.pos.z + e) - groundY(G.pos.x, G.pos.z - e)) / (2 * e);
    let acc = -9.8 * (gx * _dir.x + gz * _dir.z);
    // 阻力
    const d2 = tuck ? P.tuckDrag2 : P.drag2;
    acc -= 0.25 + d2 * G.speed * G.speed;
    if (brake) acc -= 9 + G.speed * 0.15;
    G.speed = Math.max(0, G.speed + acc * dt);
    if (G.speed < 2 && !brake) G.speed = Math.min(2, G.speed + 2 * dt); // 起步推一把

    // 转向（速度越快转向响应越足，同时刻滑损耗速度）
    const turnEff = Math.min(1, G.speed / 9);
    G.heading += steer * P.turnRate * turnEff * dt;
    G.heading = THREE.MathUtils.clamp(G.heading, -1.25, 1.25);
    G.speed -= Math.abs(steer) * P.carveDrag * G.speed * 0.35 * dt;

    // 跳跃
    if (keys['Space']) {
      G.vy = 5.2 + G.speed * 0.07;
      G.grounded = false;
      G.airTime = 0;
      audio.whoosh();
      keys['Space'] = false;
    }
  } else {
    G.vy -= 13 * dt;
    G.airTime += dt;
  }

  // 位移
  headingDir(_dir);
  G.pos.x += _dir.x * G.speed * dt;
  G.pos.z += _dir.z * G.speed * dt;
  G.pos.x = THREE.MathUtils.clamp(G.pos.x, -100, 100);

  const gy = groundY(G.pos.x, G.pos.z);
  if (G.grounded) {
    G.pos.y = gy;
  } else {
    G.pos.y += G.vy * dt;
    if (G.pos.y <= gy) {
      // 落地
      G.pos.y = gy;
      G.grounded = true;
      spray.emit(_tmp.copy(G.pos), _tmp2Set(-_dir.x * 2, 2.5, -_dir.z * 2), 20, 2.4);
      if (G.airTime > 0.6) {
        const bonus = Math.round(G.airTime * 120);
        G.score += bonus;
        toast(`滞空 ${G.airTime.toFixed(1)}s  +${bonus}`, '#aef3ff');
        audio.ding();
      }
      G.vy = 0;
    }
  }

  // ---- 碰撞 / 拾取 ----
  const heightAbove = G.pos.y - gy;
  for (let i = G.obstacles.items.length - 1; i >= 0; i--) {
    const it = G.obstacles.items[i];
    if (it.z > G.pos.z + 6 || it.z < G.pos.z - 60) continue;
    const dx = it.x - G.pos.x, dz = it.z - G.pos.z;
    const d2 = dx * dx + dz * dz;
    if (it.kind === 'gate') {
      if (!it.passed && G.pos.z < it.z) {
        it.passed = true;
        if (Math.abs(G.pos.x - it.x) < it.r) {
          G.score += 100;
          toast('穿过旗门 +100');
          audio.gateChime();
        } else {
          toast('错过旗门', '#9db8dc');
        }
      }
      continue;
    }
    if (it.kind === 'flake') {
      if (d2 < it.r * it.r && heightAbove < 3) {
        G.score += 10;
        audio.ding();
        spray.emit(_tmp.copy(it.obj.position), _tmp2Set(0, 3, 0), 8, 1.6);
        scene.remove(it.obj);
        G.obstacles.items.splice(i, 1);
      }
      continue;
    }
    if (it.kind === 'ramp') {
      const rr = it.r;
      if (G.grounded && d2 < rr * rr) {
        G.vy = 6 + G.speed * 0.1;
        G.grounded = false;
        G.airTime = 0;
        audio.whoosh();
        spray.emit(_tmp.copy(G.pos), _tmp2Set(0, 4, 0), 16, 2.5);
      }
      continue;
    }
    if (it.kind === 'crash') {
      const rr = it.r + 0.45;
      if (d2 < rr * rr && heightAbove < it.h) {
        endGame();
        return;
      }
    }
  }

  // ---- 喷雪 / 尾迹 ----
  if (G.grounded && G.speed > 3) {
    const carve = Math.abs(steer);
    if (carve > 0.3 || brake) {
      const rear = _tmp.copy(G.pos).addScaledVector(_dir, -0.9);
      rear.y = groundY(rear.x, rear.z) + 0.1;
      spray.emit(
        rear,
        _tmp2Set(_side.x * steer * 4 - _dir.x * 2, 2 + speed01 * 2, _side.z * steer * 4 - _dir.z * 2),
        Math.ceil(1 + speed01 * 3 + brake * 2),
        1.8
      );
    }
    // 尾迹
    if (G.mode === 'ski') {
      for (const [t, off] of [[G.trails[0], -0.15], [G.trails[1], 0.15]]) {
        const c = _tmp.copy(G.pos).addScaledVector(_side, off);
        c.y = groundY(c.x, c.z);
        t.push(c, _side);
      }
    } else {
      const c = _tmp.copy(G.pos);
      c.y = groundY(c.x, c.z);
      G.trails[0].push(c, _side);
    }
  }

  // ---- 玩家姿态 ----
  const pl = G.player;
  pl.root.position.copy(G.pos);
  pl.root.rotation.y = G.heading;
  if (G.grounded) {
    groundNormal(G.pos.x, G.pos.z, _n);
    _nLocal.copy(_n).applyAxisAngle(_up, -G.heading);
    _q.setFromUnitVectors(_up, _nLocal);
    pl.tilt.quaternion.slerp(_q, 1 - Math.pow(0.0005, dt));
  } else {
    _q.identity();
    pl.tilt.quaternion.slerp(_q, 1 - Math.pow(0.01, dt));
  }
  pl.pose(steer, tuck ? 1 : brake ? 0.35 : 0.12, !G.grounded, speed01, dt);

  // ---- 计分与 HUD ----
  const kmh = G.speed * 3.6;
  G.maxKmh = Math.max(G.maxKmh, kmh);
  ui.dist.textContent = Math.floor(-G.pos.z);
  ui.score.textContent = G.score + Math.floor(-G.pos.z / 10);
  ui.speed.textContent = Math.round(kmh);
  const frac = Math.min(1, kmh / 140);
  ui.arc.style.strokeDashoffset = String(326.7 * (1 - frac));
  ui.arc.style.stroke = frac > 0.75 ? '#ff8a5c' : '#6fd0ff';

  audio.updateLoops(speed01, G.grounded ? Math.abs(steer) * 0.8 + brake * 0.6 : 0);

  // ---- 世界流转 ----
  const fresh = terrain.update(G.pos.z);
  if (fresh) G.obstacles.populate(fresh.zTop, fresh.zBottom, difficulty(-G.pos.z));
  G.obstacles.cull(G.pos.z);
}

const _tmp2 = new THREE.Vector3();
function _tmp2Set(x, y, z) { return _tmp2.set(x, y, z); }

// ---------- 摄像机 ----------
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 10, 18);
function updateCamera(dt) {
  const speed01 = Math.min(1, G.speed / 38);
  headingDir(_dir);
  if (G.state === 'playing' || G.state === 'crashed') {
    const back = G.state === 'crashed' ? 10 : 8.2 + speed01 * 2.2;
    _tmp.copy(G.pos).addScaledVector(_dir, -back);
    _tmp.y = Math.max(G.pos.y + 3.2 + speed01 * 0.8, groundY(_tmp.x, _tmp.z) + 1.6);
    const k = 1 - Math.pow(0.0008, dt);
    camPos.lerp(_tmp, k);
    camera.position.copy(camPos);
    camTarget.lerp(_tmp.copy(G.pos).addScaledVector(_dir, 6).setY(G.pos.y + 1.2), k);
    camera.lookAt(camTarget);
    const fovT = 62 + speed01 * 16;
    camera.fov += (fovT - camera.fov) * (1 - Math.pow(0.001, dt));
    camera.updateProjectionMatrix();
  } else {
    // 菜单：环绕镜头
    const t = G.time * 0.12;
    camera.position.set(Math.sin(t) * 26, groundY(0, -30) + 10, -30 + Math.cos(t) * 26);
    camera.lookAt(0, groundY(0, -45) + 4, -45);
  }
}

// ---------- 主循环 ----------
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  step(Math.min(clock.getDelta(), 0.05));
}

function step(dt) {
  G.time += dt;

  if (G.state === 'playing') {
    updatePlaying(dt);
  } else if (G.state === 'crashed') {
    G.crashT += dt;
    // 摔倒滑行减速 + 翻滚
    G.speed = Math.max(0, G.speed - 18 * dt);
    headingDir(_dir);
    G.pos.addScaledVector(_dir, G.speed * dt);
    G.pos.y = groundY(G.pos.x, G.pos.z);
    G.player.root.position.copy(G.pos);
    G.player.tumble(Math.min(G.crashT, 1.0));
    if (G.crashT < 0.5) spray.emit(_tmp.copy(G.pos), _tmp2Set(0, 3, 2), 6, 2.5);
  }

  // 环境跟随
  const anchorZ = G.state === 'menu' ? -40 : G.pos.z;
  sky.position.set(camera.position.x, camera.position.y, camera.position.z);
  mountains.position.set(0, anchorZ * 0.3 /* 与坡度同步下降 */, anchorZ);
  snowfall.update(camera.position, dt, G.time);
  spray.update(dt);
  for (const t of G.trails) t.fade(dt);
  if (G.obstacles) G.obstacles.animate(G.time);

  // 太阳光跟随玩家保证阴影
  const lx = G.state === 'menu' ? 0 : G.pos.x;
  sun.position.set(lx + 45, (G.state === 'menu' ? groundY(0, -40) : G.pos.y) + 60, anchorZ + 35);
  sun.target.position.set(lx, G.state === 'menu' ? groundY(0, -40) : G.pos.y, anchorZ - 10);

  updateCamera(dt);
  renderer.render(scene, camera);
}

// ---------- 启动 ----------
loadModels()
  .then((models) => {
    G.models = models;
    ui.loading.textContent = '选择你的装备开始滑行';
  })
  .catch((err) => {
    console.error(err);
    ui.loading.textContent = '模型加载失败，请刷新重试';
  });

loop();

// 调试钩子（开发环境手动步进/检查）
window.__game = { renderer, scene, camera, G, startGame, step, keys };
