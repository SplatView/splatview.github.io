import { assertCanonicalAcquiredPath, assertWellFormedPathString } from './paths';
import { collectionCurrent, collectionLimits, collectionPathCensus, prepareSceneCollection, reserveCollectionCredit,
  type OwnedSceneCollection, type SceneCollectionOptions, type SceneCollectionResource } from './sceneCollection';

// Independent standard-Web-API implementation. COLMAPView is an API/design
// reference, not copied or adapted code (its repository is AGPL-3.0):
// https://github.com/ColmapView/Colmapview.github.io/blob/0a1d01c3c8c65f9c0a244f4608c50558c221c5fd/src/utils/fileScanning.ts
// https://github.com/ColmapView/Colmapview.github.io/blob/0a1d01c3c8c65f9c0a244f4608c50558c221c5fd/src/hooks/fileDropzoneDropPayload.ts
// https://wicg.github.io/entries-api/

type Entry = Readonly<{ name: string; isFile: boolean; isDirectory: boolean;
  file?: (yes: (file: File) => void, no: (error: DOMException) => void) => void;
  createReader?: () => { readEntries(yes: (entries: Entry[]) => void, no: (error: DOMException) => void): void } }>;
type DropItem = Readonly<{ kind: 'entry'; entry: Entry; name: string } | { kind: 'file'; file: File }>;
export type SceneCollectionDrop = Readonly<{ readonly itemCount: number; dispose(): Promise<void> }>;
type DropOwner = { items?: readonly DropItem[]; retired: boolean; claimed: boolean;
  joined?: Promise<void>; finish?: () => void; credit: ReturnType<typeof reserveCollectionCredit>; retirement?: Promise<void> };
const drops = new WeakMap<SceneCollectionDrop, DropOwner>();
const fileName = Object.getOwnPropertyDescriptor(File.prototype, 'name')!.get!;

