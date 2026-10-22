// Original fixture construction only; no decoder, native encoder or numeric oracle.
// No arguments checks reproducibility without writing. --write owns exactly
// thirteen KSPLAT leaves and manifest.json under the fixed fixture directory.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== '--write')) {
  throw new Error('Use no arguments for reproducibility comparison, or --write.');
}
const write = arguments_.length === 1;
const construction = 'tools/formats/build-ksplat-v1.mjs';
const constructionPath = fileURLToPath(import.meta.url);
const workspace = resolve(dirname(constructionPath), '../..');
const directory = resolve(workspace, 'tests/fixtures/formats/ksplat-v1');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const require_ = (condition, message) => { if (!condition) throw new Error(message); };

// Pins bind the reviewed format/packing branches, not native execution or a
// complete toolchain closure. Their contents do not generate fixture attributes.
const branches = [
  {
    path: 'native/upstream/splatview/src/core/extra_formats.cpp',
    sha256: '75b8873d60ffb36658e30ef859a7ec99351e8e41a795540590ac63b7bd9dbed0',
    branch: 'loadKsplat: v0.1 sections, modes 0/1/2, buckets and per-band channel-major SH',
  },
  {
    path: 'native/upstream/splatview/src/core/format_utils.hpp',
    sha256: '8f73a8514b3120ed7e6fe01d548dc9b20904ccfc9c39863a04be075c04a276ef',
    branch: 'deterministic source sampling, positive scale and RDF-to-RUB attributes',
  },
  {
    path: 'native/upstream/splatview/src/core/scene_math.cpp',
    sha256: '0ddeb96721e8b3be50e22755f97660c256ab31a0cd55399003ccfc5d20baea31',
    branch: 'normalized quaternion, packed covariance and native 48-component half SH',
  },
  {
    path: 'native/upstream/splatview/src/core/ply_export.cpp',
    sha256: '6c8d9f90fc5a2e037aa1f1ab220b9245c5947db45dfd60d08bb62ff68cfcdbd2',
    branch: 'independently parsed diagnostic PLY output property/coordinate conventions',
  },
];
const sourceLockPath = 'native/SOURCE_LOCK.json';
const sourceLockBytes = readFileSync(resolve(workspace, sourceLockPath));
const sourceLock = JSON.parse(sourceLockBytes.toString('utf8'));
const packageTree = 'f0b272ebe75f0c8380610e4c242faab76e3922f7494cf675d679c9d8dad37e61';
require_(sourceLock.packages?.splatview?.treeSha256 === packageTree, 'Frozen native package tree changed.');
for (const branch of branches) {
  const bytes = readFileSync(resolve(workspace, branch.path));
  require_(sha256(bytes) === branch.sha256, `Reviewed native branch changed: ${branch.path}`);
  require_(sourceLock.files.some(file => file.package === 'splatview' && file.path === branch.path &&
    file.sha256 === branch.sha256), `Reviewed branch is absent from the frozen lock: ${branch.path}`);
  branch.bytes = bytes.length;
}

const sourceCount = 263, headerBytes = 4096, sectionHeaderBytes = 1024;
const range = 4096, blockSize = 16, bucketBytes = 12;
const restCounts = [0, 9, 24, 45];
const quaternions = [[2, 1, 0, 0], [2, 0, 1, 0], [2, 0, 0, 1], [1, 1, 1, 1],
  [3, 1, 2, 0], [3, 0, 1, 2], [2, -1, 1, 0]];
const alpha = [0, 64, 128, 192, 255];
const section = (count, capacity, degree, bucketSize, full, partialLengths) =>
  ({ count, capacity, degree, bucketSize, full, partialLengths });
