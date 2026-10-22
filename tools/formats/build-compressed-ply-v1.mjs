// Fixture construction only: no native decoder, encoder, covariance or half oracle.
// Default compares all seventeen explicit outputs without writing. --write may
// write only the sixteen named PLY leaves and manifest.json in the fixed folder.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--write')) {
  throw new Error('Use no arguments for reproducibility comparison, or --write.');
}
const write = arguments_.length === 1;
const construction = 'tools/formats/build-compressed-ply-v1.mjs';
const constructionPath = fileURLToPath(import.meta.url);
const workspace = resolve(dirname(constructionPath), '../..');
const directory = resolve(workspace, 'tests/fixtures/formats/compressed-ply-v1');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const require_ = (condition, message) => { if (!condition) throw new Error(message); };

// Source pins describe the reviewed native branches, not a test execution or a
// complete compiler/dependency closure. No bytes from those branches construct
// the binary attributes below; they only establish the format policy provenance.
const branches = [
  {
    path: 'native/upstream/splatview/src/core/model.cpp',
    sha256: 'ddfe812e09467afc3113b32fff7c777aa6421413d76686c2676643878b26e523',
    branch: 'loadCompressedPly: 12/18 bounds, endian/scalar layout, packed attributes and byte SH',
  },
  {
    path: 'native/upstream/splatview/src/core/format_utils.hpp',
    sha256: '8f73a8514b3120ed7e6fe01d548dc9b20904ccfc9c39863a04be075c04a276ef',
    branch: 'sampledIndex, positive exp scale and RDF-to-RUB conversion',
  },
  {
    path: 'native/upstream/splatview/src/core/scene_math.cpp',
    sha256: '0ddeb96721e8b3be50e22755f97660c256ab31a0cd55399003ccfc5d20baea31',
    branch: 'packGaussian: normalized quaternion, covariance and 48 native half components',
  },
  {
    path: 'native/upstream/splatview/src/core/ply_preview.cpp',
    sha256: 'c0781f056b00c0976c37a9e60dc32c249d98eef951b56451c053bcf7ebc9b844',
    branch: 'PLY header dispatch before the compressed Gaussian branch',
  },
];
const sourceLockPath = 'native/SOURCE_LOCK.json';
const sourceLockBytes = readFileSync(resolve(workspace, sourceLockPath));
const sourceLock = JSON.parse(sourceLockBytes.toString('utf8'));
const packageTree = 'f0b272ebe75f0c8380610e4c242faab76e3922f7494cf675d679c9d8dad37e61';
require_(sourceLock.packages?.splatview?.treeSha256 === packageTree, 'Frozen native package tree changed.');
for (const branch of branches) {
  const bytes = readFileSync(resolve(workspace, branch.path));
  require_(sha256(bytes) === branch.sha256,
    `Reviewed native branch changed: ${branch.path}`);
  require_(sourceLock.files.some(file => file.package === 'splatview' && file.path === branch.path &&
    file.sha256 === branch.sha256), `Reviewed branch is absent from the frozen lock: ${branch.path}`);
  branch.bytes = bytes.length;
}

const sourceCount = 257;
const boundNames = [
  'min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z',
  'min_scale_x', 'min_scale_y', 'min_scale_z', 'max_scale_x', 'max_scale_y', 'max_scale_z',
  'min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b',
];
// All bounds are exact binary32 literals. Source256 alone uses the second row.
const chunkBounds = [
  [100, -30, 8, 108, -14, 12, -3, -2, -1.5, -1.5, -.75, -.25,
    .125, .25, .375, .875, .75, .625],
  [-120, 40, -16, -112, 72, -8, -2.75, -1.75, -1.25, -1.25, -.5, .25,
    .25, .125, .0625, .75, .875, .9375],
];
const boundOrders = {
  12: [11, 0, 7, 3, 1, 9, 4, 6, 10, 2, 8, 5],
  18: [16, 11, 0, 13, 7, 3, 17, 1, 9, 4, 12, 6, 10, 2, 15, 8, 5, 14],
};
const vertexProperties = [
  ['uchar', 'sentinel'], ['uint32', 'packed_scale'], ['uint', 'packed_color'],
  ['uint32', 'packed_rotation'], ['uint', 'packed_position'],
];
// Three ten-bit components are in w/x/y/z order with the omitted lane skipped.
// The omitted lane changes on every record; each pattern stays well conditioned.
const rotationCodes = [
  [512, 600, 420], [340, 560, 640], [670, 410, 530], [470, 720, 360],
  [600, 470, 580], [430, 650, 490], [740, 390, 550], [380, 520, 690],
];
const rgbaCodes = [
  [0, 255, 17, 0], [255, 0, 239, 255], [37, 91, 143, 1], [128, 64, 192, 254],
  [5, 250, 73, 96], [201, 29, 111, 128], [33, 177, 225, 64], [224, 113, 8, 192],
];
const shCodes = [0, 255, 1, 254, 17, 63, 127, 128, 191, 239];
const restCounts = [0, 9, 24, 45];