function component(value: string): void {
  assertWellFormedPathString(value);
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) throw new Error('Invalid acquired collection name.');
}
function arrayLength(value: ArrayLike<unknown>, maximum: number): number {
  const count = value?.length;
  if (!Number.isSafeInteger(count) || count < 1 || count > maximum) throw new RangeError('The selected collection entry count exceeds its limit.');
  return count;
}
function builder(options: SceneCollectionOptions) {
  if (!options || typeof options.current !== 'function') throw new TypeError('A collection intake current hook is required.');
  collectionCurrent(() => options.current()); const limits = collectionLimits(options.limits), credit = reserveCollectionCredit(bytes => options.admit(bytes), 64 * 1024);
  const resources: SceneCollectionResource[] = [], paths = new Set<string>();
  let units = 0, components = 0, queuedCount = 0, queuedUnits = 0, queuedComponents = 0, batchEntries = 0;
  const check = () => { collectionCurrent(() => options.current()); credit.assertCurrent(); };
  const allowance = (extraCount = 0) => 64 * 1024 + 512 * (resources.length + queuedCount + batchEntries + extraCount) +
    8 * (units + queuedUnits) + 128 * (components + queuedComponents);
  function unqueuePath(path: string) {
    const census = collectionPathCensus(path); queuedCount--; queuedUnits -= census.units; queuedComponents -= census.components;
    // No shrink until ownership transfers into add(); the string/handle is still live.
  }
  function add(resource: SceneCollectionResource, inferParents = false, fromQueue = false, fromBatch = false) {
    check(); const count = collectionPathCensus(resource.path);
    if (inferParents) for (let slash = resource.path.indexOf('/'); slash >= 0; slash = resource.path.indexOf('/', slash + 1)) {
      const path = resource.path.slice(0, slash); if (!paths.has(path)) add({ path, kind: 'directory' });
    }
    if (fromQueue) unqueuePath(resource.path);
    if (fromBatch) batchEntries--;
    if (resources.length + queuedCount + batchEntries + 1 > limits.maxEntries || units + queuedUnits + count.units > limits.maxPathUnits ||
        components + queuedComponents + count.components > limits.maxPathComponents || count.components > limits.maxDepth)
      throw new RangeError('Collection discovery exceeds its entry/name limits.');
    credit.resize(allowance(1) + 8 * count.units + 128 * count.components);
    check(); assertCanonicalAcquiredPath(resource.path);
    resources.push(resource); paths.add(resource.path); units += count.units; components += count.components; check();
  }
  return { limits, check, add, resources,
    reserveBatch(length: number) {
      check();
      if (!Number.isSafeInteger(length) || length < 0 || length > limits.maxEntries - resources.length - queuedCount - batchEntries)
        throw new RangeError('Directory batch exceeds the collection entry limit.');
      credit.resize(allowance(length)); check(); batchEntries += length;
    },
    queuePath(pathUnits: number, pathComponents: number) {
      check();
      if (batchEntries) batchEntries--;
      if (resources.length + queuedCount + batchEntries + 1 > limits.maxEntries || units + queuedUnits + pathUnits > limits.maxPathUnits ||
          components + queuedComponents + pathComponents > limits.maxPathComponents || pathComponents > limits.maxDepth)
        throw new RangeError('Collection discovery exceeds its entry/name limits.');
      credit.resize(allowance(1) + 8 * pathUnits + 128 * pathComponents); check();
      queuedCount++; queuedUnits += pathUnits; queuedComponents += pathComponents;
    },
    unqueuePath,
    async finish() {
      check(); if (queuedCount || batchEntries) throw new Error('Incomplete collection discovery.');
      const result = prepareSceneCollection(resources, options);
      try {
        check(); credit.release();
        collectionCurrent(() => options.current()); result.assertCurrent(); return result;
      } catch (error) {
        try { await result.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Collection handoff and retirement failed.'); }
        throw error;
      }
    },
    release() { credit.release(); },
  };
}

async function fromFiles(files: ArrayLike<File>, options: SceneCollectionOptions, directory: boolean): Promise<OwnedSceneCollection> {
  const work = builder(options);
  try {
    const count = arrayLength(files, work.limits.maxEntries); work.reserveBatch(count);
    let selectedRoot: string | undefined;
    for (let index = 0; index < count; index++) {
      work.check(); const file = files[index], name = fileName.call(file); component(name);
      let path = name;
      if (directory) {
        const relative = file.webkitRelativePath;
        if (typeof relative !== 'string' || !relative.includes('/')) throw new Error('Folder selection needs real relative paths.');
        const slash = relative.indexOf('/'), root = relative.slice(0, slash); component(root);
        if (selectedRoot === undefined) selectedRoot = root;
        if (root !== selectedRoot) throw new Error('Folder selection has ambiguous selected roots.');
        let components = 1;
        for (let index = slash + 1; index < relative.length; index++) if (relative.charCodeAt(index) === 47) components++;
        work.queuePath(relative.length - slash - 1, components);
        path = relative.slice(slash + 1);
        if (path.slice(path.lastIndexOf('/') + 1) !== name) throw new Error('Folder relative path does not match its filename.');
      } else work.queuePath(name.length, 1);
      work.add({ path, kind: 'file', getFile: async () => file }, true, true);
    }
    return await work.finish();
  } finally { work.release(); }
}
export function acquireSceneCollectionFromFiles(files: ArrayLike<File>, options: SceneCollectionOptions): Promise<OwnedSceneCollection> {
  return fromFiles(files, options, false);
}
export function acquireSceneCollectionFromFolderFiles(files: ArrayLike<File>, options: SceneCollectionOptions): Promise<OwnedSceneCollection> {
  return fromFiles(files, options, true);
}

/** Must run inside the readable drop event, before the first await. This captures
 * entry authority, never directory bodies. Ordinary-file fallback does not infer directories. */
export function snapshotSceneCollectionDrop(dataTransfer: DataTransfer, options: SceneCollectionOptions): SceneCollectionDrop {
  if (!options || typeof options.current !== 'function') throw new TypeError('A drop intake current hook is required.');
  collectionCurrent(() => options.current()); const limits = collectionLimits(options.limits);
  const supplied = dataTransfer?.items;
  const count = arrayLength(supplied, limits.maxEntries), credit = reserveCollectionCredit(bytes => options.admit(bytes), 64 * 1024 + count * 256);
  try {
    const items: DropItem[] = []; let units = 0;
    for (let index = 0; index < count; index++) {
      collectionCurrent(() => options.current()); credit.assertCurrent(); const item = supplied[index];
      if (item.kind !== 'file') throw new Error('Drop only local files or folders.');
      const method = (item as DataTransferItem & { getAsEntry?: () => FileSystemEntry | null }).getAsEntry ?? item.webkitGetAsEntry;
      const entry = typeof method === 'function' ? method.call(item) as Entry | null : null;
      const file = entry ? undefined : item.getAsFile();
      if (!entry && !file) throw new Error('The dropped file or directory cannot be acquired.');
      const name = entry ? entry.name : fileName.call(file); component(name); units += name.length;
      if (units > limits.maxPathUnits) throw new RangeError('Dropped names exceed the collection limit.');
      credit.resize(64 * 1024 + count * 256 + 8 * units); collectionCurrent(() => options.current()); credit.assertCurrent();
      items.push(entry ? Object.freeze({ kind: 'entry', entry, name }) : Object.freeze({ kind: 'file', file: file! }));
    }
    const owner: DropOwner = { items: Object.freeze(items), retired: false, claimed: false, credit };
    const snapshot: SceneCollectionDrop = Object.freeze({ itemCount: items.length, dispose() {
      if (!owner.retirement) { owner.retired = true; owner.retirement = Promise.resolve(owner.joined).then(() => { owner.items = undefined; credit.release(); }); }
      return owner.retirement;
    } });
    collectionCurrent(() => options.current()); credit.assertCurrent(); drops.set(snapshot, owner); return snapshot;
  } catch (error) { credit.release(); throw error; }
}

export async function acquireSceneCollectionFromDrop(snapshot: SceneCollectionDrop, options: SceneCollectionOptions): Promise<OwnedSceneCollection> {
  const owner = drops.get(snapshot);
  if (!owner || owner.retired || owner.claimed || !owner.items) throw new TypeError('An unused factory-owned collection drop is required.');
  owner.credit.assertCurrent(); owner.claimed = true;
  owner.joined = new Promise<void>(resolve => { owner.finish = resolve; });
  const selected = owner.items; let work: ReturnType<typeof builder> | undefined, result: OwnedSceneCollection | undefined;
  const check = () => { if (owner.retired) throw new Error('The collection drop is disposed.'); owner.credit.assertCurrent(); collectionCurrent(() => options.current()); };
  try {
    work = builder({ ...options, current: check });
    work.reserveBatch(selected.length);
    const queue: { entry: Entry; path: string }[] = [];
    for (const item of selected) {
      work.check();
      if (item.kind === 'file') {
        const name = fileName.call(item.file); component(name); work.add({ path: name, kind: 'file', getFile: async () => item.file }, false, false, true);
      } else {
        const name = item.name; component(name); work.queuePath(name.length, 1); queue.push({ entry: item.entry, path: name });
      }
    }
    while (queue.length) {
      work.check(); const { entry, path } = queue.pop()!; work.unqueuePath(path);
      if (entry.isFile === entry.isDirectory) throw new Error('Invalid dropped entry kind.');
      if (entry.isFile) {
        const read = entry.file;
        if (typeof read !== 'function') throw new Error('The dropped file cannot be acquired.');
        work.add({ path, kind: 'file', getFile: () => new Promise((yes, no) => read.call(entry, yes, no)) });
      } else {
        work.add({ path, kind: 'directory' });
        const create = entry.createReader;
        if (typeof create !== 'function') throw new Error('The dropped directory cannot be read.');
        const reader = create.call(entry);
        for (;;) {
          work.check();
          // One outstanding directory callback. Cancellation joins its real
          // completion before the construction allowance can be released.
          const batch = await new Promise<Entry[]>((yes, no) => reader.readEntries(yes, no)); work.check();
          if (!Array.isArray(batch)) throw new Error('Invalid directory entry batch.');
          const batchCount = batch.length;
          if (!batchCount) break;
          work.reserveBatch(batchCount);
          for (let index = 0; index < batchCount; index++) {
            work.check(); const child = batch[index], name = child.name; component(name);
            const parent = collectionPathCensus(path);
            work.queuePath(path.length + 1 + name.length, parent.components + 1);
            const childPath = `${path}/${name}`;
            queue.push({ entry: child, path: childPath });
          }
          if (batch.length !== batchCount) throw new Error('Directory entries changed during preparation.');
        }
      }
    }
    result = await work.finish();
  } finally {
    try { work?.release(); } finally {
      owner.finish!();
      try { await snapshot.dispose(); } catch (error) {
        try { await result?.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Collection drop handoff and retirement failed.'); }
        throw error;
      }
    }
  }
  try { collectionCurrent(() => options.current()); result.assertCurrent(); return result; }
  catch (error) {
    try { await result.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Collection drop handoff and retirement failed.'); }
    throw error;
  }
}
