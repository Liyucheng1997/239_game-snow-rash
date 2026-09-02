import * as THREE from 'three';
import { Terrain, groundY, groundNormal, SLOPE } from './terrain.js';
import { Player } from './player.js';
import { loadModels, ObstacleManager, Forest } from './obstacles.js';
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
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xdde6f1, 0.0011);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 3000);
camera.position.set(0, 8, 14);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 光照：低角度暖阳 + 蓝天/雪地半球光
const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.42).normalize();
const hemi = new THREE.HemisphereLight(0xb9d4f5, 0xf0f3f8, 0.85);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -55; sun.shadow.camera.right = 55;
sun.shadow.camera.top = 55; sun.shadow.camera.bottom = -55;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 260;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.12;
scene.add(sun, sun.target);

const sky = makeSky(scene, SUN_DIR);
const mountains = makeMountains(scene);
const terrain = new Terrain(scene, SUN_DIR);
const forest = new Forest(scene);
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
  pos: new THREE.Vector3(0, 0, 0),
  heading: 0,           // 0 = 正下坡(-Z)
  speed: 0,
  vy: 0,
  grounded: true,
  airTime: 0,
  score: 0,
  maxKmh: 0,
  crashT: 0,
  time: 0,
  steerCur: 0,
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
  G.steerCur = 0;

  if (G.player) scene.remove(G.player.root);
  G.player = new Player(scene, mode);

  if (G.obstacles) for (const it of G.obstacles.items) it.obj && scene.remove(it.obj);
  G.obstacles = new ObstacleManager(scene, G.models);
  for (let z = -60; z > -660; z -= 90) G.obstacles.populate(z, z - 90, difficulty(-z));

  for (const t of G.trails) scene.remove(t.mesh);
  G.trails = mode === 'ski'
    ? [new Trail(scene, 0.11), new Trail(scene, 0.11)]
    : [new Trail(scene, 0.3)];

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
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
function _tmp2Set(x, y, z) { return _tmp2.set(x, y, z); }

function headingDir(out) {
  return out.set(-Math.sin(G.heading), 0, -Math.cos(G.heading));
}

function updatePlaying(dt) {
  const P = MODE_PARAMS[G.mode];
  const steerIn = (keys['ArrowLeft'] || keys['KeyA'] ? 1 : 0) - (keys['ArrowRight'] || keys['KeyD'] ? 1 : 0);
  const brake = keys['ArrowDown'] || keys['KeyS'] ? 1 : 0;
  const tuck = keys['ShiftLeft'] || keys['ShiftRight'] ? 1 : 0;
  // 转向输入做少量平滑，避免姿态抽动
  G.steerCur += (steerIn - G.steerCur) * (1 - Math.exp(-14 * dt));
  const steer = Math.abs(G.steerCur) < 0.02 ? 0 : G.steerCur;

  headingDir(_dir);
  _side.set(-_dir.z, 0, _dir.x);

  const speed01 = Math.min(1, G.speed / 38);

  if (G.grounded) {
    const e = 0.7;
    const gx = (groundY(G.pos.x + e, G.pos.z) - groundY(G.pos.x - e, G.pos.z)) / (2 * e);
    const gz = (groundY(G.pos.x, G.pos.z + e) - groundY(G.pos.x, G.pos.z - e)) / (2 * e);
    let acc = -9.8 * (gx * _dir.x + gz * _dir.z);
    const d2 = tuck ? P.tuckDrag2 : P.drag2;
    acc -= 0.25 + d2 * G.speed * G.speed;
    if (brake) acc -= 9 + G.speed * 0.15;
    G.speed = Math.max(0, G.speed + acc * dt);
    if (G.speed < 2 && !brake) G.speed = Math.min(2, G.speed + 2 * dt);

    const turnEff = Math.min(1, G.speed / 9);
    G.heading += steerIn * P.turnRate * turnEff * dt;
    G.heading = THREE.MathUtils.clamp(G.heading, -1.25, 1.25);
    G.speed -= Math.abs(steerIn) * P.carveDrag * G.speed * 0.35 * dt;

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
      G.pos.y = gy;
      G.grounded = true;
      const impact = Math.min(1.6, 0.4 + G.airTime * 0.9);
      G.player.land(impact);
      spray.emit(_tmp.copy(G.pos), _tmp2Set(-_dir.x * 2, 2.5, -_dir.z * 2), Math.round(14 + impact * 14), 2.6, 0.7);
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
        spray.emit(_tmp.copy(it.obj.position), _tmp2Set(0, 3, 0), 8, 1.6, 0.4);
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
        spray.emit(_tmp.copy(G.pos), _tmp2Set(0, 4, 0), 16, 2.5, 0.7);
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
      const rear = _tmp.copy(G.pos).addScaledVector(_dir, -0.9).addScaledVector(_side, -steer * 0.3);
      rear.y = groundY(rear.x, rear.z) + 0.1;
      spray.emit(
        rear,
        _tmp2Set(_side.x * steer * 4.5 - _dir.x * 2, 1.8 + speed01 * 2.5, _side.z * steer * 4.5 - _dir.z * 2),
        Math.ceil(1 + speed01 * 3 + brake * 2),
        1.8 + speed01,
        0.34 + speed01 * 0.2
      );
    }
    const ws = 1 + carve * 0.8 + brake * 1.2;
    if (G.mode === 'ski') {
      const stance = brake ? 0.24 : 0.17;
      for (const [t, off] of [[G.trails[0], -stance], [G.trails[1], stance]]) {
        const c = _tmp.copy(G.pos).addScaledVector(_side, off);
        c.y = groundY(c.x, c.z);
        t.push(c, _side, ws);
      }
    } else {
      const c = _tmp.copy(G.pos);
      c.y = groundY(c.x, c.z);
      G.trails[0].push(c, _side, 0.6 + carve * 0.6 + brake * 1.5);
    }
  }

  // ---- 玩家姿态 ----
  const pl = G.player;
  pl.root.position.copy(G.pos);
  pl.root.rotation.y = G.heading;
  pl.update({
    steer, brake, tuck: !!tuck, air: !G.grounded, speed01,
    normal: G.grounded ? groundNormal(G.pos.x, G.pos.z, _n) : null,
    heading: G.heading, dt,
  });

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
  forest.update(G.pos.z);
  G.obstacles.cull(G.pos.z);
}

