import { assertResourceCredit, resourceLeaseCredit, type ResourceCredit, type ResourceLease } from '../document/resources';
import { synchronousSourceHook } from '../document/source';

export type SogGroup = 'means' | 'scales' | 'quats' | 'sh0' | 'shN';
export type SogDeclaration = Readonly<{ group: SogGroup; index: number; reference: string }>;
export type SogMetadataLimits = Readonly<{
  maxBytes: number;
  maxDepth: number;
  maxTokens: number;
  maxStringUnits: number;
  maxTotalStringUnits: number;
  maxNumberCharacters: number;
}>;
export const DEFAULT_SOG_METADATA_LIMITS: SogMetadataLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024, maxDepth: 32, maxTokens: 65_536,
  maxStringUnits: 1_048_576, maxTotalStringUnits: 4_194_304, maxNumberCharacters: 128,
});
export type SogMetadataOptions = {
  /** Isolated authority contract: wrappers explicitly bind to a genuine ledger
   * reservation. The last materialization barrier invokes no caller getter. */
  admit(bytes: number): ResourceLease;
  current(): void;
  /** Overrides may only tighten the browser preparation ceilings. */
  limits?: Partial<SogMetadataLimits>;
};
export type SogMetadataStats = Readonly<{
  tokens: number;
  stringUnits: number;
  maxDepth: number;
  /** Text, grammar/graph/string work; excludes the separate 2*M copy owner. */
  parserBytes: number;
}>;
export type OwnedSogMetadataBytes = Readonly<{ readonly bytes: Uint8Array; dispose(): void }>;
export type PreparedSogMetadata = Readonly<{
  readonly byteLength: number;
  readonly version: 1 | 2;
  readonly sourceCount: number;
  /** null means legacy SH degree awaits the centroid texture dimensions. */
  readonly shDegree: 0 | 1 | 2 | 3 | null;
  readonly declarations: readonly SogDeclaration[];
  readonly stats: SogMetadataStats;
  assertCurrent(): void;
  /** The returned independent copy has its own admission/lifetime. */
  copyOriginal(options: Pick<SogMetadataOptions, 'admit' | 'current'>): OwnedSogMetadataBytes;
  dispose(): void;
}>;

const preparedOwners = new WeakMap<object, { current(): void; alive(): void; credit(): void }>();
/** Authenticate the factory-issued, still-current borrowed schema owner. */
export function assertPreparedSogMetadata(value: unknown): asserts value is PreparedSogMetadata {
  const owner = value !== null && typeof value === 'object' ? preparedOwners.get(value) : undefined;
  if (!owner) fail('metadata was not issued by the bounded parser');
  owner.current();
}
/** Final borrowed-owner barrier: private state only; invokes no hook/getter. */
export function assertPreparedSogMetadataAlive(value: unknown): asserts value is PreparedSogMetadata {
  const owner = value !== null && typeof value === 'object' ? preparedOwners.get(value) : undefined;
  if (!owner) fail('metadata was not issued by the bounded parser');
  owner.alive();
}
/** Final cross-owner credit barrier: authenticated registry state only. */
export function assertPreparedSogMetadataCredit(value: unknown): asserts value is PreparedSogMetadata {
  const owner = value !== null && typeof value === 'object' ? preparedOwners.get(value) : undefined;
  if (!owner) fail('metadata was not issued by the bounded parser');
  owner.credit();
}

const KiB = 1024;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedGet = (name: string, value: unknown): unknown =>
  Object.getOwnPropertyDescriptor(typedArray, name)!.get!.call(value);
