// App module: BIN parsing and THREE.js rendering
// Uses global JSZip (included in bin.html via script tag)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';


export const AppState = {
  model: null,
  selectedTextures: {},
  threeScene: null,
  threeCamera: null,
  threeRenderer: null,
  threeMesh: null,
  boundingBox: null,
  materials: [],
  vhotMarkers: [],
  controls: null,
  rafId: null,
  textureLoader: null,
  uiBound: false,
};

export function handleResize() {
  if (AppState.threeRenderer && AppState.threeCamera) {
    const viewer = document.getElementById("viewer");
    if (!viewer) return;
    const width = viewer.clientWidth;
    const height = viewer.clientHeight;

    AppState.threeCamera.aspect = width / height;
    AppState.threeCamera.updateProjectionMatrix();
    AppState.threeRenderer.setSize(width, height);
  }
}

export function handleFileInput(e) {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const model = read_bin(event.target.result);
      if (model) {
        AppState.model = model;
        console.log('Loaded model:', model);
        const geoms = toThree(model);
        setupThree(geoms);
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

export function handleTextureInput(e) {
  loadTextures(e.target.files);
}

export async function loadModelWithTextures(model, textures) {
  if (!model) return;

  AppState.model = model;
  AppState.selectedTextures = textures || {};
  console.log('Loading model with textures:', model);
  const geoms = toThree(model);
  setupThree(geoms);
}

export async function handleZipInput(e) {
  const file = e.target.files[0];
  if (file) {
    await loadZipFile(file);
  }
}

// Loads a BIN + textures from a zip.
// If desiredBinRelativePath is provided (e.g., "model.bin" or "obj/model.bin"), that BIN is used.
// Otherwise, search in root first, then obj/.
// Textures are expected in txt/ and txt16/ under the same base path as the BIN.
export async function loadZipFile(zipFile, desiredBinRelativePath = null) {
  try {
    const JSZip = globalThis.JSZip; 
    if (!JSZip) throw new Error('JSZip not available');

    const zip = new JSZip();
    const zipData = await zip.loadAsync(zipFile);

    let binFile = null;
    let basePath = '';

    if (desiredBinRelativePath) {
      const normalized = desiredBinRelativePath.replace(/^\/+/, '');
      const entry = zipData.files[normalized];
      if (entry && !entry.dir) {
        binFile = await entry.async('arraybuffer');
        const parts = normalized.split('/');
        basePath = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
      }
    }

    // If still not found, search for .bin file in root first
    if (!binFile) {
      for (const filename in zipData.files) {
        if (!zipData.files[filename].dir && filename.endsWith('.bin') && !filename.includes('/')) {
          binFile = await zipData.files[filename].async('arraybuffer');
          basePath = '';
          break;
        }
      }
    }

    // If not in root, search in 'obj/' directory
    if (!binFile) {
      for (const filename in zipData.files) {
        if (!zipData.files[filename].dir && filename.startsWith('obj/') && filename.endsWith('.bin')) {
          const pathParts = filename.split('/');
          if (pathParts.length === 2) { // e.g., "obj/model.bin"
            binFile = await zipData.files[filename].async('arraybuffer');
            basePath = 'obj/';
            break;
          }
        }
      }
    }

    if (!binFile) {
      console.log('No .bin file found in zip root or obj/ directory');
      return;
    }

    const textureFiles = {};
    const textureDir1 = `${basePath}txt/`;
    const textureDir2 = `${basePath}txt16/`;
    for (const filename in zipData.files) {
      const file = zipData.files[filename];
      if (!file.dir && (filename.startsWith(textureDir1) || filename.startsWith(textureDir2))) {
        const blob = await file.async('blob');
        const name = filename.split('/').pop(); // Get just the filename
        textureFiles[name] = new File([blob], name);
      }
    }

    const model = read_bin(binFile);
    if (model) {
      AppState.model = model;
      AppState.selectedTextures = textureFiles;
      console.log('Loaded model from zip:', model);
      const geoms = toThree(model);
      setupThree(geoms);
    }

    console.log(`Loaded zip with ${Object.keys(textureFiles).length} textures`);
  } catch (error) {
    console.error('Error loading zip file:', error);
  }
}

function loadTextures(files) {
  AppState.selectedTextures = {};
  for (let file of files) {
    AppState.selectedTextures[file.name] = file;
  }

  if (AppState.model) {
    const geoms = toThree(AppState.model);
    setupThree(geoms);
  }
}

function findTextureFile(textureName) {
  if (!textureName) return null;
  const nameWithoutExt = textureName.split('.')[0].toLowerCase();
  for (let [filename, file] of Object.entries(AppState.selectedTextures)) {
    const fileWithoutExt = filename.split('.')[0].toLowerCase();
    if (fileWithoutExt === nameWithoutExt) {
      return file;
    }
  }
  return null;
}

function teardownThree() {
  // Cancel animation loop
  if (AppState.rafId) {
    cancelAnimationFrame(AppState.rafId);
    AppState.rafId = null;
  }

  // Dispose controls
  if (AppState.controls) {
    AppState.controls.dispose();
    AppState.controls = null;
  }

  // Dispose scene contents (geometries/materials/textures)
  const disposeMaterial = (mat) => {
    if (!mat) return;
    if (mat.map) { mat.map.dispose?.(); }
    mat.dispose?.();
  };
  const disposeObject = (obj) => {
    if (!obj) return;
    if (obj.geometry) obj.geometry.dispose?.();
    if (Array.isArray(obj.material)) obj.material.forEach(disposeMaterial);
    else disposeMaterial(obj.material);
    if (obj.children) obj.children.forEach(disposeObject);
  };
  if (AppState.threeScene) {
    AppState.threeScene.traverse((obj) => {
      if (obj.isMesh || obj.isLine || obj.isPoints) disposeObject(obj);
    });
    // Remove all from scene
    while (AppState.threeScene.children.length) {
      AppState.threeScene.remove(AppState.threeScene.children[0]);
    }
  }

  // Dispose renderer and remove canvas
  if (AppState.threeRenderer) {
    const canvas = AppState.threeRenderer.domElement;
    AppState.threeRenderer.dispose();
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    AppState.threeRenderer = null;
  }

  // Reset state
  AppState.materials = [];
  AppState.vhotMarkers = [];
  AppState.boundingBox = null;
}

function initUI() {
  if (AppState.uiBound) return;
  const bboxToggle = document.getElementById('toggle-bbox');
  if (bboxToggle) {
    bboxToggle.addEventListener('change', function () {
      if (AppState.boundingBox) {
        AppState.boundingBox.visible = bboxToggle.checked;
      }
    });
  }

  const vhotToggle = document.getElementById('toggle-vhots');
  if (vhotToggle) {
    vhotToggle.addEventListener('change', function () {
      AppState.vhotMarkers.forEach(marker => {
        if (marker) marker.visible = vhotToggle.checked;
      });
    });
  }
  AppState.uiBound = true;
}

function setupThree(geometriesPerObject) {
  // Clean up any previous scene/renderer/resources
  teardownThree();
  if (AppState.threeRenderer && AppState.threeRenderer.domElement.parentNode) {
    AppState.threeRenderer.domElement.parentNode.removeChild(AppState.threeRenderer.domElement);
  }

  AppState.threeScene = new THREE.Scene();
  AppState.threeScene.background = new THREE.Color(0xf0f0f0);

  const viewer = document.getElementById("viewer");
  const width = viewer?.clientWidth || 800;
  const height = viewer?.clientHeight || 600;
  AppState.threeCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  AppState.threeCamera.position.set(0, 5, 12);
  AppState.threeCamera.lookAt(0, 0, 0);

  // Try to load textures for each material
  AppState.materials = [];
  if (AppState.model && AppState.model.materials) {
    for (let mat of AppState.model.materials) {
      const texName = mat.name.trim();
      let texture = null;

      if (mat.type === MATERIAL_TYPE_COLOR) {
        // Build a color material from RGB values
        const color = ((mat.red & 0xff) << 16) | ((mat.green & 0xff) << 8) | (mat.blue & 0xff);
        const threeMat = new THREE.MeshLambertMaterial({ color, flatShading: false });
        AppState.materials.push(threeMat);
        continue;
      }

      // handle replace#.gif
      else if (mat.type === MATERIAL_TYPE_REPLACER) {
        const threeMat = new THREE.MeshLambertMaterial({ color: 0xFF00FF, flatShading: false }); // TODO - differentiate between replace0, replace1, etc
        AppState.materials.push(threeMat);
        continue;
      } 
      
      // handle tmap
      else {
        const textureFile = findTextureFile(texName);
        if (textureFile) {
          if (!AppState.textureLoader) AppState.textureLoader = new THREE.TextureLoader();
          const url = URL.createObjectURL(textureFile);
          texture = AppState.textureLoader.load(
            url,
            function onLoad() {
            console.log(`Texture loaded from file: ${textureFile.name} for material: ${texName}`);
            URL.revokeObjectURL(url);
          },
          undefined,
          function onError() {
            URL.revokeObjectURL(url);
          }
        );
        texture.flipY = true;
      }
    }

      let threeMat;
      if (texture) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        threeMat = new THREE.MeshLambertMaterial({ map: texture, flatShading: false });
      } else {
        threeMat = new THREE.MeshLambertMaterial({ color: 0x6699cc, flatShading: false });
      }
      AppState.materials.push(threeMat);
    }
  }

  const sceneRoot = new THREE.Group();
  sceneRoot.rotation.x = -(Math.PI / 2);
  sceneRoot.rotation.z = (Math.PI / 2);
  AppState.threeScene.add(sceneRoot);

  if (AppState.model && Array.isArray(AppState.model.objects)) {
    const objects = AppState.model.objects;
    const subGroups = new Array(objects.length);
    const parentIndex = new Array(objects.length).fill(-1);

    for (let i = 0; i < objects.length; i++) {
      const sub = objects[i];
      const g = new THREE.Group();
      const geomInfo = geometriesPerObject?.[i];
      const transform = geomInfo?.transform;
      if (transform) {
        g.applyMatrix4(transform);
        g.updateMatrix();
        g.matrixAutoUpdate = false;
      }
      subGroups[i] = g;
    }

    for (let i = 0; i < objects.length; i++) {
      const sub = objects[i];
      const firstChild = sub.child;
      if (firstChild >= 0 && firstChild < objects.length) {
        parentIndex[firstChild] = i;
        let s = objects[firstChild].sibling;
        while (s >= 0 && s < objects.length) {
          parentIndex[s] = i;
          s = objects[s].sibling;
        }
      }
    }

    AppState.vhotMarkers = [];
    const vhotMaterial = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    const vhotGeom = new THREE.SphereGeometry(0.05, 8, 8);
    for (let i = 0; i < objects.length; i++) {
      const sub = objects[i];
      const g = subGroups[i];

      const p = parentIndex[i];
      if (p >= 0) subGroups[p].add(g); else sceneRoot.add(g);

      const geomInfo = geometriesPerObject?.[i];
      if (geomInfo && geomInfo.geom) {
        let mesh;
        if (AppState.materials.length > 0) {
          mesh = new THREE.Mesh(geomInfo.geom, AppState.materials);
        } else {
          let material = new THREE.MeshLambertMaterial({ color: 0x6699cc, flatShading: true });
          mesh = new THREE.Mesh(geomInfo.geom, material);
        }
        g.add(mesh);
      }

      if (sub && sub.num_vhots > 0) {
        const first = sub.first_vhot || 0;
        const count = sub.num_vhots || 0;
        for (let vi = first; vi < first + count; vi++) {
          const vhot = AppState.model.vhots && AppState.model.vhots[vi];
          if (!vhot) continue;
          const marker = new THREE.Mesh(vhotGeom, vhotMaterial);
          marker.position.set(vhot.point[0], vhot.point[1], vhot.point[2]);
          g.add(marker);
          AppState.vhotMarkers.push(marker);
        }
      }
    }
  }

  if (AppState.model && AppState.model.min_bounds && AppState.model.max_bounds) {
    const min = AppState.model.min_bounds;
    const max = AppState.model.max_bounds;
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const boxGeom = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const boxWire = new THREE.EdgesGeometry(boxGeom);
    const boxMat = new THREE.LineBasicMaterial({ color: 0xff0000 });
    AppState.boundingBox = new THREE.LineSegments(boxWire, boxMat);
    AppState.boundingBox.position.set(center[0], center[1], center[2]);

    // Attach bbox to the scene root group for consistent transforms
    sceneRoot.add(AppState.boundingBox);

    // Bind UI listeners once
    initUI();
  }

  
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);


  AppState.threeScene.add(ambient);

  AppState.threeRenderer = new THREE.WebGLRenderer({ antialias: true });
  AppState.threeRenderer.setSize(width, height);
  AppState.threeRenderer.domElement.style.width = "100%";
  AppState.threeRenderer.domElement.style.height = "100%";
  AppState.threeRenderer.domElement.style.display = "block";

  if (viewer) {
    viewer.innerHTML = "";
    viewer.appendChild(AppState.threeRenderer.domElement);
  } else {
    document.body.appendChild(AppState.threeRenderer.domElement);
  }

  // Create controls once per setup and keep a reference for disposal
  AppState.controls = new OrbitControls(AppState.threeCamera, AppState.threeRenderer.domElement);

  animateThree();
}