function topology(degree, mixed) {
  return mixed ? [
    section(0, 2, 3, 0, 0, []),
    section(5, 8, 0, 2, 1, [1, 2]),
    section(66, 69, 1, 16, 3, [2, 16]),
    section(64, 67, 2, 32, 1, [7, 25]),
    section(128, 131, 3, 32, 3, [5, 27]),
    section(0, 1, 3, 0, 0, []),
  ] : [
    section(0, 2, 3, 0, 0, []),
    section(5, 8, degree, 2, 1, [1, 2]),
    section(258, 261, degree, 64, 3, [2, 64]),
    section(0, 1, 3, 0, 0, []),
  ];
}
// All source half fields are small exactly representable dyadic values. This
// constructor deliberately has no general rounding/decoding oracle to share.
function exactHalf(value) {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0;
  const magnitude = Math.abs(value);
  if (!magnitude) return sign;
  const exponent = Math.floor(Math.log2(magnitude));
  const fraction = (magnitude / 2 ** exponent - 1) * 1024;
  require_(exponent >= -14 && exponent <= 15 && Number.isInteger(fraction) && fraction >= 0 && fraction < 1024,
    'Fixture half field must be an exactly representable normal dyadic.');
  return sign | ((exponent + 15) << 10) | fraction;
}
function bucketCenter(sectionIndex, bucket) {
  return [sectionIndex * 32 + bucket * 4, sectionIndex * 8 - bucket * 2, -sectionIndex * 16 + bucket * 3];
}
function attributes(id, sectionIndex, bucket) {
  const delta = [0, 1, 2].map(axis => (id * (axis + 1) + axis * 7) % 31 - 15);
  const center = bucketCenter(sectionIndex, bucket);
  return {
    delta,
    position: center.map((value, axis) => value + delta[axis] / 512),
    scale: [.5 + id % 7 / 16, .25 + id % 5 / 32, .125 + id % 3 / 64],
    quaternion: quaternions[id % quaternions.length],
    rgba: [id % 256, (id * 3 + 17) % 256, (id * 7 + 29) % 256, alpha[id % alpha.length]],
  };
}
function poisonRecord(bytes, at, stride, mode) {
  // Only inactive capacity is poisoned. Even wholly empty sections reserve
  // records, so a count/capacity or offset mistake reaches invalid geometry.
  if (mode === 0) {
    for (let offset = 0; offset < stride; offset += 4) bytes.writeUInt32LE(0x7fc00000, at + offset);
  } else {
    bytes.fill(0xa5, at, at + stride);
    for (let offset = 0; offset + 2 <= stride; offset += 2) bytes.writeUInt16LE(0x7e00, at + offset);
  }
}
function writeRecord(bytes, at, mode, degree, values, id) {
  const { position, delta, scale, quaternion, rgba } = values;
  if (mode === 0) {
    position.forEach((value, axis) => bytes.writeFloatLE(value, at + axis * 4));
    scale.forEach((value, axis) => bytes.writeFloatLE(value, at + 12 + axis * 4));
    quaternion.forEach((value, axis) => bytes.writeFloatLE(value, at + 24 + axis * 4));
  } else {
    delta.forEach((value, axis) => bytes.writeUInt16LE(range + value, at + axis * 2));
    scale.forEach((value, axis) => bytes.writeUInt16LE(exactHalf(value), at + 6 + axis * 2));
    quaternion.forEach((value, axis) => bytes.writeUInt16LE(exactHalf(value), at + 12 + axis * 2));
  }
  bytes.set(rgba, at + (mode === 0 ? 40 : 20));
  let next = at + (mode === 0 ? 44 : 24);
  for (let band = 1; band <= degree; band++) for (let channel = 0; channel < 3; channel++) {
    for (let j = 0; j < 2 * band + 1; j++) {
      if (mode === 2) bytes[next++] = (id * 17 + band * 37 + channel * 41 + j * 13) % 256;
      else {
        const value = ((id * 7 + band * 11 + channel * 13 + j * 3) % 31 - 15) / 32;
        if (mode === 0) { bytes.writeFloatLE(value, next); next += 4; }
        else { bytes.writeUInt16LE(exactHalf(value), next); next += 2; }
      }
    }
  }
  require_(next === at + (mode === 0 ? 44 : 24) + restCounts[degree] * (mode === 0 ? 4 : mode === 1 ? 2 : 1),
    'Fixture record stride disagrees with its declared degree.');
}
function fixture(mode, degree, mixed = false) {
  const sourceSections = topology(degree, mixed), sectionCount = sourceSections.length;
  const minSh = mixed ? 0 : -.75, maxSh = mixed ? 0 : 1.25;
  const totalCapacity = sourceSections.reduce((sum, item) => sum + item.capacity, 0);
  const payloadOffset = headerBytes + sectionCount * sectionHeaderBytes;
  const header = Buffer.alloc(payloadOffset), payloads = [], sections = [];
  header[1] = 1;
  header.writeUInt32LE(sectionCount, 4); header.writeUInt32LE(sectionCount, 8);
  header.writeUInt32LE(totalCapacity, 12); header.writeUInt32LE(sourceCount, 16);
  header.writeUInt16LE(mode, 20); header.writeFloatLE(minSh, 36); header.writeFloatLE(maxSh, 40);
  let globalId = 0, nextPayload = payloadOffset;
  sourceSections.forEach((item, sectionIndex) => {
    const { count, capacity, degree: sectionDegree, bucketSize, full, partialLengths } = item;
    const bucketLengths = [...Array.from({ length: full }, () => bucketSize), ...partialLengths];
    require_(bucketLengths.reduce((sum, length) => sum + length, 0) === count && count <= capacity,
      'Fixture bucket topology must cover exactly its live section.');
    const bucketCount = bucketLengths.length, metadataBytes = partialLengths.length * 4 + bucketCount * bucketBytes;
    const stride = (mode === 0 ? 44 : 24) + restCounts[sectionDegree] * (mode === 0 ? 4 : mode === 1 ? 2 : 1);
    const storageBytes = metadataBytes + capacity * stride, body = Buffer.alloc(storageBytes);
    const headerOffset = headerBytes + sectionIndex * sectionHeaderBytes;
    header.writeUInt32LE(count, headerOffset); header.writeUInt32LE(capacity, headerOffset + 4);
    header.writeUInt32LE(bucketSize, headerOffset + 8); header.writeUInt32LE(bucketCount, headerOffset + 12);
    header.writeFloatLE(blockSize, headerOffset + 16); header.writeUInt16LE(bucketBytes, headerOffset + 20);
    header.writeUInt32LE(range, headerOffset + 24); header.writeUInt32LE(full, headerOffset + 32);
    header.writeUInt32LE(partialLengths.length, headerOffset + 36); header.writeUInt16LE(sectionDegree, headerOffset + 40);
    partialLengths.forEach((length, index) => body.writeUInt32LE(length, index * 4));
    bucketLengths.forEach((_, bucket) => bucketCenter(sectionIndex, bucket).forEach((value, axis) =>
      body.writeFloatLE(value, partialLengths.length * 4 + bucket * bucketBytes + axis * 4)));
    const sourceFirstId = count ? globalId : null;
    let local = 0;
    bucketLengths.forEach((length, bucket) => {
      for (let index = 0; index < length; index++, local++, globalId++) {
        writeRecord(body, metadataBytes + local * stride, mode, sectionDegree,
          attributes(globalId, sectionIndex, bucket), globalId);
      }
    });
    require_(local === count, 'Fixture live record coverage changed.');
    for (; local < capacity; local++) poisonRecord(body, metadataBytes + local * stride, stride, mode);
    sections.push({ sectionIndex, headerOffset, count, capacity, degree: sectionDegree, bucketSize, full,
      partialLengths, bucketCount, range, blockSize, bucketBytes, sourceFirstId,
      payloadOffset: nextPayload, partialLengthsOffset: nextPayload,
      bucketCentersOffset: nextPayload + partialLengths.length * 4, dataOffset: nextPayload + metadataBytes,
      metadataBytes, stride, storageBytes, reservedCount: capacity - count });
    payloads.push(body); nextPayload += storageBytes;
  });
  require_(globalId === sourceCount, 'Fixture must contain exactly 263 live records.');
  const bytes = Buffer.concat([header, ...payloads]);
  require_(bytes.length === nextPayload, 'Fixture section offsets do not cover the file.');
  return { bytes, metadata: { encoding: 'binary_little_endian', mode, sourceCount,
    retainedDegree: mixed ? 3 : degree, sectionCount, totalCapacity, headerBytes, sectionHeaderBytes,
    payloadOffset, minSh, maxSh, effectiveMinSh: mixed ? -1.5 : minSh, effectiveMaxSh: mixed ? 1.5 : maxSh,
    sections, cap3SourceIds: [87, 175, 262], cap2SourceIds: [131, 262], cap1SourceIds: [262] } };
}

