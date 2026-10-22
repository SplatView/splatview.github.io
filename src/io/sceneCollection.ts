import { assertResourceCredit, resourceCreditBytes, resourceLeaseCredit, type ResourceLease } from '../document/resources';
import { synchronousSourceHook } from '../document/source';
import { assertCanonicalAcquiredPath, assertWellFormedPathString } from './paths';

export const SCENE_COLLECTION_LIMITS = Object.freeze({
  maxEntries: 65_536, maxPathUnits: 4_194_304, maxPathComponents: 65_536, maxDepth: 256,
});
export type SceneCollectionLimits = { readonly [Key in keyof typeof SCENE_COLLECTION_LIMITS]: number };
export type SceneCollectionOptions = {
  admit(bytes: number): ResourceLease;
  /** Intake only. Issued collections have their own lifetime, independent of navigation. */
  current(): void;
  limits?: Partial<SceneCollectionLimits>;
};
export type SceneCollectionEntry = Readonly<{ id: string; path: string; name: string; kind: 'file' | 'sog-group' }>;
export type OwnedSceneCollection = Readonly<{
  entries: readonly SceneCollectionEntry[];
  assertCurrent(): void;
  acquireResource(path: string, current: () => void): Promise<File>;
  dispose(): Promise<void>;
}>;
export type SceneCollectionResource = Readonly<
  { path: string; kind: 'directory' } | { path: string; kind: 'file'; getFile(): Promise<File> }
>;

const owners = new WeakMap<OwnedSceneCollection, { assertCurrent(): void }>();
const claimedCredits = new WeakSet<object>();
const blobSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
const fileName = Object.getOwnPropertyDescriptor(File.prototype, 'name')!.get!;

export function assertOwnedSceneCollection(value: unknown): asserts value is OwnedSceneCollection {
  const state = value && typeof value === 'object' ? owners.get(value as OwnedSceneCollection) : undefined;
  if (!state) throw new TypeError('A factory-owned scene collection is required.');
  state.assertCurrent();
}

export function collectionCurrent(current: () => void): void {
  if (typeof current !== 'function') throw new TypeError('A synchronous collection current hook is required.');
  synchronousSourceHook(current());
}

/** Shared private preparation credit primitive for the acquisition adapter and catalog.
 * Duplicate wrappers cannot steal an already owned authenticated reservation. */
