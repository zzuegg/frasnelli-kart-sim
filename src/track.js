import * as THREE from 'three';
import { GEO_TRACK_LENGTH, GEO_TRACK_POINTS, TERRAIN_DATA } from './generated/terrain-data.js';
import { RACING_LINE_POINTS } from './generated/racing-line-data.js';

export const TRACK_LENGTH_METERS = GEO_TRACK_LENGTH;
export const ROAD_WIDTH = 9;

function sampleGeoreferencedTrack() {
  return GEO_TRACK_POINTS.map(p => ({
    point: new THREE.Vector3(p.x, p.y, p.z),
    leftHeight: p.l,
    rightHeight: p.r,
  }));
}

function makeStrip(points, inner, outer, y, material, vertexColors = false) {
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n].point;
    const next = points[(i + 1) % n].point;
    const tangent = next.clone().sub(prev).setY(0).normalize();
    const right = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const a = points[i].point.clone().addScaledVector(right, inner);
    const b = points[i].point.clone().addScaledVector(right, outer);
    const half = ROAD_WIDTH * .5;
    const heightAtOffset = offset => {
      if (offset < 0) return THREE.MathUtils.lerp(points[i].point.y, points[i].leftHeight, Math.min(1, -offset / half));
      return THREE.MathUtils.lerp(points[i].point.y, points[i].rightHeight, Math.min(1, offset / half));
    };
    positions.push(a.x, heightAtOffset(inner) + y, a.z, b.x, heightAtOffset(outer) + y, b.z);
    uvs.push(0, i / 5, 1, i / 5);
    if (vertexColors) {
      const even = Math.floor((i / n) * TRACK_LENGTH_METERS / 4) % 2 === 0;
      const c = even ? new THREE.Color(0xe8e8e2) : new THREE.Color(0xd62f28);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = i * 2, b = a + 1, c = j * 2, d = c + 1;
    // Counter-clockwise from above: normals point upward and the road remains
    // visible with Three.js' default front-face culling.
    indices.push(a, b, c, b, d, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (vertexColors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export function createRacingLine(scene) {
  const positions = [];
  const colors = [];
  const indices = [];
  const width = .18;
  const colorFor = point => point.mode === 'brake'
    ? new THREE.Color(0xff3e36)
    : point.mode === 'accel' ? new THREE.Color(0x35ed72) : new THREE.Color(0xffc43d);

  for (let i = 0; i < RACING_LINE_POINTS.length; i++) {
    const previous = RACING_LINE_POINTS[(i - 2 + RACING_LINE_POINTS.length) % RACING_LINE_POINTS.length];
    const next = RACING_LINE_POINTS[(i + 2) % RACING_LINE_POINTS.length];
    const dx = next.x - previous.x;
    const dz = next.z - previous.z;
    const length = Math.hypot(dx, dz) || 1;
    const rightX = -dz / length;
    const rightZ = dx / length;
    const point = RACING_LINE_POINTS[i];
    const color = colorFor(point);
    positions.push(
      point.x - rightX * width, point.y, point.z - rightZ * width,
      point.x + rightX * width, point.y, point.z + rightZ * width,
    );
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }
  for (let i = 0; i < RACING_LINE_POINTS.length; i++) {
    const next = (i + 1) % RACING_LINE_POINTS.length;
    const a = i * 2, b = a + 1, c = next * 2, d = c + 1;
    indices.push(a, b, c, b, d, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  const line = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: .92,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
  }));
  line.renderOrder = 6;
  line.name = 'Fastest AI-driven racing line';
  scene.add(line);
  return line;
}

function makeRoadTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#343632'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = 35 + Math.random() * 45;
    ctx.fillStyle = `rgba(${v},${v},${v * .92},${.08 + Math.random() * .15})`;
    const s = Math.random() * 1.4;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.5, 120);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function makeGrassTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#315b29'; ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6000; i++) {
    const g = 65 + Math.random() * 55;
    ctx.fillStyle = `rgba(${22 + Math.random() * 20},${g},${20 + Math.random() * 20},.25)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1, 1 + Math.random() * 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(42, 28);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function buildBarrier(points, side, scene) {
  const curvePoints = points.map((entry, i) => {
    const prev = points[(i - 1 + points.length) % points.length].point;
    const next = points[(i + 1) % points.length].point;
    const tangent = next.clone().sub(prev).setY(0).normalize();
    const right = new THREE.Vector3(-tangent.z, 0, tangent.x);
    const point = entry.point.clone().addScaledVector(right, side * (ROAD_WIDTH * .5 + 1.35));
    point.y = terrainHeightAt(point.x, point.z) + .58;
    return point;
  });
  const curve = new THREE.CatmullRomCurve3(curvePoints, true, 'centripetal', .3);
  const rail = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 1000, .075, 4, true),
    new THREE.MeshStandardMaterial({ color: 0xd9ddd8, metalness: .72, roughness: .36 })
  );
  rail.castShadow = rail.receiveShadow = true;
  scene.add(rail);
}

function addStartGantry(group, start, heading) {
  const steel = new THREE.MeshStandardMaterial({ color: 0x1a1e1c, metalness: .65, roughness: .35 });
  const lime = new THREE.MeshStandardMaterial({ color: 0xaeea31, roughness: .55 });
  const gantry = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.BoxGeometry(ROAD_WIDTH + 3, .45, .45), steel);
  beam.position.y = 4.3;
  gantry.add(beam);
  for (const x of [-ROAD_WIDTH / 2 - 1.2, ROAD_WIDTH / 2 + 1.2]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(.3, 4.3, .3), steel);
    post.position.set(x, 2.15, 0); gantry.add(post);
  }
  const sign = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.05, .16), lime);
  sign.position.set(0, 4.28, .33); gantry.add(sign);
  const signText = createTextSprite('FRASNELLI', '#0b1208', 180, 40);
  signText.scale.set(3.8, .84, 1); signText.position.set(0, 4.28, .44); gantry.add(signText);
  gantry.position.copy(start); gantry.rotation.y = heading; group.add(gantry);
}

function createTextSprite(text, color, width = 256, height = 64) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = color; ctx.font = `700 ${Math.floor(height * .65)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2);
  const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false });
  return new THREE.Sprite(mat);
}

