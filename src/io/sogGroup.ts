import { assertResourceCredit, bindResourceLeaseCredit, resourceCreditBytes, resourceLeaseCredit,
  type ResourceCredit, type ResourceLease } from '../document/resources';
import { synchronousSourceHook } from '../document/source';
import { groupNativeStageBytes, MAX_GROUP_RESOURCES, validateGroupSourceDescriptor, type GroupSourceDescriptor } from '../document/sourceGroup';
import { assertSceneInputBytes, assertSourceFitsDecodeBudget, MAX_SOURCE_TRANSPORT_BYTES, NATIVE_LOAD_BUDGET_BYTES } from '../document/sceneInputLimits';
import { assertCanonicalAcquiredPath, assertWellFormedPathString, compareUtf8Paths, resolveMetadataReference } from './paths';
import { MAX_SOURCE_READ_BYTES, SourceReadBroker } from './readBroker';
import { parseSogMetadata, type PreparedSogMetadata } from './sogMetadata';
import { prepareSogCatalog, SOG_CATALOG_LIMITS, type PreparedSogCatalog } from './sogResources';
import { prepareSogDecoderMetadata, type PreparedSogDecoderMetadata } from './sogDecoderMetadata';
import { assertOwnedSceneCollection, type OwnedSceneCollection } from './sceneCollection';

/** Compatibility name for the original union's technical transport bound. */
export const MAX_SOG_GROUP_BYTES = MAX_SOURCE_TRANSPORT_BYTES;
export const MAX_SOG_GROUP_METADATA_BYTES = 16 * 1024 * 1024;
export type SogGroupAcquisitionOptions = {
  admit(bytes: number): ResourceLease;
  current(): void;
};
export type PreparedSogGroup = Readonly<{
  descriptor: GroupSourceDescriptor;
  sources: readonly Readonly<{ resourceId: string; blob: Blob }>[];
  sourceCount: number;
  shDegree: 0 | 1 | 2 | 3 | null;
  version: 1 | 2;
  assertCurrent(): void;
  dispose(): void;
}>;

const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
const fileName = Object.getOwnPropertyDescriptor(File.prototype, 'name')!.get!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Selected = { path: string; blob: File; bytes: number };
type Selection = { kind: 'flat'; files: readonly File[] } |
  { kind: 'collection'; collection: OwnedSceneCollection; primaryPath: string };
type Admission = { raw: ResourceLease; credit: ResourceCredit; bytes: number; live: boolean; lease: ResourceLease };
const preparedGroups = new WeakMap<object, () => void>();
export function assertPreparedSogGroup(value: unknown): asserts value is PreparedSogGroup {
  const current = value !== null && typeof value === 'object' ? preparedGroups.get(value) : undefined;
  if (!current) throw new Error('SOG group was not issued by the bounded acquisition factory.');
  current();
}
function size(blob: Blob): number {
  const bytes: unknown = blobSize.call(blob);
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid SOG Blob size.');
  return bytes;
}
function flat(path: string): void {
  assertWellFormedPathString(path);
  if (!path || path === '.' || path === '..' || path.includes('/') || path.includes('\\'))
    throw new Error('This SOG slice requires canonical flat filenames and references.');
}
function sum(...values: number[]): number {
  let bytes = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(bytes + value)) throw new Error('SOG group size overflow.');
    bytes += value;
  }
  return bytes;
}

/** Flat, selected-files acquisition only. No texture read, hashing, decoder or
 * directory discovery occurs here. Preparation owners never enter the DTO. */
export async function prepareSogGroup(selected: readonly File[], options: SogGroupAcquisitionOptions): Promise<PreparedSogGroup> {
  return prepareGroup({ kind: 'flat', files: selected }, options);
}

/** Resolve the chosen metadata within an explicitly selected collection. Only
 * its complete declared resource union is acquired; the catalog's other files
 * never enter this operation's byte budget or read broker. */
