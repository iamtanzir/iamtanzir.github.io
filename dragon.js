import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// ========================================
// RED DRAGON FLIGHT ENGINE (no build step — CDN importmap)
// ========================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101827);
scene.fog = new THREE.Fog(0x101827, 25, 100);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 4, 12);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.domElement.id = "scene";
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);
controls.maxDistance = 35;
controls.minDistance = 3;

// ========================================
// LIGHTING + GROUND
// ========================================

scene.add(new THREE.HemisphereLight(0x9bbcff, 0x321010, 2));

const sunlight = new THREE.DirectionalLight(0xffffff, 3);
sunlight.position.set(10, 15, 10);
sunlight.castShadow = true;
sunlight.shadow.mapSize.set(1024, 1024);
scene.add(sunlight);

const redLight = new THREE.PointLight(0xff2200, 30, 22);
redLight.position.set(0, 2, 2);
scene.add(redLight);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(500, 500),
  new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -12;
ground.receiveShadow = true;
scene.add(ground);

// ========================================
// DRAGON MODEL (assets/dragon.glb — sculptly output, head along +X, rotated to face +Z)
// ========================================

const dragon = new THREE.Group();
scene.add(dragon);

let dragonLoaded = false;

const MODEL_FORWARD_YAW = -Math.PI / 2; // GLB head is +X; -90° maps +X -> +Z
// mouth position in model-local coordinates (head side, slightly above center)
const MOUTH_LOCAL = new THREE.Vector3(0.46, 0.12, 0);

