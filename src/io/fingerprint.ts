import { assertCanonicalAcquiredPath, compareUtf8Paths, validateAcquiredPaths } from './paths.ts';

export const SOURCE_FINGERPRINT_SCHEME = 'splatview-source-v1' as const;
export const MAX_CANONICAL_SEGMENT_BYTES = 1024 * 1024;

// Use the intrinsic length: a typed array can shadow its public length getter.
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), 'length',
)!.get!;

export interface SourceResourceDigest {
  readonly path: string;
  readonly role: 'primary' | 'referenced';
  /** File.size and the admitted cumulative size must be exact safe integers. */
  readonly byteLength: number;
  readonly sha256: Uint8Array;
}

export interface SourceFingerprintInput {
  readonly kind: 'single' | 'group';
  readonly resources: readonly SourceResourceDigest[];
}

export interface SourceFingerprintSummary {
  readonly scheme: typeof SOURCE_FINGERPRINT_SCHEME;
  readonly resourceCount: number;
  readonly totalBytes: number;
}

export interface PreparedCanonicalSource extends SourceFingerprintSummary {
  /** Exact v1 encoding size, available before beginning an incremental hash. */
  readonly canonicalByteLength: number;
  /** Each write emits the same snapshot in independently owned segments. */
  readonly write: (
    consume: (segment: Uint8Array) => unknown,
    maxSegmentBytes?: number,
  ) => SourceFingerprintSummary;
}

export interface SourceFingerprint extends SourceFingerprintSummary {
  /** Lowercase SHA-256 of the canonical asset encoding, not a resource digest. */
  readonly assetDigest: string;
  /** A revalidated source-format hint, excluded from the content digest. */
  readonly sourceKindHint: string;
}

interface PreparedResource {
  readonly path: string;
  readonly pathBytes: number;
  readonly primary: boolean;
  readonly byteLength: number;
  readonly digest: Uint8Array;
}

function checkedSize(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function checkedSum(left: number, right: number, label: string): number {
  return checkedSize(left + right, label);
}

function checkedUint32(value: number, label: string): number {
  checkedSize(value, label);
  if (value > 0xffff_ffff) throw new RangeError(`${label} exceeds uint32`);
  return value;
}

function snapshotSha256(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || typedArrayLength.call(value) !== 32) {
    throw new Error(`${label} SHA-256 digest must contain exactly 32 bytes`);
  }
  // Typed-array construction copies actual indexed bytes, not a custom iterator.
  return new Uint8Array(value);
}

function pathByteLength(path: string): number {
  let length = 0;
  for (const character of path) {
    const point = character.codePointAt(0)!;
    const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    length = checkedUint32(length + bytes, 'The resource path byte length');
  }
  return length;
}

function validateConsumer(
  consume: (segment: Uint8Array) => unknown,
  maxSegmentBytes: number,
): void {
  if (typeof consume !== 'function') throw new TypeError('A canonical byte consumer is required');
  if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1 ||
      maxSegmentBytes > MAX_CANONICAL_SEGMENT_BYTES) {
    throw new RangeError('The canonical segment limit must be between 1 byte and 1 MiB');
  }
}

/**
 * Validate and snapshot the descriptor once, without encoding a whole table or
 * allocating a path-sized UTF-8 buffer. The frozen public result exposes only
 * scalar metadata and a writer over private copied digests and validated paths.
 * Input mutations and failed writes cannot change subsequent writes.
 *
 * The worker/controller remains responsible for matching this descriptor to its
 * candidate and publishing only after the final asset hash completes.
 */
export function prepareCanonicalSource(input: SourceFingerprintInput): PreparedCanonicalSource {
  if (!input) throw new Error('A source fingerprint input is required');
  const kind = input.kind;
  if (kind !== 'single' && kind !== 'group') {
    throw new Error('The source asset kind must be single or group');
  }
  const suppliedResources = input.resources;
  if (!Array.isArray(suppliedResources)) throw new TypeError('Source resources must be an array');
  const resourceCount = checkedUint32(suppliedResources.length, 'The source resource count');
  if (resourceCount === 0) throw new Error('A source asset needs a primary resource');
  if (kind === 'single' && resourceCount !== 1) {
    throw new Error('A single-file source requires exactly one resource');
  }
  const suppliedSnapshot: SourceResourceDigest[] = [];
  for (let index = 0; index < resourceCount; index++) {
    suppliedSnapshot.push(suppliedResources[index]!);
  }

  let totalBytes = 0;
  let canonicalBytes = 24; // 19-byte prefix, one kind byte, uint32 count.
  let primaryCount = 0;
  const paths = new Set<string>();
  const resources: PreparedResource[] = [];
  for (const resource of suppliedSnapshot) {
    if (!resource) throw new Error('A source resource descriptor is required');
    const path = resource.path;
    const role = resource.role;
    const suppliedByteLength = resource.byteLength;
    const suppliedDigest = resource.sha256;
    if (role !== 'primary' && role !== 'referenced') {
      throw new Error('A source resource role must be primary or referenced');
    }
    if (typeof path !== 'string') throw new TypeError('A resource path must be a string');
    if (kind === 'single') {
      if (path !== '') throw new Error('A single-file resource requires an empty logical path');
    } else {
      assertCanonicalAcquiredPath(path);
    }
    if (paths.has(path)) throw new Error(`Duplicate source resource path: ${path}`);
    paths.add(path);
    const byteLength = checkedSize(suppliedByteLength, 'The resource file byte length');
    totalBytes = checkedSum(totalBytes, byteLength, 'The total resource byte length');
    const digest = snapshotSha256(suppliedDigest, 'A resource');
    const pathBytes = pathByteLength(path);
    canonicalBytes = checkedSum(canonicalBytes, 45 + pathBytes, 'The canonical encoding byte length');
    const primary = role === 'primary';
    if (primary) primaryCount++;
    resources.push({ path, pathBytes, primary, byteLength, digest });
  }
  if (primaryCount !== 1) throw new Error('A source asset requires exactly one primary resource');
  if (kind === 'group') validateAcquiredPaths(resources.map((resource) => resource.path));
  resources.sort((left, right) => compareUtf8Paths(left.path, right.path));

  return Object.freeze({
    scheme: SOURCE_FINGERPRINT_SCHEME,
    resourceCount,
    totalBytes,
    canonicalByteLength: canonicalBytes,
    write(consume: (segment: Uint8Array) => unknown,
      maxSegmentBytes = MAX_CANONICAL_SEGMENT_BYTES): SourceFingerprintSummary {
      validateConsumer(consume, maxSegmentBytes);
      return emitCanonicalSource(kind, resources, canonicalBytes, resourceCount, totalBytes,
        consume, maxSegmentBytes);
    },
  });
}