export function terrainHeightAt(x, z) {
  const data = TERRAIN_DATA;
  const px = (x - data.minX) / (data.maxX - data.minX) * (data.width - 1);
  const py = (data.maxZ - z) / (data.maxZ - data.minZ) * (data.height - 1);
  if (px < 0 || py < 0 || px >= data.width - 1 || py >= data.height - 1) return 0;
  const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
  const at = (cx, cy) => data.values[cy * data.width + cx];
  return at(x0,y0)*(1-tx)*(1-ty) + at(x0+1,y0)*tx*(1-ty) + at(x0,y0+1)*(1-tx)*ty + at(x0+1,y0+1)*tx*ty;
}

function createTerrainMesh() {
  const data = TERRAIN_DATA;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let row = 0; row < data.height; row++) {
    const z = data.maxZ - row / (data.height - 1) * (data.maxZ - data.minZ);
    for (let col = 0; col < data.width; col++) {
      const x = data.minX + col / (data.width - 1) * (data.maxX - data.minX);
      positions.push(x, data.values[row * data.width + col] - .06, z);
      uvs.push(col / (data.width - 1), row / (data.height - 1));
    }
  }
  for (let row = 0; row < data.height - 1; row++) {
    for (let col = 0; col < data.width - 1; col++) {
      const a = row * data.width + col, b = a + 1, c = a + data.width, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: makeGrassTexture(), color: 0x6d965d, roughness: 1 }));
  terrain.receiveShadow = true;
  return terrain;
}

