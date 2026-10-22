import { assertResourceCredit, resourceLeaseCredit, type ResourceCredit, type ResourceLease } from '../document/resources';
import { assertWellFormedPathString, compareUtf8Paths, resolveMetadataReference, validateAcquiredPaths } from './paths';
import { assertPreparedSogMetadata, assertPreparedSogMetadataAlive, assertPreparedSogMetadataCredit,
  type PreparedSogMetadata, type SogDeclaration, type SogGroup } from './sogMetadata';

/** Browser preparation policy, independent of subsequent texture/decoder admission. */
export const SOG_CATALOG_LIMITS = Object.freeze({
  maxResources: 65_536,
  maxPathUnits: 4_194_304,
  maxPathComponents: 65_536,
});
export interface SogCatalogLimits {
  readonly maxResources: number;
  readonly maxPathUnits: number;
  readonly maxPathComponents: number;
}
export interface SogResourceOptions {
  /** Genuine ledger lease, or explicitly bound wrapper; required by the final
   * private cross-owner credit barrier in this isolated integration draft. */
  admit(bytes: number): ResourceLease;
  current(): void;
}
export interface SogCatalogOptions extends SogResourceOptions {
  /** Overrides may tighten the preparation ceilings, never increase them. */
  readonly limits?: Partial<SogCatalogLimits>;
}
export interface AcquiredSogResource {
  readonly resourceId: string;
  /** Canonical relative acquisition path; no root label or separator conversion. */
  readonly acquisitionPath: string;
  readonly byteLength: number;
}
export interface PreparedSogCatalog {
  readonly resourceCount: number;
  readonly totalBytes: number;
  readonly stats: Readonly<{ pathUnits: number; pathComponents: number; catalogBytes: number }>;
  lookup(acquisitionPath: string): Readonly<AcquiredSogResource> | undefined;
  assertCurrent(): void;
  dispose(): void;
}
export interface PreparedSogResource extends AcquiredSogResource {
  readonly role: 'primary' | 'referenced';
  readonly fingerprintPath: string;
}
export interface SogResourceBinding extends SogDeclaration {
  readonly resourceId: string;
  readonly acquisitionPath: string;
  readonly fingerprintPath: string;
}
export interface PreparedSogResources {
  readonly primaryResourceId: string;
  /** Empty, or a canonical directory prefix including its final slash. */
  readonly assetRootPrefix: string;
  readonly resourceCount: number;
  readonly totalBytes: number;
  readonly resources: readonly Readonly<PreparedSogResource>[];
  /** All final known declarations, including extras not consumed by the decoder. */
  readonly bindings: readonly Readonly<SogResourceBinding>[];
  readonly preparationBytes: number;
  assertCurrent(): void;
  dispose(): void;
}

const WORK_BASE = 64 * 1024;
const GROUPS: readonly SogGroup[] = Object.freeze(['means', 'scales', 'quats', 'sh0', 'shN']);
const MINIMUM_FILES = [2, 1, 1, 1, 2] as const;
const MAX_REFERENCE_UNITS = 1_048_576;
const MAX_REFERENCE_UNITS_TOTAL = 4_194_304;
interface CatalogState {
  assertCurrent(): void;
  assertCredit(): void;
  creditBarrier(): void;
  assertAlive(): void;
  lookup(path: string): Readonly<AcquiredSogResource> | undefined;
}
const catalogs = new WeakMap<PreparedSogCatalog, CatalogState>();
const leases = new WeakMap<ResourceLease, { bytes: number; credit?: ResourceCredit; resize?: ResourceLease['resize'] }>();
const issuedCredits = new WeakSet<ResourceCredit>();

