/**
 * Source-resource paths are relative to the selected asset root. The root's
 * display name is deliberately not an identity component. Neither Unicode
 * normalization nor case folding is appropriate for these content keys.
 */

const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Read array length and numeric entries once; custom iterators are not paths. */
function snapshotPathArray(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) throw new TypeError(`${label} must be an array`);
  const count = values.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > 0xffff_ffff) {
    throw new RangeError(`${label} has an invalid array length`);
  }
  const snapshot: string[] = [];
  for (let index = 0; index < count; index++) snapshot.push(values[index]!);
  return snapshot;
}

/** Reject strings that TextEncoder would silently change to U+FFFD. */
export function assertWellFormedPathString(value: string): void {
  if (typeof value !== 'string') throw new TypeError('A resource path must be a string');
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) throw new Error('A resource path cannot contain a null character');
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error('A resource path contains an unpaired surrogate');
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('A resource path contains an unpaired surrogate');
    }
  }
}

/**
 * Accept actual filename components obtained during acquisition, never a
 * metadata reference. A literal backslash filename is ambiguous with metadata
 * separators and is refused here even on filesystems that can represent it.
 */
export function canonicalAcquiredPath(components: readonly string[]): string {
  const acquired = snapshotPathArray(components, 'Acquired filename components');
  if (acquired.length === 0) {
    throw new Error('An acquired resource needs at least one path component');
  }
  for (const component of acquired) {
    assertWellFormedPathString(component);
    if (component.length === 0 || component === '.' || component === '..') {
      throw new Error('An acquired resource has an empty or relative path component');
    }
    if (component.includes('/') || component.includes('\\')) {
      throw new Error('An acquired filename component cannot contain a path separator');
    }
  }
  return acquired.join('/');
}

/** Validate an already acquired slash-separated relative path without fixing it. */
export function assertCanonicalAcquiredPath(path: string): void {
  assertWellFormedPathString(path);
  if (canonicalAcquiredPath(path.split('/')) !== path) {
    throw new Error('The acquired resource path is not canonical');
  }
}

/**
 * A valid UTF-8 encoding preserves scalar-value order. Comparing code points
 * gives precisely byte-lexicographic UTF-8 order without allocating path-sized
 * encoded buffers (UTF-16's built-in string ordering would be incorrect).
 */
export function compareUtf8Paths(left: string, right: string): number {
  assertWellFormedPathString(left);
  assertWellFormedPathString(right);
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!;
    const rightPoint = right.codePointAt(rightIndex)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
    leftIndex += leftPoint > 0xffff ? 2 : 1;
    rightIndex += rightPoint > 0xffff ? 2 : 1;
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0;
  return leftIndex === left.length ? -1 : 1;
}

/** Reject duplicate acquisition entries before a Set can hide an ambiguity. */
export function validateAcquiredPaths(paths: readonly string[]): ReadonlySet<string> {
  const acquired = snapshotPathArray(paths, 'Acquired resource paths');
  const unique = new Set<string>();
  for (const path of acquired) {
    assertCanonicalAcquiredPath(path);
    if (unique.has(path)) throw new Error(`Duplicate acquired resource path: ${path}`);
    unique.add(path);
  }
  for (const path of unique) {
    for (let separator = path.indexOf('/'); separator >= 0; separator = path.indexOf('/', separator + 1)) {
      if (unique.has(path.slice(0, separator))) {
        throw new Error(`An acquired file path is also a directory path: ${path.slice(0, separator)}`);
      }
    }
  }
  return unique;
}

/**
 * Resolve only metadata references. Backslash conversion must never be applied
 * to acquired filenames. Reject absolute/URL forms before conversion, then
 * resolve relative to the metadata file's parent within the selected root.
 * Percent escapes, case, whitespace and Unicode code points remain literal.
 */
export function resolveMetadataReference(metadataPath: string, reference: string): string {
  assertCanonicalAcquiredPath(metadataPath);
  assertWellFormedPathString(reference);
  if (reference.length === 0) throw new Error('A metadata reference cannot be empty');
  if (reference.startsWith('/') || reference.startsWith('\\') || URI_SCHEME.test(reference)) {
    throw new Error('An absolute path or URL cannot be a metadata resource reference');
  }

  const components = metadataPath.split('/');
  components.pop();
  for (const component of reference.replaceAll('\\', '/').split('/')) {
    if (component.length === 0 || component === '.') continue;
    if (component === '..') {
      if (components.length === 0) throw new Error('A metadata reference escapes the selected asset root');
      components.pop();
    } else {
      // Input validation above already covers Unicode and null characters.
      components.push(component);
    }
  }
  if (components.length === 0) throw new Error('A metadata reference resolves to the asset root');
  return canonicalAcquiredPath(components);
}

/**
 * Return the primary metadata and its referenced resources once, in canonical
 * order. Unrelated selected neighbors are excluded; missing resources and
 * duplicate acquisition entries are errors, rather than guessed aliases.
 */
export function resolveAssetResourcePaths(
  metadataPath: string,
  references: readonly string[],
  acquiredPaths: readonly string[],
): readonly string[] {
  const acquired = validateAcquiredPaths(acquiredPaths);
  assertCanonicalAcquiredPath(metadataPath);
  if (!acquired.has(metadataPath)) throw new Error('The primary metadata resource was not acquired');
  const referenced = snapshotPathArray(references, 'Metadata references');
  const included = new Set<string>([metadataPath]);
  for (const reference of referenced) {
    const path = resolveMetadataReference(metadataPath, reference);
    if (!acquired.has(path)) throw new Error(`A referenced resource was not acquired: ${path}`);
    included.add(path);
  }
  return [...included].sort(compareUtf8Paths);
}
