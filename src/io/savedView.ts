import type { BackgroundColor } from '../input/background';
import { SOURCE_FINGERPRINT_SCHEME, type SourceFingerprint } from './fingerprint';

/** Desktop metadata/thumbnail limits, not a promise of browser storage quota. */
export const MAX_SAVED_VIEW_RECORD_BYTES = 8192;
export const MAX_SAVED_THUMBNAIL_BYTES = 16 * 1024 * 1024;
const CAMERA_BOUND = Math.fround(1e12);
const PITCH_BOUND = Math.fround(1.5707964);

export interface SavedView {
  readonly target: readonly [number, number, number];
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly radius: number;
  readonly fov: number;
  readonly yUp: boolean;
  readonly roll: number;
  readonly background: BackgroundColor;
}

export interface SavedViewRecord {
  readonly kind: 'splatview-saved-view';
  readonly schemaVersion: 1;
  readonly recordId: string;
  readonly appVersion: string;
  /** Milliseconds since the Unix epoch; display metadata, never source identity. */
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly source: SourceFingerprint;
  readonly sourceKind: 'gaussian' | 'points' | 'mesh';
  readonly view: SavedView;
  readonly thumbnail: Readonly<{ type: 'image/png'; width: number; height: number; byteLength: number; sha256: string }>;
  readonly displayName: string;
}

export type SavedViewCameraState = [number, number, number, number, number, number, number, number, number, number, number];
export interface ThumbnailPlan {
  readonly x: number;
  readonly y: number;
  /** Side of the original crop; width/height describe the downsampled result. */
  readonly side: number;
  readonly width: number;
  readonly height: number;
}

function invalid(label: string): never { throw new Error(`Invalid saved view: ${label}`); }

/** Accept inert JSON-like data only; never invoke an input accessor. */
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('object expected');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid('plain object expected');
  const keys = Reflect.ownKeys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) invalid('record fields');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) invalid('unknown field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid('data field expected');
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) invalid('missing field');
  return result;
}

function array(value: unknown, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length || Reflect.ownKeys(value).length !== length + 1)
    invalid('camera array length');
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid('camera data entry');
    return descriptor.value;
  });
}

function text(value: unknown, label: string, maximum = MAX_SAVED_VIEW_RECORD_BYTES, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.length === 0) || value.length > maximum) invalid(label);
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(`${label} Unicode`);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid(`${label} Unicode`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(label);
  return value;
}

function scalar(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(label);
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded) || Math.abs(rounded) > CAMERA_BOUND) invalid(label);
  return rounded;
}

function positive(value: unknown, label: string): number {
  const result = scalar(value, label);
  if (result <= 0) invalid(label);
  return result;
}

function background(value: unknown): BackgroundColor {
  if (value !== 'black' && value !== 'gray' && value !== 'white') invalid('background');
  return value;
}

function fingerprint(value: unknown): Readonly<SourceFingerprint> {
  const fields = object(value, ['scheme', 'assetDigest', 'resourceCount', 'totalBytes', 'sourceKindHint']);
  if (fields.scheme !== SOURCE_FINGERPRINT_SCHEME) invalid('source scheme');
  return Object.freeze({ scheme: SOURCE_FINGERPRINT_SCHEME, assetDigest: hash(fields.assetDigest),
    resourceCount: integer(fields.resourceCount, 'source resource count', 1, 0xffff_ffff),
    totalBytes: integer(fields.totalBytes, 'source total bytes'),
    sourceKindHint: text(fields.sourceKindHint, 'source kind hint', 128) });
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid('SHA-256');
  return value;
}

function sourceKind(value: unknown): SavedViewRecord['sourceKind'] {
  if (value !== 'gaussian' && value !== 'points' && value !== 'mesh') invalid('decoded source kind');
  return value;
}

function view(value: unknown): SavedView {
  const fields = object(value, ['target', 'yaw', 'pitch', 'distance', 'radius', 'fov', 'yUp', 'roll'], ['background']);
  const target = array(fields.target, 3).map((value, index) => scalar(value, `target${index}`)) as [number, number, number];
  const pitch = scalar(fields.pitch, 'pitch'), fov = scalar(fields.fov, 'FOV');
  if (Math.abs(pitch) > PITCH_BOUND || fov < 10 || fov > 120 || typeof fields.yUp !== 'boolean') invalid('camera range');
  return Object.freeze({ target: Object.freeze(target), yaw: scalar(fields.yaw, 'yaw'), pitch,
    distance: positive(fields.distance, 'distance'), radius: positive(fields.radius, 'radius'), fov,
    yUp: fields.yUp, roll: scalar(fields.roll, 'roll'),
    // Explicit older-metadata migration; present undefined/null values refuse.
    background: Object.hasOwn(fields, 'background') ? background(fields.background) : 'black' });
}