new GLTFLoader().load(
  "assets/dragon.glb",
  (gltf) => {
    const model = gltf.scene;

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    model.position.sub(center);
    const maxDimension = Math.max(size.x, size.y, size.z);
    model.scale.setScalar(3.5 / maxDimension);
    model.rotation.y = MODEL_FORWARD_YAW;

    model.traverse((object) => {
      if (object.isMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

    dragon.add(model);
    dragon.position.set(0, 2, 0);

    dragonLoaded = true;
  },
  undefined,
  (error) => {
    console.error("Dragon loading failed:", error);
    const hud = document.querySelector(".hud");
    if (hud) hud.innerHTML = "<b>🐉 DRAGON FAILED TO LOAD</b><br>" + String(error).slice(0, 120);
  }
);

// mouth + forward in world space (account for the parent group's rotation)
const MOUTH_WORLD = new THREE.Vector3();
const FWD = new THREE.Vector3();
const TMP = new THREE.Vector3();

function mouthWorld() {
  // model was rotated -90° about Y, so local +X maps to world +Z inside the dragon group.
  // apply the model's own matrixWorld for accuracy.
  const model = dragon.children[0];
  if (!model) return MOUTH_WORLD.set(0, 2, 0);
  MOUTH_WORLD.copy(MOUTH_LOCAL).applyMatrix4(model.matrixWorld);
  return MOUTH_WORLD;
}

function forwardWorld() {
  FWD.set(0, 0, 1).applyQuaternion(dragon.quaternion).normalize();
  return FWD;
}

// ========================================
// FLIGHT CONTROLLER (keyboard)
// ========================================

const keys = {};
let fireBreath = false;

window.addEventListener("keydown", (event) => {
  keys[event.code] = true;
  if (event.code === "Space") {
    event.preventDefault();
    fireBreath = true;
  }
});
window.addEventListener("keyup", (event) => {
  keys[event.code] = false;
  if (event.code === "Space") {
    fireBreath = false;
  }
});

let speed = 0;
let flightTime = 0;

function updateFlight(delta, elapsed) {
  if (!dragonLoaded) return;

  const acceleration = 8;
  const maxSpeed = 12;

  if (keys["KeyW"] || keys["ArrowUp"]) {
    speed = Math.min(speed + acceleration * delta, maxSpeed);
  } else if (keys["KeyS"] || keys["ArrowDown"]) {
    speed = Math.max(speed - acceleration * delta, -maxSpeed);
  } else {
    speed *= Math.pow(0.95, delta * 60);
  }

  const turn = 1.8;
  if (keys["KeyA"] || keys["ArrowLeft"]) dragon.rotation.y += turn * delta;
  if (keys["KeyD"] || keys["ArrowRight"]) dragon.rotation.y -= turn * delta;

  let vertical = 0;
  if (keys["KeyQ"]) vertical = 1;
  if (keys["KeyE"]) vertical = -1;
  dragon.position.y += vertical * 6 * delta;

  TMP.set(0, 0, 1).applyQuaternion(dragon.quaternion);
  dragon.position.addScaledVector(TMP, speed * delta);

  flightTime += delta;
  const flying = Math.abs(speed) > 0.5;
  dragon.position.y += Math.sin(elapsed * 2.5) * 0.008;

  // banking into turns
  let targetBank = 0;
  if (keys["KeyA"] || keys["ArrowLeft"]) targetBank = 0.35;
  if (keys["KeyD"] || keys["ArrowRight"]) targetBank = -0.35;
  dragon.rotation.z = THREE.MathUtils.lerp(dragon.rotation.z, targetBank, delta * 3);

  // slight pitch while flying
  dragon.rotation.x = THREE.MathUtils.lerp(dragon.rotation.x, flying ? -0.05 : 0, delta * 2);
}

// ========================================
// FIRE BREATH (pooled glowing particles)
// ========================================

const FIRE_MAX = 150;
const fireParticles = [];
const firePool = [];
const fireGeometry = new THREE.SphereGeometry(0.085, 6, 6);
const fireColors = [0xff2200, 0xff6600, 0xffaa00, 0xffff66];
const fireMaterials = fireColors.map(
  (color) => new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
);
const fireLight = new THREE.PointLight(0xff3300, 0, 15);
scene.add(fireLight);

let lastFireTime = 0;

function spawnFire() {
  if (!dragonLoaded) return;

  let particle = firePool.pop();
  if (!particle) {
    particle = new THREE.Mesh(fireGeometry, fireMaterials[(Math.random() * fireMaterials.length) | 0]);
  } else {
    particle.material = fireMaterials[(Math.random() * fireMaterials.length) | 0];
  }

  const mouth = mouthWorld();
  particle.position.copy(mouth);

  const spread = 0.25;
  const v = forwardWorld().multiplyScalar(10 + Math.random() * 8);
  v.x += (Math.random() - 0.5) * spread;
  v.y += (Math.random() - 0.5) * spread;
  v.z += (Math.random() - 0.5) * spread;

  particle.userData.velocity = v;
  particle.userData.life = 0.8 + Math.random() * 0.5;
  particle.userData.maxLife = particle.userData.life;
  particle.scale.setScalar(0.5 + Math.random() * 1.2);

  scene.add(particle);
  fireParticles.push(particle);
}

function updateFire(delta, elapsed) {
  if (fireBreath && elapsed - lastFireTime > 0.02 && fireParticles.length < FIRE_MAX) {
    for (let i = 0; i < 3; i++) spawnFire();
    lastFireTime = elapsed;
  }

  fireLight.intensity = fireBreath ? 25 : 0;
  if (dragonLoaded) {
    fireLight.position.copy(mouthWorld());
  }

  for (let i = fireParticles.length - 1; i >= 0; i--) {
    const particle = fireParticles[i];
    particle.userData.life -= delta;
    particle.position.addScaledVector(particle.userData.velocity, delta);
    const t = Math.max(0, particle.userData.life / particle.userData.maxLife);
    particle.scale.setScalar(Math.max(0.01, t) * (0.5 + 1.2 * (1 - t)));
    particle.material.opacity = t;

    if (particle.userData.life <= 0) {
      scene.remove(particle);
      fireParticles.splice(i, 1);
      firePool.push(particle);
    }
  }
}

// ========================================
// CAMERA FOLLOW (third person behind the dragon, mouse orbit via OrbitControls)
// ========================================

const cameraOffset = new THREE.Vector3(0, 4, -10);
const desiredCamera = new THREE.Vector3();

function updateCamera(delta) {
  if (!dragonLoaded) return;

  desiredCamera.copy(cameraOffset).applyQuaternion(dragon.quaternion).add(dragon.position);
  camera.position.lerp(desiredCamera, 1 - Math.exp(-2 * delta));

  controls.target.lerp(dragon.position, 1 - Math.exp(-3 * delta));
}

// ========================================
// MAIN LOOP
// ========================================

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(clock.getDelta(), 0.05);
  const elapsed = clock.elapsedTime;

  updateFlight(delta, elapsed);
  updateFire(delta, elapsed);
  updateCamera(delta);

  controls.update();
  renderer.render(scene, camera);
}

animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