// These functions construct integers only; numeric expected attributes belong
// exclusively to tests/format-compressed-ply.test.ts.
function packed111011(codes) {
  const [x, y, z] = codes;
  require_(Number.isInteger(x) && x >= 0 && x <= 2047 && Number.isInteger(y) && y >= 0 &&
    y <= 1023 && Number.isInteger(z) && z >= 0 && z <= 2047, 'Invalid literal packed codes.');
  return ((x << 21) | (y << 11) | z) >>> 0;
}
function record(id) {
  const position = id === 0 ? [0, 0, 0] : id === 1 ? [2047, 1023, 2047] :
    [7 * id + 13, (37 * id + 19) % 1024, (73 * id + 11) % 2048];
  const scale = id === 0 ? [0, 1023, 0] : id === 1 ? [2047, 0, 2047] :
    [(11 * id + 91) % 2048, (17 * id + 53) % 1024, (29 * id + 101) % 2048];
  const [a, b, c] = rotationCodes[Math.floor(id / 4) % rotationCodes.length];
  const [r, g, blue, alpha] = rgbaCodes[id === 256 ? 4 : id % rgbaCodes.length];
  return {
    sentinel: (29 * id + 7) % 256,
    packed_position: packed111011(position),
    packed_scale: packed111011(scale),
    packed_rotation: (((id % 4) << 30) | (a << 20) | (b << 10) | c) >>> 0,
    packed_color: ((r << 24) | (g << 16) | (blue << 8) | alpha) >>> 0,
  };
}
function fixture(layoutBoundCount, endian, retainedDegree) {
  const little = endian === 'le', encoding = little ? 'binary_little_endian' : 'binary_big_endian';
  const shPropertyCount = restCounts[retainedDegree], perChannel = shPropertyCount / 3;
  const chunkProperties = boundOrders[layoutBoundCount].map((index, declaration) =>
    [declaration % 2 === 0 ? 'float' : 'float32', boundNames[index], index]);
  const shProperties = Array.from({ length: shPropertyCount }, (_, declaration) =>
    [declaration % 2 === 0 ? 'uchar' : 'uint8', `f_rest_${shPropertyCount - declaration - 1}`,
      shPropertyCount - declaration - 1]);
  const headerLines = [
    'ply', `format ${encoding} 1.0`, 'comment original analytic compressed PLY packet v1',
    'element chunk 2', ...chunkProperties.map(([type, name]) => `property ${type} ${name}`),
    `element vertex ${sourceCount}`, ...vertexProperties.map(([type, name]) => `property ${type} ${name}`),
  ];
  if (shPropertyCount) headerLines.push(`element sh ${sourceCount}`,
    ...shProperties.map(([type, name]) => `property ${type} ${name}`));
  let alignmentComment = 'comment payload_alignment ';
  while (Buffer.byteLength([...headerLines, alignmentComment, 'end_header', ''].join('\n')) % 4 !== 1) {
    alignmentComment += 'x';
  }
  const header = Buffer.from([...headerLines, alignmentComment, 'end_header', ''].join('\n'), 'ascii');
  const chunkStride = layoutBoundCount * 4, vertexStride = 17, shStride = shPropertyCount;
  const chunk = Buffer.alloc(chunkStride * 2), vertices = Buffer.alloc(vertexStride * sourceCount);
  const sh = Buffer.alloc(shStride * sourceCount);
  const chunkView = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const vertexView = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
  for (let id = 0; id < 2; id++) for (let field = 0; field < chunkProperties.length; field++) {
    chunkView.setFloat32(id * chunkStride + field * 4, chunkBounds[id][chunkProperties[field][2]], little);
  }
  for (let id = 0; id < sourceCount; id++) {
    const values = record(id);
    let offset = id * vertexStride;
    for (const [type, name] of vertexProperties) {
      if (type === 'uchar') { vertexView.setUint8(offset, values[name]); offset++; }
      else { vertexView.setUint32(offset, values[name], little); offset += 4; }
    }
    require_(offset === (id + 1) * vertexStride, 'Literal vertex stride mismatch.');
    for (let field = 0; field < shProperties.length; field++) {
      const logical = shProperties[field][2], channel = Math.floor(logical / perChannel), term = logical % perChannel;
      sh[id * shStride + field] = shCodes[(3 * id + 7 * channel + term) % shCodes.length];
    }
  }
  const bytes = Buffer.concat([header, chunk, vertices, sh]);
  return {
    bytes,
    metadata: {
      layoutBoundCount, encoding, sourceCount, chunkCount: 2, retainedDegree, shPropertyCount,
      headerBytes: header.length, chunkStride, vertexStride, shStride,
      payloadOffsets: { chunk: header.length, vertex: header.length + chunk.length,
        sh: shPropertyCount ? header.length + chunk.length + vertices.length : null },
      cap3SourceIds: [85, 171, 256], cap2SourceIds: [128, 256], cap1SourceIds: [256],
    },
  };
}

