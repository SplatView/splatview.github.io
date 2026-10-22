/** DirectX row-vector Matrix4 storage; translation occupies entries 12..14. */
export type AlignmentFrame = readonly [
  number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number,
];
/** Camera state: target xyz, yaw, pitch, distance, radius, FOV, yUp, roll, aspect. */
export type AlignmentCameraState = [number, number, number, number, number, number, number, number, number, number, number];
export type AlignmentCameraPolicy = 0 | 1;
export type AlignmentCameraTransform = (state: readonly number[], frame: readonly number[], policy?: AlignmentCameraPolicy) => readonly number[];
export type AlignmentFrameChange = (before: readonly number[], after: readonly number[]) => readonly number[];
export const IDENTITY_ALIGNMENT_FRAME: AlignmentFrame = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);

function invalid(label: string): never { throw new Error(`Invalid alignment ${label}.`); }

/** Read only dense inert arrays; getters, inherited entries and extra fields refuse. */
function values(value: unknown, length: number, label: string, allowUnderflow = false): number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length ||
      Reflect.ownKeys(value).length !== length + 1) invalid(label);
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid(label);
    const entry: unknown = descriptor.value;
    if (typeof entry !== 'number' || !Number.isFinite(entry) || !Number.isFinite(Math.fround(entry)) ||
        (!allowUnderflow && entry !== 0 && Math.fround(entry) === 0)) invalid(label);
    return entry;
  });
}

function frame(entries: number[]): AlignmentFrame { return Object.freeze(entries) as unknown as AlignmentFrame; }

/** Detached dense float32 matrix, including raw native inverse/composition rounding. */
export function validateAlignmentMatrix(value: unknown): AlignmentFrame {
  return frame(values(value, 16, 'matrix').map(Math.fround));
}