const inputs = [];
for (const mode of [0, 1, 2]) for (const degree of [0, 1, 2, 3]) {
  inputs.push({ file: `mode${mode}-sh${degree}.ksplat`, ...fixture(mode, degree) });
}
inputs.push({ file: 'mode2-mixed.ksplat', ...fixture(2, 3, true) });
const manifest = {
  schemaVersion: 1,
  packet: 'ksplat-v1',
  scope: 'Thirteen original small decoder inputs; construction/reproduction does not establish native, browser, independent interoperability or capacity acceptance',
  construction,
  constructionSha256: sha256(readFileSync(constructionPath)),
  oracle: 'tests/format-ksplat.test.ts and tests/fixtures/ksplat-oracle.ts (independent byte parsing, literal source fields, covariance and half math; never import constructor)',
  policyId: 'ksplat-numeric-v1',
  policies: {
    positionsAbsolute: 1e-5,
    opacityAbsolute: 1e-7,
    covarianceRelativeToMaxAxisVariance: 1e-5,
    dcBeforeHalfAbsolute: 2e-6,
    mode2ShBeforeHalfAbsolute: 2e-6,
    exportPositionsAbsolute: 1e-5,
    exportCovarianceRelativeToMaxAxisVariance: 3e-5,
    exportOpacityAbsolute: 3e-7,
    sourceMembership: 'Exact source/loaded counts and full/cap3/cap2/cap1 source identity/order; numeric tolerance cannot excuse membership',
    decodedCovariance: 'Per component 1e-5 * maximum independently reconstructed axis variance, with no absolute floor',
    dc: 'Admissible half bits independently round analytic DC +/- 2e-6 with IEEE ties-to-even',
    sh: 'Modes0/1 retained rest-SH half bits exact after RDF-to-RUB signs; mode2 admissible half bits independently round analytic decoded coefficient +/- 2e-6; omitted native components retain exact signed-zero policy',
    exportedPly: 'Position absolute1e-5, covariance per component3e-5 * maximum axis variance, sigmoid opacity absolute3e-7; exact source membership',
  },
  origin: {
    generated: 'Original analytic dyadic fields and integer wire codes authored for this project; no third-party code, fixture, encoder or decoded records copied',
    formatAuthority: 'Pinned native KSPLAT reader, sampling, coordinate and packing branches below',
    formatContext: 'native/upstream/splatview/THIRD-PARTY-NOTICES.txt: Spark c57ebb936a5d364e021a66a118204d599f6fdaa8 and PlayCanvas splat-transform3.9.0 commit435b972a97a278c655d8f7015b1355215cba0d71; reference context only',
  },
  sourceLock: { path: sourceLockPath, sha256: sha256(sourceLockBytes), package: 'splatview', treeSha256: packageTree },
  nativeBranches: branches,
  inputs: inputs.map(({ file, bytes, metadata }) => ({ file, bytes: bytes.length, sha256: sha256(bytes), ...metadata })),
};
const outputs = [...inputs.map(({ file, bytes }) => [file, bytes]),
  ['manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')]];