function animateThree() {
  AppState.rafId = requestAnimationFrame(animateThree);
  if (AppState.threeRenderer && AppState.threeScene && AppState.threeCamera) {
    AppState.threeRenderer.render(AppState.threeScene, AppState.threeCamera);
  }
}

// === BIN parsing ===
const SZ_R64 = 8;
const SZ_R32 = 4;
const SZ_I32 = 4;
const SZ_U32 = 4;
const SZ_I16 = 2;
const SZ_U16 = 2;
const SZ_I8 = 1;
const SZ_U8 = 1;
class Buffer {
  buf; // ArrayBuffer
  dv;  // DataView
  cursor;
  constructor(buffer) {
    this.buf = buffer;
    this.dv = new DataView(this.buf);
    this.cursor = 0;
  }
  r64(at) { if (!at) at = this.cursor; this.cursor += SZ_R64; return this.dv.getFloat64(at, true); }
  r32(at) { if (!at) at = this.cursor; this.cursor += SZ_R32; return this.dv.getFloat32(at, true); }
  i32(at) { if (!at) at = this.cursor; this.cursor += SZ_I32; return this.dv.getInt32(at, true); }
  u32(at) { if (!at) at = this.cursor; this.cursor += SZ_U32; return this.dv.getUint32(at, true); }
  i16(at) { if (!at) at = this.cursor; this.cursor += SZ_I16; return this.dv.getInt16(at, true); }
  u16(at) { if (!at) at = this.cursor; this.cursor += SZ_U16; return this.dv.getUint16(at, true); }
  i8(at) { if (!at) at = this.cursor; this.cursor += SZ_I8; return this.dv.getInt8(at, true); }
  u8(at) { if (!at) at = this.cursor; this.cursor += SZ_U8; return this.dv.getUint8(at, true); }
  vec3f(at) { if (!at) at = this.cursor; const x = this.r32(); const y = this.r32(); const z = this.r32(); return [x, y, z]; }
  str(at, until = 0) {
    if (!until) { until = at; at = this.cursor; }
    let acc = "";
    const arr = new Uint8Array(this.buf, at, until);
    for (let i = 0; i < arr.length; i++) { if (arr[i]) acc += String.fromCharCode(arr[i]); else break; }
    this.cursor += until; return acc;
  }
}