/** Invert the affine 3x3 and translation, rejecting an unusable float32 inverse. */
function inverse(entries: readonly number[]): number[] {
  const [a, b, c] = entries, [d, e, f] = entries.slice(4, 7), [g, h, i] = entries.slice(8, 11);
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(Math.fround(determinant)) || Math.fround(determinant) === 0) invalid('frame inverse');
  const result = [
    (e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant, 0,
    (f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant, 0,
    (d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant, 0,
    0, 0, 0, 1,
  ].map(Math.fround);
  for (let column = 0; column < 3; column++) {
    result[12 + column] = Math.fround(-(
      entries[12] * result[column] + entries[13] * result[4 + column] + entries[14] * result[8 + column]));
  }
  if (result.some(entry => !Number.isFinite(entry))) invalid('frame inverse');
  return result;
}

/** Canonical float32 frame detached from the caller, with a representable inverse. */
export function validateAlignmentFrame(value: unknown): AlignmentFrame {
  const entries = values(value, 16, 'frame').map(Math.fround);
  if (entries[3] !== 0 || entries[7] !== 0 || entries[11] !== 0 || entries[15] !== 1) invalid('affine frame');
  inverse(entries);
  return frame(entries);
}

export function inverseAlignmentFrame(value: readonly number[]): AlignmentFrame {
  return frame(inverse(validateAlignmentFrame(value)));
}

/** W19a1 uses Center frames. Generic inverse/composition needs separate source qualification. */
export function validateCenterAlignmentFrame(value: unknown): AlignmentFrame {
  const result = validateAlignmentFrame(value);
  for (let index = 0; index < 12; index++) {
    if (result[index] !== IDENTITY_ALIGNMENT_FRAME[index])
      throw new Error('Only translation alignment is supported by the Center camera adapter.');
  }
  return result;
}

/** Proper similarity scene frames; native Camera::transformed remains the carry authority. */
export function validateSimilarityAlignmentFrame(value: unknown): AlignmentFrame {
  const result = validateAlignmentFrame(value);
  const dot = (a: number, b: number) => Math.fround(Math.fround(Math.fround(result[a] * result[b]) +
    Math.fround(result[a + 1] * result[b + 1])) + Math.fround(result[a + 2] * result[b + 2]));
  const length = (row: number) => Math.fround(Math.sqrt(dot(row, row)));
  const scale = length(0), tolerance = Math.fround(1e-4);
  const determinant = result[0] * (result[5] * result[10] - result[6] * result[9]) -
    result[1] * (result[4] * result[10] - result[6] * result[8]) +
    result[2] * (result[4] * result[9] - result[5] * result[8]);
  if (!Number.isFinite(scale) || scale <= 0 || determinant <= 0)
    throw new Error('Alignment requires a proper rotation, translation or positive uniform scale.');
  // Captured camera admission uses float32 row lengths and dot products with
  // relative 1e-4 tolerances. The subsequent native transform can still refuse.
  for (let row = 0; row < 3; row++) {
    if (Math.abs(Math.fround(length(row * 4) - scale)) > Math.fround(scale * tolerance))
      throw new Error('Alignment requires a uniform scale.');
    for (let other = row + 1; other < 3; other++)
      if (Math.abs(dot(row * 4, other * 4)) > Math.fround(Math.fround(scale * scale) * tolerance))
        throw new Error('Alignment cannot shear the scene.');
  }
  return result;
}

/** Retained name for Center/Scale callers, now sharing the orientation frame boundary. */
export const validateCenterScaleAlignmentFrame = validateSimilarityAlignmentFrame;

/** Current edited coordinates -> source -> next edited coordinates, in that order. */
export function alignmentFrameChange(oldFrame: readonly number[], newFrame: readonly number[]): AlignmentFrame {
  const before = inverseAlignmentFrame(oldFrame), after = validateAlignmentFrame(newFrame);
  const result = new Array<number>(16);
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    let sum = Math.fround(before[row * 4] * after[column]);
    for (let k = 1; k < 4; k++) sum = Math.fround(sum + Math.fround(before[row * 4 + k] * after[k * 4 + column]));
    result[row * 4 + column] = sum;
  }
  return validateAlignmentFrame(result);
}

export function transformAlignmentPoint(point: readonly number[], transform: readonly number[]): [number, number, number] {
  const coordinates = values(point, 3, 'point').map(Math.fround), matrix = validateAlignmentFrame(transform);
  return [0, 1, 2].map(column => {
    let coordinate = Math.fround(coordinates[0] * matrix[column]);
    coordinate = Math.fround(coordinate + Math.fround(coordinates[1] * matrix[4 + column]));
    coordinate = Math.fround(coordinate + Math.fround(coordinates[2] * matrix[8 + column]));
    coordinate = Math.fround(coordinate + matrix[12 + column]);
    if (!Number.isFinite(coordinate)) invalid('transformed point');
    return coordinate;
  }) as [number, number, number];
}

function cameraState(value: readonly number[]): AlignmentCameraState {
  const result = values(value, 11, 'camera', true).map(Math.fround);
  if (result[5] <= 0 || result[6] <= 0 || result[10] <= 0 || result[8] !== 0 && result[8] !== 1)
    invalid('camera range');
  return result as AlignmentCameraState;
}

/** Carry current navigation through alignment/history using the native frame arithmetic. */
export function carryCameraState(state: readonly number[], oldFrame: readonly number[], newFrame: readonly number[],
  transform: AlignmentCameraTransform, frameChange: AlignmentFrameChange, policy: AlignmentCameraPolicy = 0): AlignmentCameraState {
  if (policy !== 0 && policy !== 1) invalid('camera policy');
  const input = cameraState(state), before = validateSimilarityAlignmentFrame(oldFrame), after = validateSimilarityAlignmentFrame(newFrame);
  // Preserve raw XMMatrixInverse(old) * new output, including m15 near one.
  // The captured native camera validates this result; JS inverse/composition is not its oracle.
  const delta = validateAlignmentMatrix(frameChange(before, after));
  const aspect = input[10];
  const result = cameraState(transform(input, delta, policy));
  if (result[10] !== aspect) invalid('camera aspect');
  return result;
}

/** Persist views in original-source coordinates, as captured desktop saved views do. */
export function cameraStateToOriginal(state: readonly number[], currentFrame: readonly number[],
  transform: AlignmentCameraTransform, frameChange: AlignmentFrameChange): AlignmentCameraState {
  const current = validateSimilarityAlignmentFrame(currentFrame);
  // Captured thumbnail conversion skips reconstruction only for the original frame.
  if (current.every((value, index) => value === IDENTITY_ALIGNMENT_FRAME[index])) return cameraState(state);
  return carryCameraState(state, current, IDENTITY_ALIGNMENT_FRAME, transform, frameChange);
}

/** Restore an original-source saved view into the current edited coordinate system. */
export function cameraStateFromOriginal(state: readonly number[], currentFrame: readonly number[],
  transform: AlignmentCameraTransform, frameChange: AlignmentFrameChange): AlignmentCameraState {
  const current = validateSimilarityAlignmentFrame(currentFrame);
  if (current.every((value, index) => value === IDENTITY_ALIGNMENT_FRAME[index])) return cameraState(state);
  return carryCameraState(state, IDENTITY_ALIGNMENT_FRAME, current, transform, frameChange);
}

/** Prepare an explicit default's roll in every retained frame before any owner is published. */
export function prepareDefaultRolls(viewState: readonly number[], currentFrame: readonly number[],
  checkpointFrames: readonly (readonly number[])[], transform: AlignmentCameraTransform,
  orientationFrameChange: AlignmentFrameChange): readonly number[] {
  const view = cameraState(viewState), current = validateAlignmentMatrix(currentFrame);
  // These are the captured Camera{} defaults, not the saved view's position,
  // zoom, radius or lens. Only orientation travels through abandoned frames.
  const orientation: AlignmentCameraState = [0, 0, 0, view[3], view[4], 3, 1, 45, view[8], view[9], 1];
  // R0 extracts current rotation before walking checkpoints, even if every
  // frame is equal. This primitive intentionally has no full inverse gate.
  validateAlignmentMatrix(orientationFrameChange(current, current));
  if (!Array.isArray(checkpointFrames) || Object.getPrototypeOf(checkpointFrames) !== Array.prototype ||
      Reflect.ownKeys(checkpointFrames).length !== checkpointFrames.length + 1) invalid('checkpoint frames');
  const rolls = Array.from({ length: checkpointFrames.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(checkpointFrames, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid('checkpoint frame');
    const value: unknown = descriptor.value;
    const checkpoint = validateAlignmentMatrix(value);
    if (current.every((entry, index) => entry === checkpoint[index])) return view[9];
    const delta = validateAlignmentMatrix(orientationFrameChange(current, checkpoint));
    const result = cameraState(transform([...orientation], delta, 0));
    if (result[10] !== 1) invalid('camera aspect');
    return result[9];
  });
  return Object.freeze(rolls);
}