function stringBytes(value: string): number {
  let bytes = 2; // JSON quotation marks.
  for (const character of value) {
    const point = character.codePointAt(0)!;
    bytes += point < 0x20 ? (point === 8 || point === 9 || point === 10 || point === 12 || point === 13 ? 2 : 6)
      : point === 34 || point === 92 ? 2 : point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Exact JSON.stringify UTF-8 length over our bounded, inert, private snapshot. */
function jsonBytes(value: unknown): number {
  if (typeof value === 'string') return stringBytes(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + jsonBytes(item), 0);
  const entries = Object.entries(value as object);
  return 2 + Math.max(0, entries.length - 1) + entries.reduce((sum, [key, item]) => sum + stringBytes(key) + 1 + jsonBytes(item), 0);
}

/** Validate and privately freeze one complete record; unsupported schemas refuse. */
export function validateSavedViewRecord(value: unknown): SavedViewRecord {
  const fields = object(value, ['kind', 'schemaVersion', 'recordId', 'appVersion', 'createdAt', 'updatedAt',
    'source', 'sourceKind', 'view', 'thumbnail', 'displayName']);
  if (fields.kind !== 'splatview-saved-view' || fields.schemaVersion !== 1) invalid('kind/schema version');
  const createdAt = integer(fields.createdAt, 'created timestamp'), updatedAt = integer(fields.updatedAt, 'updated timestamp');
  if (updatedAt < createdAt) invalid('timestamp order');
  const image = object(fields.thumbnail, ['type', 'width', 'height', 'byteLength', 'sha256']);
  const width = integer(image.width, 'thumbnail width', 1, 1024), height = integer(image.height, 'thumbnail height', 1, 1024);
  if (image.type !== 'image/png' || width !== height) invalid('square PNG thumbnail');
  const record: SavedViewRecord = Object.freeze({ kind: 'splatview-saved-view', schemaVersion: 1,
    recordId: text(fields.recordId, 'record ID'), appVersion: text(fields.appVersion, 'application version'),
    createdAt, updatedAt, source: fingerprint(fields.source), sourceKind: sourceKind(fields.sourceKind),
    view: view(fields.view), thumbnail: Object.freeze({ type: 'image/png', width, height,
      byteLength: integer(image.byteLength, 'thumbnail bytes', 1, MAX_SAVED_THUMBNAIL_BYTES), sha256: hash(image.sha256) }),
    displayName: text(fields.displayName, 'display name', MAX_SAVED_VIEW_RECORD_BYTES, true) });
  if (jsonBytes(record) > MAX_SAVED_VIEW_RECORD_BYTES) invalid('record exceeds8192 UTF-8 JSON bytes');
  return record;
}

/** Content matching is independent of filenames and does not resolve copied-record ambiguity. */
export function savedViewMatches(record: SavedViewRecord, current: SourceFingerprint, kind: SavedViewRecord['sourceKind']): boolean {
  try {
    const saved = validateSavedViewRecord(record), source = fingerprint(current);
    return saved.sourceKind === sourceKind(kind) && saved.source.scheme === source.scheme &&
      saved.source.assetDigest === source.assetDigest && saved.source.resourceCount === source.resourceCount &&
      saved.source.totalBytes === source.totalBytes && saved.source.sourceKindHint === source.sourceKindHint;
  } catch { return false; }
}

/** Camera ABI1: target xyz, yaw, pitch, distance, radius, FOV, yUp, roll, aspect. */
export function savedViewFromCamera(state: readonly number[], color: BackgroundColor): SavedView {
  const values = array(state, 11);
  // Aspect is discarded, but malformed source state must still be refused.
  aspect(values[10]);
  if (values[8] !== 0 && values[8] !== 1) invalid('camera up flag');
  return view({ target: values.slice(0, 3), yaw: values[3], pitch: values[4], distance: values[5],
    radius: values[6], fov: values[7], yUp: values[8] === 1, roll: values[9], background: background(color) });
}

function aspect(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid('viewport aspect');
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded) || rounded <= 0) invalid('viewport aspect');
  return rounded;
}

/** Return a fresh ABI1 state using the current viewport, never a persisted aspect. */
export function savedViewCameraState(value: SavedView, viewportAspect: number): SavedViewCameraState {
  const saved = view(value);
  return [...saved.target, saved.yaw, saved.pitch, saved.distance, saved.radius, saved.fov,
    saved.yUp ? 1 : 0, saved.roll, aspect(viewportAspect)];
}

/** Native integer-centered crop, max1024 downsample and no upscale; no pixels are allocated. */
export function thumbnailPlan(width: number, height: number, maxSide = 1024): Readonly<ThumbnailPlan> {
  integer(width, 'capture width', 1, 16384); integer(height, 'capture height', 1, 16384);
  integer(maxSide, 'thumbnail maximum side', 0, 0xffff_ffff);
  if (width * height * 4 > 256 * 1024 * 1024) invalid('capture RGBA budget');
  const side = Math.min(width, height), output = Math.min(side, Math.max(1, Math.min(maxSide, 1024)));
  return Object.freeze({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2),
    side, width: output, height: output });
}