export function reserveCollectionCredit(admit: SceneCollectionOptions['admit'], bytes: number) {
  if (typeof admit !== 'function' || !Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid collection admission.');
  const lease = admit(bytes);
  if (typeof lease !== 'function') { synchronousSourceHook(lease); throw new TypeError('Collection admission must return a resource lease.'); }
  let owned = false;
  try {
    let credit;
    try { credit = resourceLeaseCredit(lease); }
    catch (error) { owned = true; throw error; }
    if (claimedCredits.has(credit)) throw new Error('Collection admission reused an owned credit.');
    claimedCredits.add(credit); owned = true;
    synchronousSourceHook(lease);
    const resize = lease.resize;
    synchronousSourceHook(resize);
    if (typeof resize !== 'function') throw new TypeError('Collection admission must support resize.');
    let retainedBytes = bytes, released = false;
    const assertCurrent = () => {
      if (released) throw new Error('Collection preparation credit is retired.');
      assertResourceCredit(credit, retainedBytes);
    };
    assertCurrent();
    return {
      assertCurrent,
      resize(next: number) {
        assertCurrent();
        if (!Number.isSafeInteger(next) || next < 0) throw new RangeError('Invalid collection preparation size.');
        synchronousSourceHook(resize.call(lease, next)); assertResourceCredit(credit, next); retainedBytes = next; assertCurrent();
      },
      release() {
        if (!released) {
          released = true; synchronousSourceHook(lease());
          if (resourceCreditBytes(credit) !== undefined) throw new Error('Collection preparation credit was not retired.');
        }
      },
    };
  } catch (error) {
    if (owned) {
      try { synchronousSourceHook(lease()); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Collection admission and retirement failed.'); }
    }
    throw error;
  }
}

export function collectionLimits(value?: Partial<SceneCollectionLimits>): SceneCollectionLimits {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new TypeError('Invalid collection limits.');
  if (value && Object.keys(value).some(key => !Object.hasOwn(SCENE_COLLECTION_LIMITS, key))) throw new Error('Unknown collection limit.');
  const limits: { -readonly [Key in keyof SceneCollectionLimits]: number } = { ...SCENE_COLLECTION_LIMITS };
  for (const key of Object.keys(limits) as (keyof SceneCollectionLimits)[]) {
    const candidate = value?.[key];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > limits[key]) throw new RangeError('Collection limits may only tighten their ceilings.');
    limits[key] = candidate;
  }
  return limits;
}

export function collectionPathCensus(path: string): { units: number; components: number } {
  assertWellFormedPathString(path);
  if (!path || path.includes('\\') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) throw new Error('Invalid acquired collection path.');
  let components = 1;
  for (let index = 0; index < path.length; index++) if (path.charCodeAt(index) === 47) components++;
  return { units: path.length, components };
}

/** Locale-independent natural ordering: ASCII case, digit value, then digit run
 * length. No numeric coercion/overflow; nonnumeric scalars follow UTF-8 order. */
export function compareNaturalSceneNames(left: string, right: string): number {
  assertWellFormedPathString(left); assertWellFormedPathString(right);
  let a = 0, b = 0;
  const digit = (code: number) => code >= 48 && code <= 57;
  const fold = (code: number) => code >= 65 && code <= 90 ? code + 32 : code;
  while (a < left.length && b < right.length) {
    const x = left.codePointAt(a)!, y = right.codePointAt(b)!;
    if (digit(x) && digit(y)) {
      let ae = a, be = b;
      while (ae < left.length && digit(left.charCodeAt(ae))) ae++;
      while (be < right.length && digit(right.charCodeAt(be))) be++;
      let av = a, bv = b;
      while (av < ae - 1 && left.charCodeAt(av) === 48) av++;
      while (bv < be - 1 && right.charCodeAt(bv) === 48) bv++;
      if (ae - av !== be - bv) return ae - av < be - bv ? -1 : 1;
      for (let i = 0; i < ae - av; i++) if (left.charCodeAt(av + i) !== right.charCodeAt(bv + i))
        return left.charCodeAt(av + i) < right.charCodeAt(bv + i) ? -1 : 1;
      if (ae - a !== be - b) return ae - a < be - b ? -1 : 1;
      a = ae; b = be;
    } else {
      if (fold(x) !== fold(y)) return fold(x) < fold(y) ? -1 : 1;
      a += x > 0xffff ? 2 : 1; b += y > 0xffff ? 2 : 1;
    }
  }
  if (a !== left.length || b !== right.length) return a === left.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Metadata-only catalog construction. Providers and every nonprimary neighbor
 * remain private; resource bytes and per-scene limits belong to activation. */
export function prepareSceneCollection(resources: readonly SceneCollectionResource[], options: SceneCollectionOptions): OwnedSceneCollection {
  if (!options || typeof options.current !== 'function') throw new TypeError('A collection intake current hook is required.');
  collectionCurrent(() => options.current());
  const limits = collectionLimits(options.limits);
  if (!Array.isArray(resources)) throw new TypeError('Collection resources must be an array.');
  const resourceCount = resources.length;
  if (!resourceCount || resourceCount > limits.maxEntries) throw new RangeError('The collection entry count exceeds its limit.');
  const credit = reserveCollectionCredit(bytes => options.admit(bytes), 64 * 1024 + resourceCount * 256);
  try {
    collectionCurrent(() => options.current()); credit.assertCurrent();
    let units = 0, components = 0;
    const providers = new Map<string, { name: string; getFile(): Promise<File> }>(), acquired = new Map<string, 'file' | 'directory'>();
    const folded = new Set<string>(), entries: SceneCollectionEntry[] = [];
    for (let index = 0; index < resourceCount; index++) {
      collectionCurrent(() => options.current()); credit.assertCurrent();
      if (resources.length !== resourceCount) throw new Error('Collection resources changed during preparation.');
      const item = resources[index];
      if (!item || typeof item !== 'object') throw new TypeError('Invalid collection resource.');
      const path = item.path, kind = item.kind, getFile = kind === 'file' ? item.getFile : undefined;
      const count = collectionPathCensus(path);
      units += count.units; components += count.components;
      if (units > limits.maxPathUnits || components > limits.maxPathComponents || count.components > limits.maxDepth)
        throw new RangeError('Collection names exceed the preparation limits.');
      credit.resize(64 * 1024 + resourceCount * 256 + 8 * units + 128 * components);
      collectionCurrent(() => options.current()); credit.assertCurrent(); assertCanonicalAcquiredPath(path);
      if (kind !== 'file' && kind !== 'directory') throw new TypeError('Invalid collection resource kind.');
      const alias = path.toLowerCase();
      if (folded.has(alias)) throw new Error('Duplicate or case-aliased collection path.');
      folded.add(alias); acquired.set(path, kind);
      if (kind === 'file') {
        if (typeof getFile !== 'function') throw new TypeError('A collection file needs a lazy provider.');
        const name = path.slice(path.lastIndexOf('/') + 1);
        providers.set(path, { name, getFile: () => getFile.call(item) });
        const group = name.toLowerCase() === 'meta.json';
        if (group || /\.(ply|spz|splat|ksplat|sog|sogs)$/i.test(name)) entries.push(Object.freeze({
          id: crypto.randomUUID(), path, name, kind: group ? 'sog-group' : 'file',
        }));
      }
      collectionCurrent(() => options.current()); credit.assertCurrent();
    }
    const directoryAliases = new Map<string, string>();
    let implicitDirectories = 0;
    for (const path of acquired.keys()) for (let slash = path.indexOf('/'); slash >= 0; slash = path.indexOf('/', slash + 1)) {
      const ancestor = path.slice(0, slash), kind = acquired.get(ancestor);
      if (kind === 'file') throw new Error('A collection file is also a directory path.');
      const alias = ancestor.toLowerCase();
      if (kind === undefined && folded.has(alias)) throw new Error('Case-aliased collection directory path.');
      const previous = directoryAliases.get(alias);
      if (previous !== undefined && previous !== ancestor) throw new Error('Case-aliased collection directory path.');
      if (kind === undefined && previous === undefined) {
        const census = collectionPathCensus(ancestor); implicitDirectories++; units += census.units; components += census.components;
        if (resourceCount + implicitDirectories > limits.maxEntries || units > limits.maxPathUnits || components > limits.maxPathComponents)
          throw new RangeError('Implicit collection directories exceed the preparation limits.');
        credit.resize(64 * 1024 + (resourceCount + implicitDirectories) * 256 + 8 * units + 128 * components);
        collectionCurrent(() => options.current()); credit.assertCurrent();
      }
      directoryAliases.set(alias, ancestor);
    }
    if (!entries.length) throw new Error('The selected collection contains no supported scenes.');
    entries.sort((a, b) => compareNaturalSceneNames(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const publicEntries = Object.freeze(entries);
    let retired = false, retirement: Promise<void> | undefined;
    const pending = new Set<Promise<File>>();
    const assertCurrent = () => { if (retired) throw new Error('The scene collection is disposed.'); credit.assertCurrent(); };
    const result: OwnedSceneCollection = Object.freeze({
      entries: publicEntries,
      assertCurrent,
      acquireResource(path: string, current: () => void) {
        assertCurrent(); assertCanonicalAcquiredPath(path);
        if (typeof current !== 'function') throw new TypeError('A selected-resource current hook is required.');
        collectionCurrent(current); assertCurrent();
        const provider = providers.get(path);
        if (!provider) throw new Error('The selected collection resource was not acquired.');
        if (pending.size >= 4) throw new Error('Too many outstanding collection resource acquisitions.');
        let actual: Promise<File>;
        // Install ownership before invoking any provider hook, including reentrant disposal.
        let resolve!: (file: File | PromiseLike<File>) => void, reject!: (error: unknown) => void;
        const joined = new Promise<File>((yes, no) => { resolve = yes; reject = no; }); pending.add(joined);
        try { actual = Promise.resolve(provider.getFile()); }
        catch (error) { actual = Promise.reject(error); }
        void actual.then(file => {
          try {
            collectionCurrent(current); assertCurrent();
            if (fileName.call(file) !== provider.name || !Number.isSafeInteger(blobSize.call(file)) || blobSize.call(file) < 0)
              throw new Error('The acquired resource does not match its collection path.');
            assertCurrent(); resolve(file);
          } catch (error) { reject(error); }
        }, reject).finally(() => { pending.delete(joined); });
        return joined;
      },
      dispose() {
        if (!retirement) {
          retired = true;
          retirement = Promise.allSettled([...pending]).then(() => { providers.clear(); acquired.clear(); folded.clear(); credit.release(); });
        }
        return retirement;
      },
    });
    collectionCurrent(() => options.current()); credit.assertCurrent();
    if (resources.length !== resourceCount) throw new Error('Collection resources changed during preparation.');
    owners.set(result, { assertCurrent }); return result;
  } catch (error) {
    try { credit.release(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Collection construction and retirement failed.'); }
    throw error;
  }
}
