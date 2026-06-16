import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

export const AppState = {
  selectedModel: null,
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

  texture_blobs: {},

  loaded_bins: {}, // name: model blob
  loaded_textures: {}, // name: texture blob
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

/* 
 * Zip files - consumes all bins and textures in all directories
 * Image files - look to see if any loaded bins are using this texture, and if unassigned, assign it and re-render those bins.
 * Bin files - we'll assign texture names to it, but only in setupthree does the actual matching of name -> file happen.
*/
export async function handleMultipleFileInput(e) {
  const files = e.target.files;
  if(!files.length) return;

  const JSZip = globalThis.JSZip;

  for (let file of files) {
    const extension = file.name.split('.').pop().toLowerCase();

    // BIN handling
    if (extension === 'bin') {
      const path_parts = file.name.split('/');
      const bin_name = path_parts[path_parts.length - 1].split('.')[0];
      AppState.loaded_bins[bin_name] = file

    // Zip handling
    } else if(extension === 'zip' || extension === 'crf') {
      const zip = new JSZip();
      const zipData = await zip.loadAsync(file);

      for(const filename in zipData.files) {
        const zip_extension = filename.split('.').pop().toLowerCase();
        // Bins
        if(zip_extension === 'bin') {
          const path_parts = filename.split('/');
          const bin_name = path_parts[path_parts.length - 1].split('.')[0];
          AppState.loaded_bins[bin_name] = await zipData.files[filename].async('ArrayBuffer');
          
        
        // Textures
        } else if(['gif', 'dds', 'png', 'jpg', 'pcx'].includes(zip_extension)) {
          if(zip_extension === 'pcx') console.warn(`PCX texture unsupported: ${filename}`);
          const path_parts = filename.split('/');
          const texture_name = path_parts[path_parts.length - 1];

          AppState.loaded_textures[texture_name.toLowerCase()] = await zipData.files[filename].async('blob');
        }
      }

    // Textures
    } else {
        // Store the texture file for later matching when we load a BIN that references it
        // TODO handle the case where multiple textures have the same name (we can't automatically resolve this, but we should at least warn the user)

        // warn if pcx (TODO handle pcx)
        if(extension === 'pcx') console.warn(`PCX texture unsupported: ${file.name}`);

        const path_parts = file.name.split('/');
        const texture_name = path_parts[path_parts.length - 1].split('.')[0];

        // Store with full filename (lowercase) as key
        AppState.loaded_textures[texture_name] = file;
    }
  }
  updateModelSelector();
}

function updateModelSelector() {

  const modelSelector = document.getElementById('model-selector');
  if (!modelSelector) return;

  modelSelector.innerHTML = '';

  for (const [filename, model] of Object.entries(AppState.loaded_bins)) {
    const div = document.createElement('div');
    div.className = "hoverable"
    div.textContent = filename;
    div.addEventListener('click', async () => {
      const parsed_model = read_bin(model)
      console.log(parsed_model)
      const geom = toThree(parsed_model)
      AppState.selectedModel = parsed_model;
      await setupThree(geom);
      populateStatistics(parsed_model);
    });
    modelSelector.appendChild(div);
  }
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

  // revoke URLs
  if(Object.keys(AppState.texture_blobs).length !== 0 && AppState.texture_blobs.constructor === Object) {
    //console.log(Object.keys(AppState.texture_blobs))
    for(const [_,data] of Object.entries(AppState.texture_blobs)) {
      if(data.type == "texture" || data.type == "dds") {
        URL.revokeObjectURL(data.url)
      }
    }
  }
  AppState.texture_blobs = {};
}

async function setupThree(geometriesPerObject) {
  // Clean up any previous scene/renderer/resources
  teardownThree();
  if (AppState.threeRenderer && AppState.threeRenderer.domElement.parentNode) {
    AppState.threeRenderer.domElement.parentNode.removeChild(AppState.threeRenderer.domElement);
  }

  AppState.threeScene = new THREE.Scene();
  AppState.threeScene.background = new THREE.Color(0x404040);

  const viewer = document.getElementById("viewer");
  const width = viewer?.clientWidth || 800;
  const height = viewer?.clientHeight || 600;
  AppState.threeCamera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  AppState.threeCamera.position.set(0, 5, 12);
  AppState.threeCamera.lookAt(0, 0, 0);

  // Try to load textures for each material
  AppState.materials = [];
  if (AppState.selectedModel && AppState.selectedModel.materials) {
    for (let mat of AppState.selectedModel.materials) {
      const texName = mat.name.toLowerCase().trim();
      let texture = null;

      AppState.texture_blobs[texName] = {}
      // TODO probably this hideous tblob thing for the material statistics
      // is hideous
      let tblob = AppState.texture_blobs[texName];

      if(mat.has_trans == true) tblob['trans'] = true; else tblob['trans'] = false;
      if(mat.has_illum == true) tblob['illum'] = true; else tblob['illum'] = false;

      if (mat.type === MATERIAL_TYPE_COLOR) {
        tblob['type'] = 'color'
        // Build a color material from RGB values
        const color = ((mat.red & 0xff) << 16) | ((mat.green & 0xff) << 8) | (mat.blue & 0xff);
        tblob['color'] = color;

        const threeMat = new THREE.MeshLambertMaterial({ color, flatShading: false });
        AppState.materials.push(threeMat);
        continue;
      }

      // handle replace#.gif
      else if (mat.type === MATERIAL_TYPE_REPLACER) {
        tblob['type'] = 'replacer'
        const threeMat = new THREE.MeshLambertMaterial({ color: 0xFF00FF, flatShading: false }); // TODO - differentiate between replace0, replace1, etc
        AppState.materials.push(threeMat);
        continue;
      } 
      
      // handle tmap
      else {
        // Look up texture by name (try exact match first, then try matching without extension)
        let textureFile = AppState.loaded_textures[texName];
        let filename = texName.toLowerCase();
        
        if (!textureFile) {
          // Try matching without extension if not found
          const texNameWithoutExt = texName.split('.')[0].toLowerCase();
          for (let [key, file] of Object.entries(AppState.loaded_textures)) {
            if (key.split('.')[0].toLowerCase() === texNameWithoutExt) {
              textureFile = file;
              filename = key.toLowerCase();
              break;
            }
          }
        }
        
        if (textureFile) {
          // If GIF, convert to PNG with alpha first
          if (filename.endsWith('.gif')) {
            try {
              const pngUrl = await gifToPngWithTransparency(textureFile);
              if (pngUrl) {
                tblob['type'] = 'texture';
                tblob['url'] = pngUrl;
                if (!AppState.textureLoader) AppState.textureLoader = new THREE.TextureLoader();
                texture = AppState.textureLoader.load(
                  pngUrl,
                  function onLoad() {},
                  undefined,
                  function onError() {
                    console.error(`Failed to load GIF-converted texture: ${filename}`);
                    URL.revokeObjectURL(pngUrl);
                  }
                );
                texture.flipY = false;
              } else {
                console.warn(`GIF conversion failed, falling back: ${filename}`);
              }
            } catch (e) {
              console.error('Error converting GIF', e);
            }
          } else {
            const url = URL.createObjectURL(textureFile);
            tblob['url'] = url;
            
            if (filename.endsWith('.dds')) {
              tblob['type'] = 'dds'
              const ddsLoader = new DDSLoader();
              texture = ddsLoader.load(
                url,
                function onLoad() {
                }, // we used to revoke the URLs here, but now it's in teardown
                undefined,
                function onError() {
                  console.error(`Failed to load DDS texture: ${textureFile.name}`);
                  URL.revokeObjectURL(url);
                }
              );
              texture.colorSpace = THREE.SRGBColorSpace;
            } else {
              tblob['type'] = 'texture'
              // Regular texture loader for non-DDS files
              if (!AppState.textureLoader) AppState.textureLoader = new THREE.TextureLoader();
              texture = AppState.textureLoader.load(
                url,
                function onLoad() {
                },
                undefined,
                function onError() {
                  console.error(`Failed to load texture: ${textureFile.name}`);
                  URL.revokeObjectURL(url);
                }
              );
            }
            texture.flipY = false;
          }
        }
      }

      let threeMat;
      if (texture) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        threeMat = new THREE.MeshLambertMaterial({ map: texture, flatShading: false, transparent: true, alphaTest: 0.01 });
      } else {
        threeMat = new THREE.MeshLambertMaterial({ color: 0x6699cc, flatShading: false });
      }
      AppState.materials.push(threeMat);
    }
  }

  const sceneRoot = new THREE.Group();
  sceneRoot.rotation.x = -(Math.PI / 2);
  AppState.threeScene.add(sceneRoot);

  if (AppState.selectedModel && Array.isArray(AppState.selectedModel.objects)) {
    const objects = AppState.selectedModel.objects;
    const subGroups = new Array(objects.length);
    const parentIndex = new Array(objects.length).fill(-1);

    for (let i = 0; i < objects.length; i++) {
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
          const vhot = AppState.selectedModel.vhots && AppState.selectedModel.vhots[vi];
          if (!vhot) continue;
          const marker = new THREE.Mesh(vhotGeom, vhotMaterial);
          marker.position.set(vhot.point[0], vhot.point[1], vhot.point[2]);
          g.add(marker);
          AppState.vhotMarkers.push(marker);
        }
      }
    }
  }

  if(AppState.vhotMarkers) {
    if(document.getElementById('toggle-vhots').checked) {
      AppState.vhotMarkers.forEach(marker => { marker.visible = true;});
    } else {
      AppState.vhotMarkers.forEach(marker => { marker.visible = false;});
    }
  }

  if (AppState.selectedModel && AppState.selectedModel.min_bounds && AppState.selectedModel.max_bounds) {
    const min = AppState.selectedModel.min_bounds;
    const max = AppState.selectedModel.max_bounds;
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const boxGeom = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const boxWire = new THREE.EdgesGeometry(boxGeom);
    const boxMat = new THREE.LineBasicMaterial({ color: 0xff0000 });
    AppState.boundingBox = new THREE.LineSegments(boxWire, boxMat);
    AppState.boundingBox.position.set(center[0], center[1], center[2]);

    sceneRoot.add(AppState.boundingBox);
  }

  if(document.getElementById('toggle-bbox').checked) {
    AppState.boundingBox.visible = true;
  } else {
    AppState.boundingBox.visible = false;
  }

  initUI();

  
  const ambient = new THREE.AmbientLight(0xffffff, 2.0);


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

function loadImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = url;
  });
}

async function populateStatistics(m) {
  function $(id, stat) {
    return document.getElementById(id).innerHTML = stat
  }
  $("s-name", m.name)
  $('s-version', m.version)
  $('s-height', m.height.toFixed(4))
  $('s-width', m.width.toFixed(4))
  $('s-length', m.length.toFixed(4))
  $('s-polys', m.num_polys)
  $('s-subobjs', m.num_objs);
  $('s-materials', m.num_materials)
  $('s-vhots', m.num_vhots)

  let subobjs = ""
  for(let i = 0; i < m.objects.length; i++) {
    let type = "";
    if(m.objects[i].transform.type == 0) type = '(fixed)'
    else if(m.objects[i].transform.type == 1) type = '(rotates)'
    else if(m.objects[i].transform.type == 2) type = '(translates)'
    subobjs += `<tr><td colspan=2>#${i}: ${m.objects[i].name} ${type}</td></tr>`
  }
  document.getElementById('subobj-stats').innerHTML = subobjs;

  document.getElementById('material-stats').innerHTML = ""
  let tex_count = 0;
  let $images = "";
  for(let [texname, data] of Object.entries(AppState.texture_blobs)) {
    if(data.type == 'texture') {      
      const { width, height } = await loadImageDimensions(data.url);
      $images += `<div style='padding-bottom: 10px; color: #eee;'>
        <div style='text-align: center; color: #eee;'>#${tex_count}: ${texname} (${width}x${height})</div>`
      if(data.trans == true || data.illum == true) {
        $images += "<div style='color: #eee;'>("
        if(data.trans == true) $images += "transluscent ";
        if(data.illum == true) $images += "self-illum";
        $images += ")</div>"
      }
      $images += `<div style='text-align: center'><img src='${data.url}' width='${width}' height='${height}'></div></div>`
    }

    tex_count++;
  }
  document.getElementById('material-stats').innerHTML = $images;
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
  skip(n) { this.cursor += n; }
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

  height;
  width;
  length;
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
  let signature;

  try {
    signature = buffer.u32();
  } catch (e) {
    console.log("Error reading signature.", e);
    return;
  } 
  if (signature !== 0x444D474C) {
    console.log("incorrect signature. Are you sure this is a static mesh?");
    return;
  }

  const model = new Model();

  try {
    model.version = buffer.u32();           // 4
    model.name = buffer.str(8);             // 8
    buffer.skip(8); // min,max radius       // 8
    model.max_bounds = buffer.vec3f();      // 12
    model.min_bounds = buffer.vec3f();      // 12
    buffer.skip(12); // center              // 12
    model.num_polys = buffer.u16();         // 2
    model.num_points = buffer.u16();        // 2
    buffer.skip(2); // num_params           // 2
    model.num_materials = buffer.u8();      // 1
    buffer.skip(1); // num_vcalls           // 1
    model.num_vhots = buffer.u8();          // 1
    model.num_objs = buffer.u8();           // 1
    model.offset_obj = buffer.u32();         //
    model.offset_material = buffer.u32();
    model.offset_mapping = buffer.u32();
    model.offset_vhot = buffer.u32();
    model.offset_point = buffer.u32();
    model.offset_light = buffer.u32();
    model.offset_normal = buffer.u32();
    model.offset_poly = buffer.u32();
    buffer.skip(SZ_U32); // model.offset_node = buffer.u32();
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
  } catch (e) {
    console.log("Error reading model header.", e);
    return;
  }

  let points;
  try {
    points = bin.slice(model.offset_point, model.offset_point + (model.num_points * 12));
    model.points = new Float32Array(points);
  } catch (e) {
    console.log("Error reading points.", e);
    return;
  }

  let min_x = 1000; let max_x = -1000; 
  let min_y = 1000; let max_y = -1000; 
  let min_z = 1000; let max_z = -1000;
  for(let i = 0; i < model.num_points; i += 3) {
    if(model.points[i] < min_x) min_x = model.points[i];
    if(model.points[i] > max_x) max_x = model.points[i];
    if(model.points[i+1] < min_y) min_y = model.points[i+1];
    if(model.points[i+1] > max_y) max_y = model.points[i+1];
    if(model.points[i+2] < min_z) min_z = model.points[i+2];
    if(model.points[i+2] > max_z) max_z = model.points[i+2];
  }
  model.width = max_x - min_x;
  model.length = max_y - min_y;
  model.height = max_z - min_z;

  let normals;
  try {
    normals = bin.slice(model.offset_normal, model.offset_normal + (model.num_normals * 12));
    model.normals = new Float32Array(normals);
  } catch (e) {
    console.log("Error reading normals.", e);
    return;
  }

  if (model.num_uvmaps > 0) {
    let uvmaps;
    try {
      uvmaps = bin.slice(model.offset_mapping, model.offset_mapping + (model.num_uvmaps * 8));
      model.uvmaps = new Float32Array(uvmaps);
    } catch (e) {
      console.log("Error reading UV maps.", e);
      return;
    }
  }

  model.lights = [];
  if (model.num_lights > 0) {
    let lights;
    try {
      lights = bin.slice(model.offset_light, model.offset_light + (model.num_lights * 8));
      const lbuffer = new Buffer(lights);
      for (let i = 0; i < model.num_lights; i++) {
        const light = new Light();
        lbuffer.skip(SZ_U16 + SZ_U16); // object and point IDs
        const packed = lbuffer.u32();
        // Unpack normal according to mds.h spec
        const nx = ((packed >> 16) & 0xFFC0) / 16384.0;
        const ny = ((packed >> 6)  & 0xFFC0) / 16384.0;
        const nz = ((packed << 4)  & 0xFFC0) / 16384.0;
        light.normal = [nx, ny, nz];
        model.lights.push(light);
      }
    } catch (e) {
      console.log("Error reading lights.", e)
      return;
    }
  }

  model.vhots = [];
  if (model.num_vhots > 0) {
    try {
      const vhots = bin.slice(model.offset_vhot, model.offset_vhot + (VHOT_HEADER_SIZE * model.num_vhots));
      const vbuffer = new Buffer(vhots);
      for (let i = 0; i < model.num_vhots; i++) {
        const vhot = new Vhot();
        vhot.id = vbuffer.i32();
        vhot.point = vbuffer.vec3f();
        model.vhots.push(vhot);
      }
    } catch (e) {
      console.log("Error reading vhots.", e)
      return;
    }
  }

  model.materials = [];
  try {
    const materials = bin.slice(model.offset_material, model.offset_material + (MATERIAL_HEADER_SIZE * model.num_materials));
    const mbuffer = new Buffer(materials);
    for (let i = 0; i < model.num_materials; i++) {
      const material = new Material();
      material.name = mbuffer.str(16);
      material.type = mbuffer.u8();
      material.id = mbuffer.i8();

      material.has_trans = false;
      material.has_illum = false;

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
        mbuffer.skip(1); // pad
        material.pal_index = mbuffer.u32();
      } else {
        mbuffer.skip(8); // handle, uvscale
      }
      model.materials.push(material);
    }
  } catch(e) {
    console.log("Error reading materials.", e);
    return;
  }

  if (model.version == 4 && model.material_ex_offset) {
    try {
      const aux = bin.slice(model.material_ex_offset, model.material_ex_offset + (model.material_ex_size * model.num_materials));
      const abuffer = new Buffer(aux);
      for (let i = 0; i < model.num_materials; i++) {
        model.materials[i].trans = abuffer.r32();
        if(model.materials[i].trans > 0) model.materials[i].has_trans = true;
        else model.materials[i].has_trans = false;

        model.materials[i].illum = abuffer.r32();
        if(model.materials[i].illum > 0) model.materials[i].has_illum = true;
        else model.materials[i].has_illum = false;
        if (model.material_ex_size > 8) { 
          abuffer.skip(8); // min,max_uv
        }
      }
    } catch(e) {
      console.log("Error reading material extensions. ",e );
      return;
    }
  }

  model.polys = [];
  const offset_polys = [];
  buffer.cursor = model.offset_poly;
  try {
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

      if (model.version == 4) {
        poly.mat_ix = buffer.u8();
      } else if (model.version < 4) {
        poly.mat_ix = poly.material - 1;
      }

      model.polys.push(poly); 
    }
  } catch(e) {
    console.log('Error reading polys.', e);
  }

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
 * Returns an array of BufferGeometries
 * - Computes and stores an object-local transform matrix if present
 * - Triangulates n-gons fan-style for textured polygons
 * - Groups are added per face to support multi-material meshes
 *  
 * TODO presumably groups can hold more than 1 face, and group would only changes if mat changes. This 
 * currently creates groups of 3 vertices only, which A) works and B) bugs me
 */