export async function prepareSogCollectionGroup(collection: OwnedSceneCollection, primaryPath: string,
  options: SogGroupAcquisitionOptions): Promise<PreparedSogGroup> {
  assertOwnedSceneCollection(collection);
  if (typeof primaryPath !== 'string' || primaryPath.length > SOG_CATALOG_LIMITS.maxPathUnits)
    throw new Error('Selected SOG paths exceed the preparation limit.');
  assertCanonicalAcquiredPath(primaryPath);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(primaryPath) || primaryPath.split('/').at(-1)!.toLowerCase() !== 'meta.json')
    throw new Error('Choose a collection metadata path whose basename is meta.json.');
  return prepareGroup({ kind: 'collection', collection, primaryPath }, options);
}

async function prepareGroup(selection: Selection, options: SogGroupAcquisitionOptions): Promise<PreparedSogGroup> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('SOG group ownership hooks are required.');
  const admit = options.admit, current = options.current;
  if (typeof admit !== 'function' || typeof current !== 'function') throw new TypeError('SOG group ownership hooks are required.');
  const issuedLeases = new WeakSet<ResourceLease>(), issuedCredits = new WeakSet<ResourceCredit>();
  const admissions = new Map<ResourceCredit, Admission>();
  let closed = false;
  function alive(): void { if (closed) throw new Error('The SOG group owner has been disposed.'); }
  function barrier(): void {
    for (const entry of admissions.values()) assertResourceCredit(entry.credit, entry.bytes);
    alive();
  }
  function assertCurrent(): void {
    alive(); synchronousSourceHook(Reflect.apply(current, options, [])); alive();
    if (selection.kind === 'collection') assertOwnedSceneCollection(selection.collection);
    for (const entry of admissions.values()) {
      const observed = entry.raw.bytes; synchronousSourceHook(observed);
      if (observed !== entry.bytes) throw new Error('SOG group admission credit changed.');
    }
    // No caller getter after this authenticated cross-owner barrier.
    barrier();
  }
  function reserve(bytes: number): ResourceLease {
    sum(bytes); assertCurrent();
    const raw = Reflect.apply(admit, options, [bytes]) as ResourceLease;
    if (typeof raw !== 'function') { synchronousSourceHook(raw); throw new Error('SOG group admission must return a lease.'); }
    if (issuedLeases.has(raw)) throw new Error('SOG group admission reused an owned lease.');
    issuedLeases.add(raw);
    let credit: ResourceCredit;
    try { credit = resourceLeaseCredit(raw); }
    catch (error) {
      try { synchronousSourceHook(raw()); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Unbound SOG group admission cleanup failed.'); }
      throw error;
    }
    // A second wrapper cannot release another owner's reservation on refusal.
    if (issuedCredits.has(credit)) throw new Error('SOG group admission reused an owned credit.');
    issuedCredits.add(credit);
    let entry: Admission;
    const lease = (() => {
      if (!entry.live) return;
      entry.live = false; admissions.delete(credit);
      synchronousSourceHook(raw());
      if (resourceCreditBytes(credit) !== undefined) throw new Error('SOG group release did not retire its credit.');
    }) as ResourceLease;
    Object.defineProperty(lease, 'bytes', { get: () => resourceCreditBytes(credit) ?? 0 });
    entry = { raw, credit, bytes, live: true, lease };
    admissions.set(credit, entry);
    try {
      synchronousSourceHook(raw);
      const observed = raw.bytes, resize = raw.resize; synchronousSourceHook(observed); synchronousSourceHook(resize);
      if (observed !== bytes || typeof resize !== 'function') throw new Error('Invalid SOG group admission lease.');
      lease.resize = amount => {
        sum(amount); if (!entry.live) throw new Error('The SOG group credit is retired.');
        synchronousSourceHook(Reflect.apply(resize, raw, [amount]));
        if (!entry.live) throw new Error('The SOG group credit was retired during resize.');
        assertResourceCredit(credit, amount); entry.bytes = amount; barrier();
      };
      bindResourceLeaseCredit(lease, raw); assertCurrent();
      return lease;
    } catch (error) {
      try { lease(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'SOG group admission cleanup failed.'); }
      throw error;
    }
  }
  const configured = { admit: reserve, current: assertCurrent };
  let broker: SourceReadBroker | undefined, metadata: PreparedSogMetadata | undefined;
  let catalog: PreparedSogCatalog | undefined, decoder: PreparedSogDecoderMetadata | undefined;
  let input: Uint8Array | undefined, inputLease: ResourceLease | undefined;
  let originalBuffer: Uint8Array<ArrayBuffer> | undefined, decoderBuffer: Uint8Array<ArrayBuffer> | undefined;
  let sources: PreparedSogGroup['sources'] | undefined;
  let descriptor: GroupSourceDescriptor | undefined;
  function disposeFactories(): void {
    const previous = [decoder, catalog, metadata]; decoder = undefined; catalog = undefined; metadata = undefined;
    const errors: unknown[] = [];
    for (const owner of previous) { try { owner?.dispose(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'SOG group factory retirement failed.');
  }
  function dispose(): void {
    if (closed) return;
    closed = true; input = undefined; originalBuffer = undefined; decoderBuffer = undefined;
    sources = undefined; descriptor = undefined;
    const errors: unknown[] = [];
    try { disposeFactories(); } catch (error) { errors.push(error); }
    for (const entry of [...admissions.values()]) { try { entry.lease(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'SOG group retirement failed.');
  }
  try {
    assertCurrent();
    if (selection.kind === 'flat' && !Array.isArray(selection.files)) throw new Error('Invalid bounded SOG file selection.');
    const count = selection.kind === 'flat' ? selection.files.length : 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > SOG_CATALOG_LIMITS.maxResources)
      throw new Error('Invalid bounded SOG file selection.');
    const handles = reserve(sum(64 * 1024, count * 256));
    let acquired: Selected[] | undefined = [];
    let units = 0;
    if (selection.kind === 'flat') {
      for (let index = 0; index < count; index++) {
        assertCurrent();
        const blob = selection.files[index];
        const path: unknown = fileName.call(blob);
        if (typeof path !== 'string') throw new Error('SOG acquisition requires selected Files.');
        flat(path); units = sum(units, path.length);
        if (units > SOG_CATALOG_LIMITS.maxPathUnits) throw new Error('Selected SOG paths exceed the preparation limit.');
        const relative: unknown = blob.webkitRelativePath;
        synchronousSourceHook(relative);
        if (relative !== undefined && relative !== '' && relative !== path) throw new Error('Folder discovery is not supported by this flat SOG slice.');
        handles.resize(sum(64 * 1024, count * 256, units * 4));
        assertCurrent();
        acquired.push({ path, blob, bytes: size(blob) });
      }
      selection.files = [];
    }
    assertCurrent();
    const names = new Set<string>(), folded = new Set<string>();
    let primary: Selected | undefined;
    for (const item of acquired) {
      if (names.has(item.path)) throw new Error('Duplicate flat SOG resource filename.');
      const fold = item.path.toLowerCase();
      if (folded.has(fold)) throw new Error('Ambiguous case-alias SOG resource filenames.');
      names.add(item.path); folded.add(fold);
      if (item.path === 'meta.json') primary = item;
    }
    async function acquire(path: string): Promise<Selected> {
      if (selection.kind !== 'collection') throw new Error('Invalid SOG collection acquisition.');
      units = sum(units, path.length);
      if (units > SOG_CATALOG_LIMITS.maxPathUnits) throw new Error('Selected SOG paths exceed the preparation limit.');
      // The held provider is joined by acquireResource before it returns or
      // rejects. No operation credit is retired while a getFile is outstanding.
      handles.resize(sum(64 * 1024, (acquired!.length + 1) * 256, units * 4));
      assertCurrent();
      const blob = await selection.collection.acquireResource(path, assertCurrent);
      assertCurrent();
      if (fileName.call(blob) !== path.split('/').at(-1)) throw new Error('The acquired SOG filename changed.');
      return { path, blob, bytes: size(blob) };
    }
    if (selection.kind === 'collection') {
      primary = await acquire(selection.primaryPath);
      acquired.push(primary);
    }
    if (!primary) throw new Error('Select exactly one meta.json and its declared flat resources.');
    const primaryPath = primary.path;
    const M = primary.bytes;
    if (M < 1 || M > MAX_SOG_GROUP_METADATA_BYTES) throw new Error('SOG metadata exceeds the positive 16 MiB limit.');
    const identifiers = new Set<string>();
    function identifier(): string {
      assertCurrent(); const value = crypto.randomUUID();
      if (!UUID.test(value) || identifiers.has(value)) throw new Error('SOG acquisition requires unique UUID identities.');
      identifiers.add(value); barrier(); return value;
    }
    const operationId = identifier(), primaryResourceId = identifier();
    inputLease = reserve(M); assertCurrent(); input = new Uint8Array(M);
    broker = new SourceReadBroker(primary.blob, { operationId, resourceId: primaryResourceId, byteLength: M }, configured);
    for (let offset = 0; offset < M;) {
      const length = Math.min(MAX_SOURCE_READ_BYTES, M - offset);
      const chunk = await broker.read({ operationId, resourceId: primaryResourceId, offset, length });
      try { assertCurrent(); input.set(new Uint8Array(chunk.bytes), offset); chunk.consume(); }
      catch (error) { chunk.release(); throw error; }
      offset += length;
    }
    await broker.retire(); broker = undefined; assertCurrent();
    metadata = parseSogMetadata(input, configured);
    input = undefined; inputLease(); inputLease = undefined;
    const sourceCount = metadata.sourceCount, version = metadata.version, shDegree = metadata.shDegree;
    const declarations = metadata.declarations;
    let maximumReferenceUnits = 0, maximumReferenceComponents = 0;
    for (const declaration of declarations) {
      const reference = declaration.reference; let components = 1;
      for (let index = 0; index < reference.length; index++) if (reference[index] === '/' || reference[index] === '\\') components++;
      maximumReferenceUnits = Math.max(maximumReferenceUnits, reference.length);
      maximumReferenceComponents = Math.max(maximumReferenceComponents, components);
    }
    // Resolution's replace/split/component peak is admitted before resolving a
    // potentially long alias. The related catalog is built only afterward.
    const resolver = reserve(sum(64 * 1024, declarations.length * 256,
      8 * (primaryPath.length + maximumReferenceUnits),
      96 * (primaryPath.split('/').length + maximumReferenceComponents)));
    const relatedPaths = new Set<string>([primaryPath]);
    for (const declaration of declarations) {
      const path = resolveMetadataReference(primaryPath, declaration.reference);
      if (selection.kind === 'flat') flat(path);
      if (path === primaryPath) throw new Error('SOG metadata cannot reference itself.');
      if (selection.kind === 'flat' && !names.has(path)) throw new Error(`A declared SOG resource was not selected: ${path}`);
      relatedPaths.add(path);
    }
    resolver(); assertCurrent();
    if (selection.kind === 'collection') {
      if (relatedPaths.size > MAX_GROUP_RESOURCES + 1) throw new Error('Too many declared SOG resources.');
      for (const path of [...relatedPaths].filter(path => path !== primaryPath).sort(compareUtf8Paths))
        acquired.push(await acquire(path));
    }
    // The graph contains every final known declaration, including unused file
    // positions. Unrelated neighbors never enter the uint32 catalog/budget.
    const related = acquired.filter(item => relatedPaths.has(item.path));
    let totalBytes = 0;
    for (const item of related) {
      totalBytes = sum(totalBytes, item.bytes);
      assertSceneInputBytes(totalBytes);
      assertSourceFitsDecodeBudget(totalBytes, NATIVE_LOAD_BUDGET_BYTES);
    }
    const selectedById = new Map<string, Selected>();
    const descriptors = related.map(item => {
      const resourceId = item === primary ? primaryResourceId : identifier(); selectedById.set(resourceId, item);
      return { resourceId, acquisitionPath: item.path, byteLength: item.bytes };
    });
    catalog = prepareSogCatalog(descriptors, configured);
    decoder = prepareSogDecoderMetadata(metadata, primaryPath, catalog, configured);
    const R = decoder.byteLength;
    if (R < 1 || R > MAX_SOG_GROUP_METADATA_BYTES) throw new Error('SOG decoder metadata exceeds the positive 16 MiB limit.');
    const resources = Object.freeze(decoder.resources.map(item => Object.freeze({ resourceId: item.resourceId,
      byteLength: item.byteLength, path: item.acquisitionPath, role: item.role })).sort((a, b) =>
      a.role === b.role ? compareUtf8Paths(a.path, b.path) : a.role === 'primary' ? -1 : 1));
    const decoderResourceId = identifier();
    descriptor = validateGroupSourceDescriptor({ kind: 'group', operationId, resourceId: primaryResourceId, byteLength: totalBytes,
      path: primaryPath, role: 'primary', resources, decoder: Object.freeze({ resourceId: decoderResourceId, byteLength: R }) });
    assertSourceFitsDecodeBudget(groupNativeStageBytes(descriptor), NATIVE_LOAD_BUDGET_BYTES);
    // Admit both retained arrays and independent immutable Blob copies before
    // either stream writes. The factory additionally admits its segment overlap.
    reserve(sum(M, R)); reserve(sum(M, R)); assertCurrent();
    originalBuffer = new Uint8Array(M); decoderBuffer = new Uint8Array(R);
    function write(original: boolean): void {
      let offset = 0;
      const target = original ? originalBuffer! : decoderBuffer!;
      const emit = original ? decoder!.writeOriginal : decoder!.writeDecoder;
      const bytes = emit(segment => { assertCurrent(); target.set(segment, offset); offset += segment.byteLength; });
      if (bytes !== target.byteLength || offset !== bytes) throw new Error('SOG metadata emission length changed.');
    }
    write(true); write(false); assertCurrent();
    const originalMetadataBlob = new Blob([originalBuffer], { type: 'application/json' });
    const rewrittenMetadataBlob = new Blob([decoderBuffer], { type: 'application/json' });
    if (size(originalMetadataBlob) !== M || size(rewrittenMetadataBlob) !== R) throw new Error('SOG metadata Blob length changed.');
    sources = Object.freeze([...resources.map(item => Object.freeze({ resourceId: item.resourceId,
      blob: item.role === 'primary' ? originalMetadataBlob : selectedById.get(item.resourceId)!.blob })),
    Object.freeze({ resourceId: decoderResourceId, blob: rewrittenMetadataBlob })]);
    disposeFactories(); acquired = undefined; selectedById.clear(); names.clear(); folded.clear();
    handles.resize(sum(16 * 1024, resources.length * 256, units * 4)); assertCurrent();
    const result: PreparedSogGroup = Object.freeze({
      get descriptor() { assertCurrent(); return descriptor!; },
      get sources() { assertCurrent(); return sources!; },
      get sourceCount() { assertCurrent(); return sourceCount; },
      shDegree, version, assertCurrent, dispose,
    });
    preparedGroups.set(result, assertCurrent);
    return result;
  } catch (error) {
    const errors: unknown[] = [error];
    // Actual Blob reads are unabortable. Retirement joins them before releasing
    // the read credit, parser/input bytes or selection handles.
    try { await broker?.retire(); } catch (cleanup) { errors.push(cleanup); }
    try { dispose(); } catch (cleanup) { errors.push(cleanup); }
    if (errors.length > 1) throw new AggregateError(errors, 'SOG group acquisition and retirement failed.');
    throw error;
  }
}