class Model {
  /***** HEADER *****/
                  // size, byte offset (based off Telliamed's lgmd.h)
  signature;      // u32, 0
  version;        // u32, 4
  name;           // u8[8], 8
  
  max_radius;     // float32, 16
  min_radius;     // float32, 20
  max_bounds;     // 3xfloat32, 24
  min_bounds;     // 3xfloat32, 36
  center;         // 3xfloat32, 48
  
  num_polys;      // u16, 60
  num_points;     // u16, 62
  num_params;     // u16, 64
  num_materials;  // u8, 66
  num_vcalls;     // u8, 67
  num_vhots;      // u8, 68
  num_objs;       // u8, 69
  
  offset_obj;     // u32, 70
  offset_material;// u32, 74
  offset_mapping; // u32, 78
  offset_vhot;    // u32, 82
  offset_point;   // u32, 86
  offset_light;   // u32, 90
  offset_normal;  // u32, 94
  offset_poly;    // u32, 98
  offset_node;    // u32, 102
  
  bin_size;       // u32, 106
  
  // version 4 only:
  material_ex_flags;  // u32, 110
  material_ex_offset; // u32, 114
  material_ex_size;   // u32, 118
  
  // END OF HEADER PROPER
  
  num_uvmaps;     // calculated int
  num_lights;     // calculated int 
  num_normals;    // calculated int
  uses_trans;
  uses_illum;
  