function toThree(model) {
  // result: { geom: BufferGeometry|null, transform: Matrix4|null }
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
              uvs.push(model.uvmaps[uv_ix], model.uvmaps[uv_ix + 1]);
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
            const u = model.uvmaps[uv_ix];
            const v = model.uvmaps[uv_ix + 1];
            uvs.push(u, v);
          } else {
            // Dummy UVs for non-textured faces
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

// GIF-> PNG confidently assuming that a gif's background color index is ALWAYS 
// the way the engine handles transparency

function decompressLZW(bytes, startPos, minCodeSize, expectedLength) {
  const total = expectedLength;
  const out = new Uint8Array(total);
  let outIndex = 0;

  const clearCode = 1 << minCodeSize;
  const eofCode = clearCode + 1;
  let codeSize = minCodeSize + 1;

  let dict = [];
  for (let i = 0; i < clearCode; i++) dict[i] = [i];
  let dictNext = eofCode + 1;

  let bitPos = 0;
  let pos = startPos;
  let currentBlockSize = bytes[pos++];
  let bitBuffer = 0;
  let bitsInBuffer = 0;

  const readBits = (n) => {
    while (bitsInBuffer < n) {
      if (currentBlockSize === 0) return null;
      bitBuffer |= bytes[pos++] << bitsInBuffer;
      bitsInBuffer += 8;
      currentBlockSize--;
      if (currentBlockSize === 0) {
        currentBlockSize = bytes[pos++] || 0;
      }
    }
    const mask = (1 << n) - 1;
    const val = bitBuffer & mask;
    bitBuffer >>= n;
    bitsInBuffer -= n;
    return val;
  };

  let prevSeq = null;
  while (outIndex < total) {
    const code = readBits(codeSize);
    if (code === null) break;
    if (code === clearCode) {
      dict = [];
      for (let i = 0; i < clearCode; i++) dict[i] = [i];
      dictNext = eofCode + 1;
      codeSize = minCodeSize + 1;
      prevSeq = null;
      continue;
    }
    if (code === eofCode) break;

    let seq;
    if (dict[code]) seq = dict[code].slice();
    else if (prevSeq) seq = prevSeq.concat(prevSeq[0]);
    else seq = [];

    for (let v of seq) {
      if (outIndex < total) out[outIndex++] = v;
    }

    if (prevSeq && dictNext < 4096) {
      dict[dictNext++] = prevSeq.concat(seq[0]);
    }

    prevSeq = seq;

    if (dictNext >= (1 << codeSize) && codeSize < 12) codeSize++;
  }

  return out;
}

async function gifToPngWithTransparency(gifBlob) {
  try {
    const ab = await gifBlob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let pos = 0;
    // signature
    if (bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return null;
    pos = 6; // skip signature+version
    const width = bytes[pos] | (bytes[pos+1] << 8);
    const height = bytes[pos+2] | (bytes[pos+3] << 8);
    pos += 4;
    const packed = bytes[pos++];
    const hasGCT = !!(packed & 0x80);
    const gctSize = 1 << ((packed & 0x07) + 1);
    const bgIndex = bytes[pos++];
    pos++; // aspect ratio

    let palette = null;
    if (hasGCT) {
      palette = bytes.slice(pos, pos + (gctSize * 3));
      pos += gctSize * 3;
    }

    let pixelIndices = null;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      if (b === 0x2C) { // image descriptor
        pos += 8; // left, top, w, h
        const imgPacked = bytes[pos++];
        const hasLCT = !!(imgPacked & 0x80);
        const lctSize = hasLCT ? (1 << ((imgPacked & 0x07) + 1)) : 0;
        if (hasLCT) {
          palette = bytes.slice(pos, pos + (lctSize * 3));
          pos += lctSize * 3;
        }
        const lzwMin = bytes[pos++];
        // read image data blocks
        const startDataPos = pos;
        let blockLen = bytes[pos++];
        // compute total compressed data region length until 0 block
        let compStart = pos;
        while (blockLen !== 0) {
          pos += blockLen;
          blockLen = bytes[pos++];
        }
        // decompress - pass position of the first block-size byte (startDataPos)
        pixelIndices = decompressLZW(bytes, startDataPos, lzwMin, width * height);
        break;
      } else if (b === 0x3B) {
        break; // trailer
      } else {
        // unknown - break
        break;
      }
    }

    if (!palette || !pixelIndices) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const out = imgData.data;
    for (let i = 0; i < pixelIndices.length; i++) {
      const pi = pixelIndices[i];
      const palIdx = pi * 3;
      out[i*4] = palette[palIdx];
      out[i*4 + 1] = palette[palIdx + 1];
      out[i*4 + 2] = palette[palIdx + 2];
      out[i*4 + 3] = (bgIndex >= 0 && pi === bgIndex) ? 0 : 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return await new Promise((resolve) => canvas.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), 'image/png'));
  } catch (e) {
    console.error('gifToPngWithTransparency error', e);
    return null;
  }
}