const inputs = [];
for (const layout of [12, 18]) for (const endian of ['le', 'be']) for (const degree of [0, 1, 2, 3]) {
  const { bytes, metadata } = fixture(layout, endian, degree);
  inputs.push({ file: `layout${layout}-${endian}-sh${degree}.ply`, bytes, metadata });
}
const manifest = {
  schemaVersion: 1,
  packet: 'compressed-ply-v1',
  scope: 'Sixteen small constructed decoder inputs; construction/reproduction is not native, browser, renderer, host or capacity acceptance',
  construction,
  constructionSha256: sha256(readFileSync(constructionPath)),
  oracle: 'tests/format-compressed-ply.test.ts (independent binary reader, literal inputs, matrix and half math; never imports constructor)',
  policyId: 'compressed-ply-numeric-v1',
  policies: {
    positionsAbsolute: 6e-5,
    opacityAbsolute: 1e-7,
    covarianceRelativeToMaxAxisVariance: 8e-6,
    dcBeforeHalfAbsolute: 2e-6,
    exportCovarianceRelativeToMaxAxisVariance: 3e-5,
    exportOpacityAbsolute: 3e-7,
    sourceMembership: 'Exact source/loaded counts and full/cap3/cap2/cap1 source identity/order; no numeric tolerance excuses membership',
    decodedPosition: 'Independent-validator bound: absolute 6e-5 for these fixed bounds (maximum source magnitude120)',
    decodedCovariance: 'Independent-validator bound: per component 8e-6 * maximum independently reconstructed axis variance; no absolute floor',
    decodedOpacity: 'Independent-validator absolute bound 1e-7',
    exportedPlyCovariance: 'Independent-validator bound: per component 3e-5 * maximum independently reconstructed axis variance',
    exportedPlyOpacity: 'Independent-validator sigmoid absolute bound 3e-7',
    sh: 'All retained rest midpoint and absent signed-zero half bits exact; DC admissible bits independently quantize analyticDC +/- 2e-6 with IEEE ties-to-even, without native-adaptive bounds',
  },
  origin: {
    generated: 'Original analytic integer fields and dyadic bounds authored for this project; no third-party fixture, encoder or generated output copied',
    formatAuthority: 'Frozen native compressed-PLY reader and coordinate/packing branches recorded below',
    formatContext: 'docs/third-party/PLAYCANVAS_REFERENCES.md; reference context only, not a copied implementation or interoperability result',
  },
  sourceLock: { path: sourceLockPath, sha256: sha256(sourceLockBytes), package: 'splatview', treeSha256: packageTree },
  nativeBranches: branches,
  inputs: inputs.map(({ file, bytes, metadata }) => ({ file, bytes: bytes.length, sha256: sha256(bytes), ...metadata })),
};
const outputs = [...inputs.map(({ file, bytes }) => [file, bytes]),
  ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')]];
require_(outputs.length === 17 && new Set(outputs.map(([name]) => name)).size === 17,
  'Fixture output inventory changed.');
for (const [name] of outputs) require_(/^layout(12|18)-(le|be)-sh[0-3]\.ply$/.test(name) || name === 'manifest.json',
  `Unexpected fixture output: ${name}`);

if (write) mkdirSync(directory, { recursive: true });
const directoryState = lstatSync(directory);
require_(directoryState.isDirectory() && !directoryState.isSymbolicLink() && relative(directory, realpathSync(directory)) === '',
  'Fixture folder must be a real directory inside the fixed workspace path.');
// Inspect all exact output leaves before any writes. Never enumerate a directory
// or touch README/source/evidence; reject symbolic/hard-linked output aliases.
for (const [name] of outputs) {
  let state;
  try { state = lstatSync(resolve(directory, name)); }
  catch (error) { if (write && error.code === 'ENOENT') continue; throw error; }
  require_(state.isFile() && !state.isSymbolicLink() && state.nlink === 1, `Output must be an ordinary unshared file: ${name}`);
}
for (const [name, bytes] of outputs) {
  const path = resolve(directory, name);
  if (write) writeFileSync(path, bytes);
  else require_(readFileSync(path).equals(bytes), `Fixture is not reproducible: ${name}`);
}
console.log(`${write ? 'Wrote' : 'Verified'} 16 compressed PLY fixtures and manifest (${outputs.reduce((sum, [, bytes]) => sum + bytes.length, 0)} bytes); no decoder/oracle executed.`);