  points;         // Float32Array, arranged [x,y,z, x,y,z, ...]
  lights;
  normals;
  uvs;
  polys;
  materials;
  objects;
  num_nodes;
}

const OBJECT_HEADER_SIZE = 93;
class Obj {
  name;       // u8[8]
  transform;  // 61 bytes, see Transform class 
  child;      // i16
  sibling;    // i16
  
  // 0-based indices into their lists
  first_vhot;     // u16 
  num_vhots;      // u16
  first_point;    // u16
  num_points;     // u16
  first_light;    // u16
  num_lights;     // u16
  first_normal;   // u16
  num_normals;    // u16
  
  // byte offset into its list 
  first_node;     // u16
  num_nodes;      // u16
  
  polys;          // calculated array of polygons belonging to this object
}

const MATERIAL_TYPE_TEXTURE = 0;
const MATERIAL_TYPE_COLOR = 1;
const MATERIAL_TYPE_REPLACER = 100; // special type for replace.gif - not actually in spec, but convenient for us

const MATERIAL_HEADER_SIZE = 26;
class Material {
    name;   // char[16]
    type;   // u8, 0 = tex, 1 = rgb
    id;     // i8

    // rgba - u8 each
    blue;
    green;
    red;    
    // *u8 pad here*
    pal_index;  // u32