function emitCanonicalSource(
  kind: SourceFingerprintInput['kind'],
  resources: readonly PreparedResource[],
  canonicalBytes: number,
  resourceCount: number,
  totalBytes: number,
  consume: (segment: Uint8Array) => unknown,
  maxSegmentBytes: number,
): SourceFingerprintSummary {
  const capacity = Math.min(maxSegmentBytes, canonicalBytes);
  let buffer = new Uint8Array(capacity);
  let used = 0;
  function flush(): void {
    if (used === 0) return;
    const emitted = used === buffer.length ? buffer : buffer.slice(0, used);
    const result = consume(emitted);
    if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
      const then = (result as { then?: unknown }).then;
      if (typeof then === 'function') {
        // Refuse async consumption but observe its rejection so refusal cannot
        // also produce an unhandled rejection. The captured then is read once.
        void new Promise<unknown>((resolve, reject) => {
          Reflect.apply(then, result, [resolve, reject]);
        }).catch(() => undefined);
        throw new TypeError('The canonical byte consumer must complete synchronously');
      }
    }
    buffer = new Uint8Array(capacity);
    used = 0;
  }
  function byte(value: number): void {
    buffer[used++] = value;
    if (used === buffer.length) flush();
  }
  function uint32(value: number): void {
    byte(Math.floor(value / 0x1_000000) & 0xff);
    byte(Math.floor(value / 0x1_0000) & 0xff);
    byte(Math.floor(value / 0x100) & 0xff);
    byte(value & 0xff);
  }
  function uint64(value: number): void {
    const integer = BigInt(value);
    for (let shift = 56n; shift >= 0n; shift -= 8n) byte(Number((integer >> shift) & 0xffn));
  }
  function utf8(value: string): void {
    for (const character of value) {
      const point = character.codePointAt(0)!;
      if (point <= 0x7f) {
        byte(point);
      } else if (point <= 0x7ff) {
        byte(0xc0 | (point >> 6)); byte(0x80 | (point & 0x3f));
      } else if (point <= 0xffff) {
        byte(0xe0 | (point >> 12)); byte(0x80 | ((point >> 6) & 0x3f)); byte(0x80 | (point & 0x3f));
      } else {
        byte(0xf0 | (point >> 18)); byte(0x80 | ((point >> 12) & 0x3f));
        byte(0x80 | ((point >> 6) & 0x3f)); byte(0x80 | (point & 0x3f));
      }
    }
  }

  utf8('SplatViewSource\0v1\0');
  byte(kind === 'single' ? 0 : 1);
  uint32(resourceCount);
  for (const resource of resources) {
    byte(resource.primary ? 1 : 0);
    uint32(resource.pathBytes);
    utf8(resource.path);
    uint64(resource.byteLength);
    for (const digestByte of resource.digest) byte(digestByte);
  }
  flush();
  return { scheme: SOURCE_FINGERPRINT_SCHEME, resourceCount, totalBytes };
}

/**
 * Emit the exact v1 canonical encoding. The consumer must finish synchronously
 * with each independently owned segment; throws propagate and stop emission.
 */
export function writeCanonicalSource(
  input: SourceFingerprintInput,
  consume: (segment: Uint8Array) => unknown,
  maxSegmentBytes = MAX_CANONICAL_SEGMENT_BYTES,
): SourceFingerprintSummary {
  // Preserve refusal before reading an untrusted descriptor in the legacy API.
  validateConsumer(consume, maxSegmentBytes);
  return prepareCanonicalSource(input).write(consume, maxSegmentBytes);
}

/** Complete the portable/storage identity after an independent SHA-256 final. */
export function finishSourceFingerprint(
  summary: SourceFingerprintSummary,
  assetDigest: Uint8Array,
  sourceKindHint: string,
): SourceFingerprint {
  if (!summary) throw new Error('A source fingerprint summary is required');
  const scheme = summary.scheme;
  const resourceCount = summary.resourceCount;
  const totalBytes = summary.totalBytes;
  if (scheme !== SOURCE_FINGERPRINT_SCHEME) {
    throw new Error('The source fingerprint scheme is unsupported');
  }
  if (checkedUint32(resourceCount, 'The source resource count') === 0) {
    throw new Error('A source fingerprint requires at least one resource');
  }
  checkedSize(totalBytes, 'The total resource byte length');
  const digest = snapshotSha256(assetDigest, 'An asset');
  if (typeof sourceKindHint !== 'string' || sourceKindHint.length === 0) {
    throw new Error('A source-kind hint is required');
  }
  let hex = '';
  for (const digestByte of digest) hex += digestByte.toString(16).padStart(2, '0');
  return { scheme: SOURCE_FINGERPRINT_SCHEME, assetDigest: hex,
    resourceCount, totalBytes, sourceKindHint };
}