function synchronous(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const then = (value as { then?: unknown }).then;
    if (typeof then === 'function') {
      void new Promise<unknown>((resolve, reject) => Reflect.apply(then, value, [resolve, reject])).catch(() => undefined);
      throw new TypeError('SOG ownership hooks must complete synchronously.');
    }
  }
}
function leaseBytes(lease: ResourceLease): unknown {
  const value = lease.bytes; synchronous(value); return value;
}
function checked(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Invalid ${label}.`);
  return value;
}
function byteLength(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError('A selected resource byte length must be uint32.');
  }
  return value;
}
function hooks(options: SogResourceOptions) {
  const admit = options?.admit, current = options?.current;
  if (typeof admit !== 'function' || typeof current !== 'function') {
    throw new TypeError('Synchronous SOG admission and current hooks are required.');
  }
  return {
    current() { synchronous(Reflect.apply(current, options, [])); },
    admit(bytes: number, own: (lease: ResourceLease) => void) {
      const expected = checked(bytes, 'SOG preparation allowance');
      const value = Reflect.apply(admit, options, [expected]) as ResourceLease;
      if (typeof value === 'function') {
        if (leases.has(value)) throw new Error('SOG admission reused an owned lease.');
        let credit: ResourceCredit;
        try { credit = resourceLeaseCredit(value); }
        catch (error) {
          // Even an unbound callable reservation must be retired on refusal.
          leases.set(value, { bytes: expected }); own(value);
          throw error;
        }
        if (issuedCredits.has(credit)) throw new Error('SOG admission reused an owned credit.');
        // Capture callable ownership before any then/bytes/resize getter can fail.
        leases.set(value, { bytes: expected, credit }); own(value); issuedCredits.add(credit);
      }
      synchronous(value);
      if (typeof value !== 'function') throw new TypeError('SOG admission must return a resource lease.');
      const observed = leaseBytes(value), resize = value.resize; synchronous(resize);
      if (observed !== expected || typeof resize !== 'function') throw new Error('Invalid SOG admission lease.');
      leases.get(value)!.resize = resize;
      assertLeaseCredit(value);
      return value;
    },
  };
}
function resize(lease: ResourceLease, bytes: number): void {
  const state = leases.get(lease), expected = checked(bytes, 'SOG preparation allowance');
  if (!state?.resize || leaseBytes(lease) !== state.bytes) throw new Error('Invalid or stale SOG admission lease.');
  synchronous(Reflect.apply(state.resize, lease, [expected]));
  if (leaseBytes(lease) !== expected) throw new Error('A SOG admission resize did not reserve the requested bytes.');
  state.bytes = expected;
  assertLeaseCredit(lease);
}
function assertLeaseCredit(lease: ResourceLease): void {
  const state = leases.get(lease);
  if (!state?.credit) throw new Error('Invalid authenticated SOG admission lease.');
  assertResourceCredit(state.credit, state.bytes);
}
function assertLease(lease: ResourceLease): void {
  const state = leases.get(lease);
  if (!state || leaseBytes(lease) !== state.bytes) throw new Error('Invalid or stale SOG admission lease.');
  assertLeaseCredit(lease);
}
function release(lease: ResourceLease): void {
  if (leases.delete(lease)) synchronous(lease());
}
function failed(error: unknown, lease: ResourceLease | undefined): never {
  if (lease) {
    try { release(lease); } catch (cleanup) { throw new AggregateError([error, cleanup], 'SOG preparation and cleanup failed.'); }
  }
  throw error;
}
function tightenedLimits(value: Partial<SogCatalogLimits> | undefined): SogCatalogLimits {
  const supplied = value;
  if (supplied !== undefined && (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied))) {
    throw new TypeError('Invalid SOG catalog limits.');
  }
  if (supplied && Object.keys(supplied).some(key => !Object.hasOwn(SOG_CATALOG_LIMITS, key))) {
    throw new Error('Unknown SOG catalog limit.');
  }
  const result: { -readonly [Key in keyof SogCatalogLimits]: SogCatalogLimits[Key] } = { ...SOG_CATALOG_LIMITS };
  for (const key of ['maxResources', 'maxPathUnits', 'maxPathComponents'] as const) {
    const candidate = supplied?.[key];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > SOG_CATALOG_LIMITS[key]) {
      throw new RangeError('SOG catalog limits may only tighten the preparation ceilings.');
    }
    result[key] = candidate;
  }
  return result;
}
/** Census without split/replace/encoding arrays; helpers run only after admission. */
function acquiredPathComponents(
  path: string, maxUnits: number = SOG_CATALOG_LIMITS.maxPathUnits,
  maxComponents: number = SOG_CATALOG_LIMITS.maxPathComponents,
): number {
  if (typeof path !== 'string' || path.length > maxUnits) throw new RangeError('Selected SOG paths exceed the catalog preparation limits.');
  assertWellFormedPathString(path);
  if (path.length === 0 || path.includes('\\')) throw new Error('Invalid acquired SOG path.');
  let start = 0, count = 0;
  for (let index = 0; index <= path.length; index++) {
    if (index !== path.length && path.charCodeAt(index) !== 47) continue;
    const length = index - start;
    if (length === 0 || (length === 1 && path.charCodeAt(start) === 46) ||
        (length === 2 && path.charCodeAt(start) === 46 && path.charCodeAt(start + 1) === 46)) {
      throw new Error('An acquired SOG path cannot contain empty or relative components.');
    }
    count++;
    if (count > maxComponents) throw new RangeError('Selected SOG paths exceed the catalog preparation limits.');
    start = index + 1;
  }
  return count;
}
function referenceComponents(reference: string): number {
  assertWellFormedPathString(reference);
  let count = 1;
  for (let index = 0; index < reference.length; index++) {
    const unit = reference.charCodeAt(index);
    if (unit === 47 || unit === 92) count++;
  }
  return count;
}

/**
 * Snapshot descriptors, not Files/Blobs or their contents. A private lookup keeps
 * duplicate IDs/paths and file-directory collisions from being hidden by a Map.
 * The allowance is logical preparation work, not a JavaScript heap measurement.
 */
export function prepareSogCatalog(
  supplied: readonly AcquiredSogResource[], options: SogCatalogOptions,
): PreparedSogCatalog {
  const owner = hooks(options), limits = tightenedLimits(options.limits);
  owner.current();
  if (!Array.isArray(supplied)) throw new TypeError('Selected SOG resources must be an array.');
  const count = supplied.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > limits.maxResources) {
    throw new RangeError('The selected SOG resource count exceeds the catalog limit.');
  }
  let lease: ResourceLease | undefined;
  try {
    const descriptorBytes = WORK_BASE + 256 * count;
    owner.admit(descriptorBytes, value => { lease = value; });
    owner.current(); assertLease(lease!);
    const entries: Readonly<AcquiredSogResource>[] = [];
    let pathUnits = 0, pathComponents = 0, idUnits = 0, totalBytes = 0;
    for (let index = 0; index < count; index++) {
      owner.current(); assertLease(lease!);
      const entry = supplied[index];
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('A selected SOG resource descriptor is required.');
      }
      const resourceId = entry.resourceId, acquisitionPath = entry.acquisitionPath, size = entry.byteLength;
      if (typeof resourceId !== 'string' || resourceId.length === 0 || resourceId.length > 128) {
        throw new Error('Invalid selected SOG resource ID.');
      }
      assertWellFormedPathString(resourceId);
      const components = acquiredPathComponents(acquisitionPath,
        limits.maxPathUnits - pathUnits, limits.maxPathComponents - pathComponents);
      pathUnits = checked(pathUnits + acquisitionPath.length, 'cumulative acquired path length');
      pathComponents = checked(pathComponents + components, 'cumulative acquired path components');
      if (pathUnits > limits.maxPathUnits || pathComponents > limits.maxPathComponents) {
        throw new RangeError('Selected SOG paths exceed the catalog preparation limits.');
      }
      idUnits += resourceId.length;
      const bytes = byteLength(size);
      totalBytes = checked(totalBytes + bytes, 'total selected resource bytes');
      owner.current(); assertLease(lease!);
      entries.push(Object.freeze({ resourceId, acquisitionPath, byteLength: bytes }));
    }
    // All path-sized helpers and lookup structures follow this allowance.
    const catalogBytes = checked(descriptorBytes + 4 * pathUnits + 64 * pathComponents + 2 * idUnits, 'SOG catalog allowance');
    resize(lease!, catalogBytes);
    owner.current(); assertLease(lease!);
    validateAcquiredPaths(entries.map(entry => entry.acquisitionPath));
    let lookup: Map<string, Readonly<AcquiredSogResource>> | undefined = new Map();
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.resourceId)) throw new Error('Duplicate selected SOG resource ID.');
      ids.add(entry.resourceId); lookup.set(entry.acquisitionPath, entry);
    }
    owner.current(); assertLease(lease!);
    const retainedLease = lease!;
    const stats = Object.freeze({ pathUnits, pathComponents, catalogBytes });
    function assertAlive(): void {
      // Private state only: final cross-owner barriers must not invoke getters.
      if (!lookup || !leases.has(retainedLease)) throw new Error('The SOG catalog has been disposed.');
    }
    function assertCredit(): void { assertAlive(); assertLease(retainedLease); assertAlive(); }
    function creditBarrier(): void { assertLeaseCredit(retainedLease); assertAlive(); }
    function assertCurrent(): void {
      assertAlive();
      owner.current();
      assertCredit();
    }
    const result: PreparedSogCatalog = Object.freeze({
      get resourceCount() { assertCurrent(); return count; },
      get totalBytes() { assertCurrent(); return totalBytes; },
      get stats() { assertCurrent(); return stats; },
      lookup(path: string) {
        assertCurrent(); acquiredPathComponents(path, limits.maxPathUnits, limits.maxPathComponents);
        return lookup!.get(path);
      },
      assertCurrent,
      dispose() {
        if (!lookup) return;
        lookup.clear(); lookup = undefined;
        release(retainedLease);
      },
    });
    catalogs.set(result, { assertCurrent, assertCredit, creditBarrier, assertAlive,
      lookup(path) { assertCurrent(); return lookup!.get(path); } });
    lease = undefined;
    return result;
  } catch (error) { return failed(error, lease); }
}

function commonDirectoryPrefix(paths: readonly string[]): string {
  let prefix = paths[0]!.slice(0, paths[0]!.lastIndexOf('/') + 1);
  for (let index = 1; index < paths.length && prefix !== ''; index++) {
    const path = paths[index]!, limit = Math.min(prefix.length, path.lastIndexOf('/') + 1);
    let common = 0, directoryEnd = 0;
    while (common < limit && prefix.charCodeAt(common) === path.charCodeAt(common)) {
      if (prefix.charCodeAt(common) === 47) directoryEnd = common + 1;
      common++;
    }
    prefix = prefix.slice(0, directoryEnd);
  }
  return prefix;
}

/**
 * Resolve the complete final known declaration union before deriving fingerprint
 * paths. Borrowed metadata/catalog must stay alive until graph disposal. This
 * produces no resource digest, texture read, decoder name or source key.
 */
export function prepareSogResources(
  metadata: PreparedSogMetadata, primaryPath: string,
  catalog: PreparedSogCatalog, options: SogResourceOptions,
): PreparedSogResources {
  const owner = hooks(options), selected = catalogs.get(catalog);
  if (!selected) throw new TypeError('A prepared SOG acquisition catalog is required.');
  let lease: ResourceLease | undefined, ownershipLease: ResourceLease | undefined;
  function borrowedCurrent(): void {
    owner.current(); selected!.assertCurrent();
    assertPreparedSogMetadata(metadata);
    if (ownershipLease) assertLease(ownershipLease);
    selected!.assertCredit();
    // All arbitrary parent getters/hooks ran above. These final checks read
    // authenticated private credits, so none can revoke a previously read one.
    if (ownershipLease) assertLeaseCredit(ownershipLease);
    selected!.creditBarrier(); assertPreparedSogMetadataCredit(metadata);
    // No caller code after these final private liveness checks. A current hook
    // or lease getter in either parent may have disposed the other one.
    selected!.assertAlive(); assertPreparedSogMetadataAlive(metadata);
  }
  borrowedCurrent();
  const primaryComponents = acquiredPathComponents(primaryPath);
  const primary = selected.lookup(primaryPath);
  if (!primary) throw new Error('The primary SOG metadata resource was not acquired.');
  const metadataBytes = byteLength(metadata.byteLength);
  if (metadataBytes > 16 * 1024 * 1024 || primary.byteLength !== metadataBytes) {
    throw new Error('The primary SOG resource length does not match prepared metadata.');
  }
  const suppliedDeclarations = metadata.declarations;
  if (!Array.isArray(suppliedDeclarations)) throw new TypeError('Prepared SOG declarations must be an array.');
  const count = suppliedDeclarations.length;
  if (!Number.isSafeInteger(count) || count < 5 || count > 40) {
    throw new RangeError('Invalid complete SOG declaration count.');
  }
  try {
    const descriptorBytes = WORK_BASE + 256 * (count + 41);
    owner.admit(descriptorBytes, value => { lease = ownershipLease = value; });
    borrowedCurrent();
    const declarations: Readonly<SogDeclaration>[] = [];
    const groupCounts = [0, 0, 0, 0, 0], groupBits = [0, 0, 0, 0, 0];
    let referenceUnits = 0, maximumUnits = 0, maximumComponents = 0;
    for (let index = 0; index < count; index++) {
      const supplied = suppliedDeclarations[index];
      if (supplied === null || typeof supplied !== 'object') throw new TypeError('Invalid SOG declaration.');
      const group = supplied.group, position = supplied.index, reference = supplied.reference;
      const groupIndex = GROUPS.indexOf(group);
      if (groupIndex < 0 || !Number.isInteger(position) || position < 0 || position >= 8 ||
          (groupBits[groupIndex]! & (1 << position)) !== 0) throw new Error('Invalid SOG declaration position.');
      if (typeof reference !== 'string' || reference.length === 0 || reference.length > MAX_REFERENCE_UNITS) {
        throw new Error('Invalid bounded SOG resource reference.');
      }
      referenceUnits += reference.length;
      if (referenceUnits > MAX_REFERENCE_UNITS_TOTAL) throw new RangeError('SOG declarations exceed the string preparation limit.');
      const components = referenceComponents(reference);
      maximumUnits = Math.max(maximumUnits, reference.length);
      maximumComponents = Math.max(maximumComponents, components);
      groupCounts[groupIndex]++; groupBits[groupIndex] |= 1 << position;
      declarations.push(Object.freeze({ group, index: position, reference }));
    }
    for (let group = 0; group < GROUPS.length; group++) {
      const files = groupCounts[group]!;
      if ((group !== 4 || files !== 0) &&
          (files < MINIMUM_FILES[group]! || groupBits[group] !== (1 << files) - 1)) {
        throw new Error('Prepared SOG declarations omit a required file position.');
      }
    }
    // Resolver peak is bounded independently of JSON token count, including a
    // long reference made entirely of tiny components or canonical aliases.
    const resolverBytes = checked(8 * (primaryPath.length + maximumUnits) +
      96 * (primaryComponents + maximumComponents), 'SOG path resolution allowance');
    resize(lease!, descriptorBytes + resolverBytes);
    borrowedCurrent();
    const included = new Map<string, Readonly<AcquiredSogResource>>([[primaryPath, primary]]);
    const resolved: { declaration: Readonly<SogDeclaration>; entry: Readonly<AcquiredSogResource> }[] = [];
    for (const declaration of declarations) {
      borrowedCurrent();
      const path = resolveMetadataReference(primaryPath, declaration.reference);
      if (path === primaryPath) throw new Error('SOG metadata cannot reference itself.');
      const entry = selected.lookup(path);
      if (!entry) throw new Error('A declared SOG resource was not acquired.');
      borrowedCurrent();
      included.set(entry.acquisitionPath, entry);
      resolved.push({ declaration, entry });
    }
    let retainedUnits = primaryPath.length + primary.resourceId.length, totalBytes = 0;
    for (const entry of included.values()) {
      // Own every retained occurrence even if a borrowed parent is disposed.
      // Fingerprint paths cannot exceed their original acquisition paths.
      retainedUnits = checked(retainedUnits + entry.resourceId.length + 2 * entry.acquisitionPath.length, 'retained SOG string length');
      totalBytes = checked(totalBytes + entry.byteLength, 'total SOG input bytes');
    }
    for (const { declaration, entry } of resolved) {
      retainedUnits = checked(retainedUnits + declaration.reference.length + entry.resourceId.length +
        2 * entry.acquisitionPath.length, 'retained SOG binding string length');
    }
    const preparationBytes = checked(descriptorBytes + resolverBytes + 2 * retainedUnits, 'SOG graph allowance');
    resize(lease!, preparationBytes);
    borrowedCurrent();
    let assetRootPrefix: string | undefined = commonDirectoryPrefix([...included.keys()]);
    let resources: readonly Readonly<PreparedSogResource>[] | undefined = Object.freeze([...included.values()].map(entry => Object.freeze({
      ...entry, role: entry === primary ? 'primary' as const : 'referenced' as const,
      fingerprintPath: entry.acquisitionPath.slice(assetRootPrefix!.length),
    })).sort((left, right) => compareUtf8Paths(left.fingerprintPath, right.fingerprintPath)));
    let bindings: readonly Readonly<SogResourceBinding>[] | undefined = Object.freeze(resolved.map(({ declaration, entry }) => Object.freeze({
      ...declaration, resourceId: entry.resourceId, acquisitionPath: entry.acquisitionPath,
      fingerprintPath: entry.acquisitionPath.slice(assetRootPrefix!.length),
    })).sort((left, right) => GROUPS.indexOf(left.group) - GROUPS.indexOf(right.group) || left.index - right.index));
    borrowedCurrent();
    const retainedLease = lease!;
    const primaryResourceId = primary.resourceId, resourceCount = resources.length;
    let disposed = false;
    function assertCurrent(): void {
      if (disposed) throw new Error('The SOG resource graph has been disposed.');
      borrowedCurrent();
      if (disposed) throw new Error('The SOG resource graph has been disposed.');
    }
    const result: PreparedSogResources = Object.freeze({
      get primaryResourceId() { assertCurrent(); return primaryResourceId; },
      get assetRootPrefix() { assertCurrent(); return assetRootPrefix!; },
      get resourceCount() { assertCurrent(); return resourceCount; },
      get totalBytes() { assertCurrent(); return totalBytes; },
      get resources() { assertCurrent(); return resources!; },
      get bindings() { assertCurrent(); return bindings!; },
      get preparationBytes() { assertCurrent(); return preparationBytes; },
      assertCurrent,
      dispose() {
        if (disposed) return;
        disposed = true; resources = undefined; bindings = undefined; assetRootPrefix = undefined; ownershipLease = undefined;
        release(retainedLease);
      },
    });
    lease = undefined;
    return result;
  } catch (error) { return failed(error, lease); }
}