    // tex
    handle;     // u32
    uvscale;    // r32

    // MaterialEX:
    has_trans;
    has_illum;
    trans; 
    illum;

    replacer; // default to -1. Values 0-3 indicate the texture is assigned in the editor
}

const MATERIAL_EX_HEADER_SIZE = 16;
class MaterialEx {
  trans;    // r32
  illum;    // r32
  unknown1; // something32
  unknown2; // something32 (these two together seem like a sane double, though not all the time)
}

const LIGHT_HEADER_SIZE = 8;
class Light {
  object;     // u16
  point;      // u16
  normal;    // u32 - packed
}            

const VHOT_HEADER_SIZE = 16;
class Vhot {
  id;     // i16
  point;  // vec3f
}

const POLY_TYPE_TEXTURE = 0x1B;
const POLY_TYPE_RGB = 0x59;
const POLY_TYPE_PAL = 0x39;

const POLY_HEAD_SIZE = 12;
class Polygon {
  /* BEGIN HEADER */
  id;         // i16
  material;   // i16
  type;       // u8
  num_points; // u8
  normal;     // u16, index into normal list
  plane;      // r32, d in plane equation (ax + by + cz + d = 0)
  
  points;     // u16[], index into point list
  lights;     // u16[], index into lights list
  uvs;        // u16[], index into uv list IF type = 0x1B
  mat_ix;     // u8, version 4 only, 0-based index into materials
  /* END HEADER */

  constructor() {
    this.points = [];
    this.lights = [];
    this.uvs = [];
  }
}

const TRANSFORM_HEADER_SIZE = 61;
class Transform {
  type;           // u8
  id;             // i32
  min_position;   // r32
  max_position;   // r32
  axis;           // vec3f[3]
  center;         // vec3f
}