function addEnvironment(scene, points) {
  scene.add(createTerrainMesh());

  const mountainMat = new THREE.MeshStandardMaterial({ color: 0x526959, roughness: 1, flatShading: true });
  const farMat = new THREE.MeshStandardMaterial({ color: 0x718078, roughness: 1, flatShading: true });
  for (let i = 0; i < 28; i++) {
    const angle = (i / 28) * Math.PI * 2;
    const radius = 270 + (i % 4) * 18;
    const h = 55 + (i * 29 % 70);
    const m = new THREE.Mesh(new THREE.ConeGeometry(38 + (i % 3) * 10, h, 7), i % 3 ? mountainMat : farMat);
    m.position.set(Math.cos(angle) * radius, h / 2 - 6, Math.sin(angle) * radius);
    m.rotation.y = angle * 1.7; m.receiveShadow = true; scene.add(m);
  }

  const buildingMat = new THREE.MeshStandardMaterial({ color: 0xd9ddd5, roughness: .8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x343a36, roughness: .7 });
  const building = new THREE.Mesh(new THREE.BoxGeometry(34, 6, 11), buildingMat);
  const buildingGround = terrainHeightAt(18, -118);
  building.position.set(18, buildingGround + 3, -118); building.castShadow = building.receiveShadow = true; scene.add(building);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(36, .7, 12), roofMat);
  roof.position.set(18, buildingGround + 6.25, -118); roof.castShadow = true; scene.add(roof);

  const treeTrunk = new THREE.CylinderGeometry(.18, .25, 1.8, 6);
  const treeTop = new THREE.ConeGeometry(1.3, 4.5, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x604734, roughness: 1 });
  const foliageMat = new THREE.MeshStandardMaterial({ color: 0x244f2b, roughness: 1 });
  const trunks = new THREE.InstancedMesh(treeTrunk, trunkMat, 75);
  const tops = new THREE.InstancedMesh(treeTop, foliageMat, 75);
  const matrix = new THREE.Matrix4();
  let placed = 0;
  for (let i = 0; i < 180 && placed < 75; i++) {
    const x = THREE.MathUtils.lerp(TERRAIN_DATA.minX, TERRAIN_DATA.maxX, Math.random());
    const z = THREE.MathUtils.lerp(TERRAIN_DATA.minZ, TERRAIN_DATA.maxZ, Math.random());
    let minDist = Infinity;
    for (let j = 0; j < points.length; j += 12) minDist = Math.min(minDist, points[j].point.distanceTo(new THREE.Vector3(x, 0, z)));
    if (minDist < 16) continue;
    const s = .8 + Math.random() * .8;
    const ground = terrainHeightAt(x, z);
    matrix.compose(new THREE.Vector3(x, ground + .9 * s, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)); trunks.setMatrixAt(placed, matrix);
    matrix.compose(new THREE.Vector3(x, ground + 3.4 * s, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.random()*6.28), new THREE.Vector3(s, s, s)); tops.setMatrixAt(placed, matrix);
    placed++;
  }
  trunks.count = tops.count = placed; trunks.castShadow = tops.castShadow = true; scene.add(trunks, tops);
}

export function createTrack(scene) {
  const points = sampleGeoreferencedTrack();
  const roadMat = new THREE.MeshStandardMaterial({ map: makeRoadTexture(), color: 0x8b8e88, roughness: .96, metalness: 0, side: THREE.DoubleSide });
  const road = makeStrip(points, -ROAD_WIDTH / 2, ROAD_WIDTH / 2, .03, roadMat);
  road.receiveShadow = true; scene.add(road);
  const curbMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .82, side: THREE.DoubleSide });
  const curbL = makeStrip(points, -ROAD_WIDTH / 2 - .6, -ROAD_WIDTH / 2, .065, curbMat, true);
  const curbR = makeStrip(points, ROAD_WIDTH / 2, ROAD_WIDTH / 2 + .6, .065, curbMat, true);
  curbL.receiveShadow = curbR.receiveShadow = true; scene.add(curbL, curbR);
  const racingLine = createRacingLine(scene);
  buildBarrier(points, -1, scene); buildBarrier(points, 1, scene);
  addEnvironment(scene, points);

  const startIndex = 0;
  const start = points[startIndex].point.clone();
  const startNext = points[(startIndex + 2) % points.length].point;
  const startPrev = points[(startIndex - 2 + points.length) % points.length].point;
  const startTangent = startNext.clone().sub(startPrev).normalize();
  // The kart's local forward axis is -Z, so +X remains screen-right in the
  // chase and cockpit cameras.
  const startHeading = Math.atan2(-startTangent.x, -startTangent.z);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .7 });
  const line = new THREE.Mesh(new THREE.BoxGeometry(ROAD_WIDTH, .025, .34), lineMat);
  line.position.copy(start); line.position.y += .075; line.rotation.y = startHeading; scene.add(line);
  addStartGantry(scene, start, startHeading);

  const trackData = new TrackData(points, startIndex, startHeading);
  trackData.racingLine = racingLine;
  return trackData;
}