// ---------- 摄像机 ----------
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 10, 18);
let camRoll = 0;
function updateCamera(dt) {
  const speed01 = Math.min(1, G.speed / 38);
  headingDir(_dir);
  _side.set(-_dir.z, 0, _dir.x);
  if (G.state === 'playing' || G.state === 'crashed') {
    const back = G.state === 'crashed' ? 8 : 5.6 + speed01 * 2.2;
    _tmp.copy(G.pos).addScaledVector(_dir, -back).addScaledVector(_side, -G.steerCur * 0.8);
    _tmp.y = Math.max(G.pos.y + 2.3 + speed01 * 0.8, groundY(_tmp.x, _tmp.z) + 1.4);
    const k = 1 - Math.pow(0.0008, dt);
    camPos.lerp(_tmp, k);
    camera.position.copy(camPos);
    camTarget.lerp(_tmp.copy(G.pos).addScaledVector(_dir, 6).setY(G.pos.y + 1.1), k);
    camera.lookAt(camTarget);
    // 随转向轻微侧滚，强化压弯感
    const rollT = G.state === 'playing' ? -G.steerCur * 0.045 * (0.4 + speed01) : 0;
    camRoll += (rollT - camRoll) * (1 - Math.pow(0.01, dt));
    camera.rotateZ(camRoll);
    const fovT = 60 + speed01 * 17;
    camera.fov += (fovT - camera.fov) * (1 - Math.pow(0.001, dt));
    camera.updateProjectionMatrix();
  } else {
    const t = G.time * 0.12;
    camera.position.set(Math.sin(t) * 26, groundY(0, -30) + 9, -30 + Math.cos(t) * 26);
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
    G.speed = Math.max(0, G.speed - 18 * dt);
    headingDir(_dir);
    G.pos.addScaledVector(_dir, G.speed * dt);
    G.pos.y = groundY(G.pos.x, G.pos.z);
    G.player.root.position.copy(G.pos);
    G.player.tumble(Math.min(G.crashT, 1.0));
    if (G.crashT < 0.5) spray.emit(_tmp.copy(G.pos), _tmp2Set(0, 3, 2), 8, 2.8, 0.8);
  }

  // 环境跟随
  const anchorZ = G.state === 'menu' ? -40 : G.pos.z;
  sky.position.copy(camera.position);
  sky.material.uniforms.uTime.value = G.time;
  mountains.position.set(0, anchorZ * SLOPE - 30, anchorZ);
  snowfall.update(camera.position, dt, G.time);
  spray.update(dt);
  for (const t of G.trails) t.fade(dt);
  if (G.obstacles) G.obstacles.animate(G.time);

  // 太阳光跟随玩家保证阴影
  const lx = G.state === 'menu' ? 0 : G.pos.x;
  const ly = G.state === 'menu' ? groundY(0, -40) : G.pos.y;
  sun.position.set(lx + SUN_DIR.x * 90, ly + SUN_DIR.y * 90, anchorZ - 12 + SUN_DIR.z * 90);
  sun.target.position.set(lx, ly, anchorZ - 12);

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

window.__game = { renderer, scene, camera, G, startGame, step, keys };