function fail(message: string): never { throw new Error(`Invalid SOG metadata: ${message}`); }
function leaseBytes(lease: ResourceLease): unknown {
  const value = lease.bytes; synchronousSourceHook(value); return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sum(...values: number[]): number {
  let result = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(result + value))
      fail('allocation arithmetic overflow');
    result += value;
  }
  return result;
}
function hooks(options: Pick<SogMetadataOptions, 'admit' | 'current'>) {
  if (!record(options)) fail('missing ownership hooks');
  const admit: unknown = options.admit, current: unknown = options.current;
  if (typeof admit !== 'function' || typeof current !== 'function') fail('invalid ownership hooks');
  return {
    admit: (bytes: number) => Reflect.apply(admit, options, [bytes]) as ResourceLease,
    current: () => { synchronousSourceHook(Reflect.apply(current, options, [])); },
  };
}
function limitsOf(value: unknown): SogMetadataLimits {
  if (value === undefined) return DEFAULT_SOG_METADATA_LIMITS;
  if (!record(value)) fail('invalid parser limits');
  const result = { ...DEFAULT_SOG_METADATA_LIMITS };
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_SOG_METADATA_LIMITS, key)) fail('unknown parser limit');
    const next = value[key], name = key as keyof SogMetadataLimits;
    if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 1 ||
        next > DEFAULT_SOG_METADATA_LIMITS[name]) fail('parser limits may only tighten the ceilings');
    result[name] = next;
  }
  return Object.freeze(result);
}
function inputView(value: Uint8Array): { buffer: ArrayBuffer; offset: number; length: number } {
  const tag = Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)!.get!.call(value);
  if (tag !== 'Uint8Array') fail('original bytes must be a Uint8Array');
  const buffer = typedGet('buffer', value);
  const byteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!.call(buffer) as number;
  const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
  if (resizable?.call(buffer)) fail('resizable original bytes are not supported');
  // Constructing even an empty view rejects a detached backing buffer.
  new Uint8Array(buffer as ArrayBuffer, 0, 0);
  const offset = typedGet('byteOffset', value) as number, length = typedGet('byteLength', value) as number;
  if (!Number.isSafeInteger(length) || offset > byteLength || length > byteLength - offset)
    fail('invalid original byte range');
  return { buffer: buffer as ArrayBuffer, offset, length };
}

type Frame = { kind: 'array'; state: 'first' | 'value' | 'comma' } |
  { kind: 'object'; state: 'first' | 'key' | 'colon' | 'value' | 'comma' };
type Census = { tokens: number; stringUnits: number; maxDepth: number };

/** Iterative grammar validation. No keys/values or recursive JSON graph yet. */
function preflight(text: string, limits: SogMetadataLimits): Census {
  let index = 0, tokens = 0, stringUnits = 0, maxDepth = 0, root = false;
  const frames: Frame[] = [];
  const token = () => { if (++tokens > limits.maxTokens) fail('JSON token limit exceeded'); };
  const whitespace = () => {
    while (index < text.length && (text[index] === ' ' || text[index] === '\t' ||
      text[index] === '\r' || text[index] === '\n')) index++;
  };
  const hex = (at: number): number => {
    if (at + 4 > text.length) fail('truncated Unicode escape');
    let value = 0;
    for (let part = 0; part < 4; part++) {
      const unit = text.charCodeAt(at + part);
      const digit = unit >= 48 && unit <= 57 ? unit - 48 : unit >= 65 && unit <= 70 ? unit - 55 :
        unit >= 97 && unit <= 102 ? unit - 87 : -1;
      if (digit < 0) fail('invalid Unicode escape');
      value = value * 16 + digit;
    }
    return value;
  };
  const string = () => {
    if (text[index++] !== '"') fail('expected a JSON string');
    let units = 0, ended = false;
    while (index < text.length) {
      const unit = text.charCodeAt(index++);
      if (unit === 34) { ended = true; break; }
      if (unit < 32) fail('unescaped string control character');
      if (unit === 92) {
        const escape = text[index++];
        if (escape === 'u') {
          const point = hex(index); index += 4;
          if (point >= 0xd800 && point <= 0xdbff) {
            if (text[index] !== '\\' || text[index + 1] !== 'u') fail('unpaired escaped surrogate');
            const low = hex(index + 2);
            if (low < 0xdc00 || low > 0xdfff) fail('unpaired escaped surrogate');
            index += 6; units += 2;
          } else if (point >= 0xdc00 && point <= 0xdfff) fail('unpaired escaped surrogate');
          else units++;
        } else {
          if (escape === undefined || !'"\\/bfnrt'.includes(escape)) fail('invalid JSON escape');
          units++;
        }
      } else if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.charCodeAt(index++);
        if (low < 0xdc00 || low > 0xdfff) fail('unpaired Unicode surrogate');
        units += 2;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) fail('unpaired Unicode surrogate');
      else units++;
      if (units > limits.maxStringUnits || units > limits.maxTotalStringUnits - stringUnits)
        fail('decoded string limit exceeded');
    }
    if (!ended) fail('unterminated JSON string');
    stringUnits += units;
  };
  const number = () => {
    const start = index;
    if (text[index] === '-') index++;
    if (text[index] === '0') index++;
    else {
      if (!(text[index] >= '1' && text[index] <= '9')) fail('invalid JSON number');
      while (text[index] >= '0' && text[index] <= '9') index++;
    }
    if (text[index] === '.') {
      index++;
      if (!(text[index] >= '0' && text[index] <= '9')) fail('invalid JSON fraction');
      while (text[index] >= '0' && text[index] <= '9') index++;
    }
    if (text[index] === 'e' || text[index] === 'E') {
      index++;
      if (text[index] === '+' || text[index] === '-') index++;
      if (!(text[index] >= '0' && text[index] <= '9')) fail('invalid JSON exponent');
      while (text[index] >= '0' && text[index] <= '9') index++;
    }
    if (index - start > limits.maxNumberCharacters) fail('numeric token limit exceeded');
    if (!Number.isFinite(Number(text.slice(start, index)))) fail('nonfinite JSON number');
  };
  const value = () => {
    token();
    const next = text[index];
    if (next === '{' || next === '[') {
      if (frames.length + 1 > limits.maxDepth) fail('container depth limit exceeded');
      frames.push(next === '{' ? { kind: 'object', state: 'first' } : { kind: 'array', state: 'first' });
      maxDepth = Math.max(maxDepth, frames.length); index++;
    } else if (next === '"') string();
    else if (next === '-' || (next >= '0' && next <= '9')) number();
    else {
      const literal = next === 't' ? 'true' : next === 'f' ? 'false' : next === 'n' ? 'null' : '';
      if (!literal || !text.startsWith(literal, index)) fail('expected a JSON value');
      index += literal.length;
    }
  };
  while (true) {
    whitespace();
    if (!root) { root = true; value(); continue; }
    const frame = frames.at(-1);
    if (!frame) {
      if (index !== text.length) fail('trailing JSON data');
      return { tokens, stringUnits, maxDepth };
    }
    const next = text[index];
    if (frame.kind === 'array') {
      if (frame.state === 'first' && next === ']') { frames.pop(); index++; }
      else if (frame.state === 'first' || frame.state === 'value') { frame.state = 'comma'; value(); }
      else if (next === ',') { frame.state = 'value'; index++; }
      else if (next === ']') { frames.pop(); index++; }
      else fail('expected array comma or closing bracket');
    } else if (frame.state === 'first' && next === '}') { frames.pop(); index++; }
    else if (frame.state === 'first' || frame.state === 'key') { token(); string(); frame.state = 'colon'; }
    else if (frame.state === 'colon') {
      if (next !== ':') fail('expected object colon');
      frame.state = 'value'; index++;
    } else if (frame.state === 'value') { frame.state = 'comma'; value(); }
    else if (next === ',') { frame.state = 'key'; index++; }
    else if (next === '}') { frames.pop(); index++; }
    else fail('expected object comma or closing brace');
  }
}