export class TrackData {
  constructor(points, startIndex, startHeading) {
    this.samples = points;
    this.startIndex = startIndex;
    this.startHeading = startHeading;
    this.lastNearest = startIndex;
  }

  sample(index) {
    const n = this.samples.length;
    return this.samples[(index % n + n) % n].point;
  }

  tangent(index) {
    return this.sample(index + 2).clone().sub(this.sample(index - 2)).normalize();
  }

  resetPose() {
    const point = this.sample(this.startIndex).clone();
    return { point, heading: this.startHeading };
  }

  surfaceAt(position, hintIndex = this.lastNearest) {
    const n = this.samples.length;
    let best = hintIndex;
    let bestD2 = Infinity;
    for (let k = hintIndex - 16; k <= hintIndex + 16; k++) {
      const i = (k % n + n) % n;
      const p = this.samples[i].point;
      const dx = position.x - p.x;
      const dz = position.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    const point = this.sample(best);
    const tangent = this.tangent(best);
    const right = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const signedDistance = (position.x - point.x) * right.x + (position.z - point.z) * right.z;
    const half = ROAD_WIDTH * .5;
    const entry = this.samples[best];
    let height = Math.abs(signedDistance) <= half + .75
      ? signedDistance < 0
        ? THREE.MathUtils.lerp(point.y, entry.leftHeight, Math.min(1, -signedDistance / half))
        : THREE.MathUtils.lerp(point.y, entry.rightHeight, Math.min(1, signedDistance / half))
      : terrainHeightAt(position.x, position.z);
    const curbDepth = Math.abs(signedDistance) - half;
    let curbHeight = 0;
    if (curbDepth > 0 && curbDepth < .62) {
      const tangentOffset = (position.x - point.x) * tangent.x + (position.z - point.z) * tangent.z;
      const along = best / n * TRACK_LENGTH_METERS + tangentOffset;
      const innerRamp = clamp01(curbDepth / .075);
      const outerRamp = clamp01((.62 - curbDepth) / .09);
      const serration = .5 + .5 * Math.sin(along * Math.PI * 2 / 1.15);
      curbHeight = innerRamp * outerRamp * (.045 + .032 * serration);
      height += curbHeight;
    }
    return { height, index: best, signedDistance, curbHeight };
  }

  nearest(position, forceGlobal = false) {
    const n = this.samples.length;
    let best = this.lastNearest;
    let bestD2 = Infinity;
    const radius = forceGlobal ? n : 48;
    const start = forceGlobal ? 0 : this.lastNearest - radius;
    const end = forceGlobal ? n : this.lastNearest + radius;
    for (let k = start; k < end; k++) {
      const i = (k % n + n) % n;
      const p = this.samples[i].point;
      const dx = position.x - p.x, dz = position.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    this.lastNearest = best;
    const point = this.sample(best);
    const tangent = this.tangent(best);
    const right = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const offset = new THREE.Vector3(position.x - point.x, 0, position.z - point.z);
    const entry = this.samples[best];
    const signedDistance = offset.dot(right);
    const half = ROAD_WIDTH * .5;
    let surfaceHeight;
    if (Math.abs(signedDistance) <= half + .75) {
      surfaceHeight = signedDistance < 0
        ? THREE.MathUtils.lerp(point.y, entry.leftHeight, Math.min(1, -signedDistance / half))
        : THREE.MathUtils.lerp(point.y, entry.rightHeight, Math.min(1, signedDistance / half));
    } else {
      surfaceHeight = terrainHeightAt(position.x, position.z);
    }
    return {
      index: best,
      point,
      tangent,
      right,
      signedDistance,
      distance: Math.sqrt(bestD2),
      surfaceHeight,
      bankAngle: Math.atan2(entry.rightHeight - entry.leftHeight, ROAD_WIDTH),
      progress: ((best - this.startIndex + n) % n) / n,
    };
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