require_(outputs.length === 14 && new Set(outputs.map(([name]) => name)).size === 14, 'Fixture output inventory changed.');
for (const [name] of outputs) require_(/^mode[0-2]-sh[0-3]\.ksplat$/.test(name) || name === 'mode2-mixed.ksplat' || name === 'manifest.json',
  `Unexpected fixture output: ${name}`);

// Walk only the four literal destination ancestors, never directory contents.
// Validate each existing parent before creating its next child, so a junction
// cannot redirect even directory creation outside the fixed workspace.
function plainDirectory(path) {
  const state = lstatSync(path);
  require_(state.isDirectory() && !state.isSymbolicLink() && relative(path, realpathSync(path)) === '',
    `Fixture ancestor must be a real directory: ${path}`);
}
plainDirectory(workspace);
let parent = workspace;
for (const component of ['tests', 'fixtures', 'formats', 'ksplat-v1']) {
  parent = resolve(parent, component);
  let absent = false;
  try { lstatSync(parent); }
  catch (error) { if (error.code === 'ENOENT') absent = true; else throw error; }
  if (absent && write) mkdirSync(parent);
  plainDirectory(parent);
}
require_(parent === directory, 'Fixture destination changed.');
// Inspect every exact leaf before writing any bytes; README/evidence/source are
// outside the output inventory. Reject symlink/junction and hard-link aliases.
for (const [name] of outputs) {
  const path = resolve(directory, name);
  require_(dirname(path) === directory, `Fixture output escapes its folder: ${name}`);
  let state;
  try { state = lstatSync(path); }
  catch (error) { if (write && error.code === 'ENOENT') continue; throw error; }
  require_(state.isFile() && !state.isSymbolicLink() && state.nlink === 1 && relative(path, realpathSync(path)) === '',
    `Output must be an ordinary unshared file: ${name}`);
}
for (const [name, bytes] of outputs) {
  const path = resolve(directory, name);
  if (write) writeFileSync(path, bytes);
  else require_(readFileSync(path).equals(bytes), `Fixture is not reproducible: ${name}`);
}
console.log(`${write ? 'Wrote' : 'Verified'} 13 KSPLAT fixtures and manifest (${outputs.reduce((sum, [, bytes]) => sum + bytes.length, 0)} bytes); no decoder/oracle executed.`);