function field(value: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
  return value[key];
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!record(value)) fail(`${label} must be an object`);
  return value;
}
function numeric(value: unknown, label: string): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be numeric`);
  return value;
}
/** Match bounded generic native numeric/bool conversion before schema range checks. */
function integer(value: unknown, low: number, high: number, label: string): number {
  const converted = Math.trunc(numeric(value, label));
  if (!Number.isSafeInteger(converted) || converted < low || converted > high) fail(`${label} is out of range`);
  return converted;
}
/** Source counts and captured Windows size_t palette counts accept numeric
 * JSON kinds, but reject booleans before finite/truncated range checks. */
function sourceInteger(value: unknown, low: number, high: number, label: string): number {
  if (typeof value !== 'number') fail(`${label} must be numeric`);
  return integer(value, low, high, label);
}
function float(value: unknown, label: string, finite = true): number {
  const converted = Math.fround(numeric(value, label));
  if (finite && !Number.isFinite(converted)) fail(`${label} is not finite float32`);
  return converted;
}
function range(group: Record<string, unknown>, size: number, label: string, coordinate = false): void {
  const mins = field(group, 'mins'), maxs = field(group, 'maxs');
  if (!Array.isArray(mins) || !Array.isArray(maxs) || mins.length !== size || maxs.length !== size)
    fail(`${label} has invalid bounds`);
  for (let index = 0; index < size; index++) {
    const low = float(mins[index], label), high = float(maxs[index], label);
    if (low > high || (coordinate && (Math.abs(low) > 40 || Math.abs(high) > 40)))
      fail(`${label} has invalid bounds`);
  }
}
function codebook(group: Record<string, unknown>, label: string): void {
  const values = field(group, 'codebook');
  if (!Array.isArray(values) || values.length < 1 || values.length > 256) fail(`${label} has invalid codebook size`);
  // Native checks float32 finiteness only for entries indexed by decoded pixels.
  // Preserve this deferred condition instead of rejecting unused overflow entries.
  for (const value of values) float(value, label, false);
}
function normalize(value: unknown) {
  const root = object(value, 'root');
  const version = Object.hasOwn(root, 'version') ? integer(root.version, -0x8000_0000, 0x7fff_ffff, 'version') : 1;
  if (version !== 1 && version !== 2) fail('only versions 1 and 2 are supported');
  const declarations: SogDeclaration[] = [];
  const groups = new Map<SogGroup, Record<string, unknown>>();
  for (const name of ['means', 'scales', 'quats', 'sh0', 'shN'] as const) {
    if (name === 'shN' && (!Object.hasOwn(root, name) || root[name] === null)) continue;
    const group = object(field(root, name), name), files = field(group, 'files');
    const minimum = name === 'means' || name === 'shN' ? 2 : 1;
    if (!Array.isArray(files) || files.length < minimum || files.length > 8) fail(`${name} has invalid files`);
    for (let index = 0; index < files.length; index++) {
      if (typeof files[index] !== 'string') fail(`${name} filenames must be strings`);
      declarations.push(Object.freeze({ group: name, index, reference: files[index] as string }));
    }
    groups.set(name, group);
  }
  const means = groups.get('means')!;
  let sourceCount: number;
  if (version === 1) {
    const shape = field(means, 'shape');
    if (!Array.isArray(shape) || shape.length !== 2 || sourceInteger(shape[1], 0, Number.MAX_SAFE_INTEGER, 'shape width') !== 3)
      fail('invalid legacy position shape');
    sourceCount = sourceInteger(shape[0], 1, 10_000_000, 'source count');
  } else sourceCount = sourceInteger(field(root, 'count'), 1, 10_000_000, 'source count');
  range(means, 3, 'position', true);
  if (version === 1) { range(groups.get('scales')!, 3, 'scale'); range(groups.get('sh0')!, 4, 'color'); }
  else { codebook(groups.get('scales')!, 'scale'); codebook(groups.get('sh0')!, 'color'); }
  const sh = groups.get('shN');
  let shDegree: 0 | 1 | 2 | 3 | null = 0;
  if (sh && version === 1) {
    const low = float(field(sh, 'mins'), 'SH bounds'), high = float(field(sh, 'maxs'), 'SH bounds');
    if (low > high) fail('invalid legacy SH bounds');
    shDegree = null;
  } else if (sh) {
    shDegree = integer(field(sh, 'bands'), 1, 3, 'SH bands') as 1 | 2 | 3;
    sourceInteger(field(sh, 'count'), 1, 65_536, 'SH palette'); codebook(sh, 'SH');
  }
  return { version: version as 1 | 2, sourceCount, shDegree, declarations: Object.freeze(declarations) };
}

/**
 * Pure, bounded metadata preparation. No texture reads, hashing, decoder or VFS.
 * The graph owner may borrow this descriptor only while it remains current/alive.
 * A conservative 2*M reservation covers caller/private-copy overlap; the full
 * parser allowance remains owned through dispose, including retained strings.
 */
export function parseSogMetadata(bytes: Uint8Array, options: SogMetadataOptions): PreparedSogMetadata {
  const configured = hooks(options), limits = limitsOf(options.limits), input = inputView(bytes), M = input.length;
  if (M > limits.maxBytes) fail('metadata byte limit exceeded');
  const owned = new Map<ResourceLease, { credit: ResourceCredit; bytes: number }>();
  const issuedCredits = new WeakSet<ResourceCredit>();
  const parserLeases: { lease: ResourceLease; bytes: number }[] = [];
  const reserve = (admit: SogMetadataOptions['admit'], amount: number): ResourceLease => {
    const lease = admit(amount);
    if (typeof lease !== 'function') { synchronousSourceHook(lease); fail('admission did not return a lease'); }
    if (owned.has(lease)) fail('admission reused an owned lease');
    let credit: ResourceCredit;
    try { credit = resourceLeaseCredit(lease); }
    catch (error) {
      try { synchronousSourceHook(lease()); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Unbound SOG parser admission cleanup failed.'); }
      throw error;
    }
    if (issuedCredits.has(credit)) fail('admission reused an owned credit');
    let accepted = false;
    try {
      // Capture callable ownership before inspecting then/bytes/resize getters.
      synchronousSourceHook(lease);
      const observed = leaseBytes(lease), resize = lease.resize; synchronousSourceHook(resize);
      if (observed !== amount || typeof resize !== 'function') fail('invalid admission lease');
      assertResourceCredit(credit, amount);
      owned.set(lease, { credit, bytes: amount }); issuedCredits.add(credit); accepted = true; return lease;
    } finally { if (!accepted) synchronousSourceHook(lease()); }
  };
  const release = (lease: ResourceLease) => { if (owned.delete(lease)) synchronousSourceHook(lease()); };
  const reserveParser = (amount: number) => { parserLeases.push({ lease: reserve(configured.admit, amount), bytes: amount }); };
  let original: Uint8Array | undefined, fields: ReturnType<typeof normalize> | undefined;
  let stats: SogMetadataStats | undefined, closed = false;
  const assertAlive = () => {
    if (closed) fail('metadata owner is disposed');
    for (const { lease } of parserLeases) if (!owned.has(lease)) fail('metadata ownership is retired');
  };
  const assertOwnedCredit = (lease: ResourceLease, bytes: number) => {
    const state = owned.get(lease);
    if (!state || state.bytes !== bytes) fail('metadata ownership is retired');
    assertResourceCredit(state.credit, bytes);
  };
  const creditBarrier = () => {
    for (const { lease, bytes } of parserLeases) assertOwnedCredit(lease, bytes);
    assertAlive();
  };
  const assertCredits = () => {
    assertAlive();
    for (const { lease, bytes } of parserLeases) {
      if (leaseBytes(lease) !== bytes) fail('metadata admission credit changed');
    }
    // A later arbitrary getter can retire an already checked earlier credit.
    creditBarrier();
  };
  const assertCurrent = () => {
    assertCredits();
    configured.current();
    assertCredits();
  };
  const dispose = () => {
    if (closed) return;
    closed = true; original = undefined; fields = undefined; stats = undefined;
    // Separately admitted original-byte copies belong to their callers and
    // remain valid/charged independently of this preparation owner.
    let failure: unknown, failed = false;
    for (const { lease } of parserLeases) {
      try { release(lease); } catch (error) { if (!failed) failure = error; failed = true; }
    }
    parserLeases.length = 0;
    if (failed) throw failure;
  };
  try {
    assertCurrent(); reserveParser(sum(M, M)); assertCurrent();
    original = new Uint8Array(M);
    Uint8Array.prototype.set.call(original, new Uint8Array(input.buffer, input.offset, M));
    assertCurrent();
    const textBytes = sum(M, M, 64 * KiB);
    reserveParser(textBytes); assertCurrent();
    let text = new TextDecoder('utf-8', { fatal: true }).decode(original);
    const census = preflight(text, limits); assertCurrent();
    const graphBytes = sum(census.tokens * 256, census.stringUnits * 2);
    reserveParser(graphBytes); assertCurrent();
    let graph: unknown = JSON.parse(text);
    fields = normalize(graph); graph = undefined; text = '';
    stats = Object.freeze({ ...census, parserBytes: sum(textBytes, graphBytes) });
    assertCurrent();
    const prepared = Object.freeze({
      get byteLength() { assertCurrent(); return M; },
      get version() { assertCurrent(); return fields!.version; },
      get sourceCount() { assertCurrent(); return fields!.sourceCount; },
      get shDegree() { assertCurrent(); return fields!.shDegree; },
      get declarations() { assertCurrent(); return fields!.declarations; },
      get stats() { assertCurrent(); return stats!; },
      assertCurrent,
      copyOriginal(copyOptions: Pick<SogMetadataOptions, 'admit' | 'current'>): OwnedSogMetadataBytes {
        const copyHooks = hooks(copyOptions);
        assertCurrent(); copyHooks.current();
        const lease = reserve(copyHooks.admit, M);
        let copy: Uint8Array | undefined;
        const assertCopyCredit = () => {
          if (!owned.has(lease) || leaseBytes(lease) !== M) fail('original-byte copy admission credit changed');
        };
        const copyBarrier = () => { assertOwnedCredit(lease, M); creditBarrier(); };
        try {
          assertCurrent(); copyHooks.current(); assertCurrent(); assertCopyCredit(); copyBarrier();
          copy = new Uint8Array(M);
          Uint8Array.prototype.set.call(copy, original!);
          assertCurrent(); copyHooks.current(); assertCurrent(); assertCopyCredit(); copyBarrier();
          return Object.freeze({
            get bytes() {
              if (!copy) fail('original-byte copy is disposed');
              // Independent copies remain owned if the parser is disposed.
              assertCopyCredit();
              copyHooks.current();
              assertCopyCredit();
              assertOwnedCredit(lease, M);
              if (!copy) fail('original-byte copy is disposed');
              return copy;
            },
            dispose() { if (!copy) return; copy = undefined; release(lease); },
          });
        } catch (error) { copy = undefined; release(lease); throw error; }
      },
      dispose,
    });
    preparedOwners.set(prepared, { current: assertCurrent, alive: assertAlive, credit: creditBarrier });
    return prepared;
  } catch (error) { dispose(); throw error; }
}