export function read_bin(bin) {
  const buffer = new Buffer(bin);
  const signature = buffer.u32();
  if (signature !== 0x444D474C) {
    console.log("incorrect signature. Bye.");
    return;
  }
  const model = new Model();
  model.version = buffer.u32();
  model.name = buffer.str(8);
  model.max_radius = buffer.r32();
  model.min_radius = buffer.r32();
  model.max_bounds = buffer.vec3f();
  model.min_bounds = buffer.vec3f();
  model.center = buffer.vec3f();
  model.num_polys = buffer.u16();
  model.num_points = buffer.u16();
  model.num_params = buffer.u16();
  model.num_materials = buffer.u8();
  model.num_vcalls = buffer.u8();
  model.num_vhots = buffer.u8();
  model.num_objs = buffer.u8();
  model.offset_obj = buffer.u32();
  model.offset_material = buffer.u32();
  model.offset_mapping = buffer.u32();
  model.offset_vhot = buffer.u32();
  model.offset_point = buffer.u32();
  model.offset_light = buffer.u32();
  model.offset_normal = buffer.u32();
  model.offset_poly = buffer.u32();
  model.offset_node = buffer.u32();
  model.bin_size = buffer.u32();
  if (model.version == 4) {
    model.material_ex_flags = buffer.u32();
    model.material_ex_offset = buffer.u32();
    model.material_ex_size = buffer.u32();
    model.uses_trans = model.material_ex_flags & 1;
    model.uses_illum = model.material_ex_flags & 2;
  }
  model.num_uvmaps = (model.offset_vhot - model.offset_mapping) / 8;
  model.num_lights = (model.offset_normal - model.offset_light) / 8;
  model.num_normals = (model.offset_poly - model.offset_normal) / 12;

  const points = bin.slice(model.offset_point, model.offset_point + (model.num_points * 12));
  model.points = new Float32Array(points);

  const normals = bin.slice(model.offset_normal, model.offset_normal + (model.num_normals * 12));
  model.normals = new Float32Array(normals);

  if (model.num_uvmaps > 0) {
    const uvmaps = bin.slice(model.offset_mapping, model.offset_mapping + (model.num_uvmaps * 8));
    model.uvmaps = new Float32Array(uvmaps);
  }

  model.lights = [];
  if (model.num_lights > 0) {
    const lights = bin.slice(model.offset_light, model.offset_light + (model.num_lights * 8));
    const lbuffer = new Buffer(lights);
    for (let i = 0; i < model.num_lights; i++) {
      const light = new Light();
      light.object = lbuffer.u16();
      light.point = lbuffer.u16();
      const packed = lbuffer.u32();
      // Unpack normal according to spec
      const nx = ((packed >> 16) & 0xFFC0) / 16384.0;
      const ny = ((packed >> 6)  & 0xFFC0) / 16384.0;
      const nz = ((packed << 4)  & 0xFFC0) / 16384.0;
      light.normal = [nx, ny, nz];
      model.lights.push(light);
    }
  }

  model.vhots = [];
  if (model.num_vhots > 0) {
    const vhots = bin.slice(model.offset_vhot, model.offset_vhot + (VHOT_HEADER_SIZE * model.num_vhots));
    const vbuffer = new Buffer(vhots);
    for (let i = 0; i < model.num_vhots; i++) {
      const vhot = new Vhot();
      vhot.id = vbuffer.i32();
      vhot.point = vbuffer.vec3f();
      model.vhots.push(vhot);
    }
  }

  model.materials = [];
  const materials = bin.slice(model.offset_material, model.offset_material + (MATERIAL_HEADER_SIZE * model.num_materials));
  const mbuffer = new Buffer(materials);
  for (let i = 0; i < model.num_materials; i++) {
    const material = new Material();
    material.name = mbuffer.str(16);
    material.type = mbuffer.u8();
    material.id = mbuffer.i8();

    // replace.gif material handling
    const rawName = material.name.trim();
    const lowerName = rawName.toLowerCase();
    const baseName = lowerName.includes('.') ? lowerName.split('.')[0] : lowerName;
    const ext = lowerName.includes('.') ? lowerName.split('.').pop() : '';
    const replaceMaterialNames = ['replace0', 'replace1', 'replace2', 'replace3'];
    if (replaceMaterialNames.includes(baseName) && (ext === '' || ext === 'gif')) {
      material.replacer = parseInt(baseName.slice(-1));
      material.type = MATERIAL_TYPE_REPLACER;
    } else {
      material.replacer = -1;
    }


    if (material.type == MATERIAL_TYPE_COLOR) {
      material.blue = mbuffer.u8();
      material.green = mbuffer.u8();
      material.red = mbuffer.u8();
      mbuffer.u8();
      material.pal_index = mbuffer.u32();
    } else {
      material.handle = mbuffer.u32();
      material.uvscale = mbuffer.r32();
    }
    model.materials.push(material);
  }

  if (model.version == 4 && model.material_ex_offset) {
    const aux = bin.slice(model.material_ex_offset, model.material_ex_offset + (model.material_ex_size * model.num_materials));
    const abuffer = new Buffer(aux);
    for (let i = 0; i < model.num_materials; i++) {
      model.materials[i].trans = abuffer.r32();
      model.materials[i].illum = abuffer.r32();
      if (model.material_ex_size > 8) { abuffer.r32(); abuffer.r32(); }
    }
  }

  model.polys = [];
  const offset_polys = [];
  buffer.cursor = model.offset_poly;
  for (let i = 0; i < model.num_polys; i++) {
    offset_polys.push(buffer.cursor - model.offset_poly);
    const poly = new Polygon();
    poly.id = buffer.i16();
    poly.material = buffer.i16();
    poly.type = buffer.u8();
    poly.num_points = buffer.u8();
    poly.normal = buffer.u16();
    poly.plane = buffer.r32();
    poly.points = [];
    for (let j = 0; j < poly.num_points; j++) poly.points.push(buffer.u16());
    poly.lights = [];
    for (let j = 0; j < poly.num_points; j++) poly.lights.push(buffer.u16());
    if (poly.type == POLY_TYPE_TEXTURE) {
      poly.uvs = [];
      for (let j = 0; j < poly.num_points; j++) poly.uvs.push(buffer.u16());
    }
    if (model.version == 4) poly.mat_ix = buffer.u8();
    model.polys.push(poly);
  }

  // Sanitize polygons and indices
  const validPolyTypes = new Set([POLY_TYPE_TEXTURE, POLY_TYPE_RGB, POLY_TYPE_PAL]);
  const maxPoint = Math.max(0, model.num_points - 1);
  const maxNormal = Math.max(0, model.num_normals - 1);
  const maxUv = Math.max(0, (model.num_uvmaps || 0) - 1);
  const maxLight = Math.max(0, (model.lights?.length || 0) - 1);
  const maxMat = Math.max(0, (model.materials?.length || 1) - 1);
  model.polys = model.polys.filter((poly) => {
    // Type must be recognized
    if (!validPolyTypes.has(poly.type)) return false;

    // Normal index must be in range
    if (poly.normal < 0 || poly.normal > maxNormal) return false;

    // Points must be in range
    for (let i = 0; i < poly.points.length; i++) {
      const p = poly.points[i];
      if (p < 0 || p > maxPoint) return false;
    }

    // Lights must exist per-vertex and be in range (BIN stores vertex normals in lights)
    if (!Array.isArray(poly.lights) || poly.lights.length !== poly.points.length) return false;
    for (let i = 0; i < poly.lights.length; i++) {
      const li = poly.lights[i];
      if (li < 0 || li > maxLight) return false;
    }

    // For textured polys, ensure UVs exist and indices are in range
    if (poly.type === POLY_TYPE_TEXTURE) {
      if (!Array.isArray(poly.uvs) || poly.uvs.length !== poly.points.length) return false;
      if (model.num_uvmaps <= 0 || !model.uvmaps) return false;
      for (let i = 0; i < poly.uvs.length; i++) {
        const u = poly.uvs[i];
        if (u < 0 || u > maxUv) return false;
      }
    }

    // Normalize material index to be 0-based and clamped
    let matIndex = (poly.mat_ix !== undefined) ? poly.mat_ix : (poly.material - 1);
    if (matIndex < 0) matIndex = 0;
    if (matIndex > maxMat) matIndex = maxMat;
    poly.mat_ix = matIndex;

    return true;
  });

  const objs = bin.slice(model.offset_obj, model.offset_obj + (OBJECT_HEADER_SIZE * model.num_objs));
  const obuffer = new Buffer(objs);
  model.objects = [];
  model.num_nodes = 0;
  for (let i = 0; i < model.num_objs; i++) {
    const obj = new Obj();
    obj.name = obuffer.str(8);
    obj.transform = new Transform();
    obj.transform.type = obuffer.u8();
    obj.transform.id = obuffer.i32();
    obj.transform.min_position = obuffer.r32();
    obj.transform.max_position = obuffer.r32();
    obj.transform.axis = [];
    obj.transform.axis.push(obuffer.vec3f());
    obj.transform.axis.push(obuffer.vec3f());
    obj.transform.axis.push(obuffer.vec3f());
    obj.transform.center = obuffer.vec3f();
    obj.child = obuffer.i16();
    obj.sibling = obuffer.i16();
    obj.first_vhot = obuffer.u16();
    obj.num_vhots = obuffer.u16();
    obj.first_point = obuffer.u16();
    obj.num_points = obuffer.u16();
    obj.first_light = obuffer.u16();
    obj.num_lights = obuffer.u16();
    obj.first_normal = obuffer.u16();
    obj.num_normals = obuffer.u16();
    obj.first_node = obuffer.u16();
    const asdf = model.offset_obj + obuffer.cursor; void asdf;
    obj.num_nodes = obuffer.u16();
    model.num_nodes += obj.num_nodes;
    obj.polys = [];
    const p_start = obj.first_point;
    const p_end = p_start + obj.num_points;
    for (let p = 0; p < model.polys.length; p++) {
      const poly = model.polys[p];
      for (let pi = 0; pi < poly.points.length; pi++) {
        const point_index = poly.points[pi];
        if (point_index >= p_start && point_index < p_end) { obj.polys.push(poly); break; }
      }
    }
    model.objects.push(obj);
  }

  return model;
}

/**
 * Build THREE.BufferGeometry per object from the parsed BIN model.
 *
 * Notes:
 * - Creates one BufferGeometry per `model.objects` entry and stores it on `sub._threeGeom`.
 * - Computes and stores an object-local transform matrix on `sub.sub_transform_matrix` when present.
 * - Triangulates n-gons fan-style (0, i+1, i) for textured polygons.
 * - Flips the V texture coordinate (1 - v) to account for image origin differences.
 * - Groups are added per face to support multi-material meshes.
 *
 * Returns an array of created BufferGeometries (also available via `sub._threeGeom`).
 */
function toThree(model) {
  // Prepare one result per object: { geom: BufferGeometry|null, transform: Matrix4|null }
  const results = new Array(model.objects.length).fill(null).map(() => ({ geom: null, transform: null }));
  // Iterate all objects and build a geometry per object
  for (let oi = 0; oi < model.objects.length; oi++) {
    const sub = model.objects[oi];
    const positions = [];
    const uvs = [];
    const normals = [];
    const groups = [];
    let vertexCount = 0;
    // Build an object-local transform matrix if transform data is present
    let sub_transform_matrix = null;
    if (sub.transform && sub.transform.type !== 0) {
      sub_transform_matrix = new THREE.Matrix4();
      sub_transform_matrix.set(
        sub.transform.axis[0][0], sub.transform.axis[1][0], sub.transform.axis[2][0], sub.transform.center[0],
        sub.transform.axis[0][1], sub.transform.axis[1][1], sub.transform.axis[2][1], sub.transform.center[1],
        sub.transform.axis[0][2], sub.transform.axis[1][2], sub.transform.axis[2][2], sub.transform.center[2],
        0, 0, 0, 1
      );
    }
    results[oi].transform = sub_transform_matrix;
    const geom = new THREE.BufferGeometry();
    for (let poly of sub.polys) {
      let matIndex = poly.mat_ix; 
      const isTextured = poly.type === POLY_TYPE_TEXTURE;
      if (poly.num_points > 3) {
        // Triangulate n-gons using a simple fan starting at vertex 0
        for (let i = 1; i < poly.num_points - 1; i++) {
          const tri_indices = [0, i + 1, i];
          for (let j = 0; j < 3; j++) {
            const idx = tri_indices[j];
            const p_ix = poly.points[idx] * 3;
            positions.push(model.points[p_ix], model.points[p_ix + 1], model.points[p_ix + 2]);
            if (isTextured) {
              const uv_ix = poly.uvs[idx] * 2;
              // Flip V axis: BIN UVs are top-left origin, WebGL is bottom-left
              uvs.push(model.uvmaps[uv_ix], 1.0 - model.uvmaps[uv_ix + 1]);
            } else {
              // Dummy UVs for non-textured faces
              uvs.push(0, 0);
            }
            const l_ix = poly.lights[idx];
            const n = model.lights[l_ix].normal;
            normals.push(n[0], n[1], n[2]);
          }
          groups.push({ start: vertexCount, count: 3, materialIndex: matIndex });
          vertexCount += 3;
        }
      } else {
        for (let i = 0; i < poly.num_points; i++) {
          const idx = poly.num_points - 1 - i;
          const p_ix = poly.points[idx] * 3;
          positions.push(model.points[p_ix], model.points[p_ix + 1], model.points[p_ix + 2]);
          if (isTextured) {
            const uv_ix = poly.uvs[idx] * 2;
            // Flip V axis: BIN UVs are top-left origin, WebGL is bottom-left
            uvs.push(model.uvmaps[uv_ix], 1.0 - model.uvmaps[uv_ix + 1]);
          } else {
            uvs.push(0, 0);
          }
          const l_ix = poly.lights[idx];
          const n = model.lights[l_ix].normal;
          normals.push(n[0], n[1], n[2]);
        }
        groups.push({ start: vertexCount, count: poly.num_points, materialIndex: matIndex });
        vertexCount += poly.num_points;
      }
    }
    if (positions.length > 0) {
      // Populate geometry buffers and groups, then finalize
      geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      for (let g of groups) geom.addGroup(g.start, g.count, g.materialIndex);
      geom.computeBoundingSphere();
      results[oi].geom = geom;
    }
  }
  return results;
}
