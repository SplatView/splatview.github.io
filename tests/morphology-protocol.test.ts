import { describe, expect, it } from 'vitest';
import { isMorphologyRangeCommand, isSelectionMorphologyCommand, validateMorphologyRange } from '../src/input/selectionMorphology';
import { CoreClient } from '../src/document/coreClient';
import type { SceneCommand } from '../src/document/types';

const sigma = { command: 'morphology', mode: 'grow', method: 'sigma', sigma: 1 };
const volume = { command: 'morphology', mode: 'shrink', method: 'volume', distance: .125 };
const range = { version: 1, minimum: Math.fround(1e-6), maximum: Math.fround(2 * Math.fround(1e12)), default: 1 };
describe('morphology method and metric wire contracts', () => {
  it('keeps legacy sigma and desktop half-step UI while permitting the existing continuous native sigma domain', () => {
    expect(isSelectionMorphologyCommand({ command: 'morphology', mode: 'grow' })).toBe(true);
    expect(isSelectionMorphologyCommand(sigma)).toBe(true); expect(isSelectionMorphologyCommand(volume)).toBe(true);
    expect(isSelectionMorphologyCommand({ ...sigma, sigma: .75 })).toBe(false);
    expect(isSelectionMorphologyCommand({ ...sigma, sigma: .75 }, false)).toBe(true);
    expect(isSelectionMorphologyCommand({ ...volume, distance: 1e30 })).toBe(true);
  });
  it.each([
    { ...volume, sigma: 1 }, { ...sigma, distance: 1 }, { command: 'morphology', mode: 'grow', method: 'sigma' },
    { command: 'morphology', mode: 'grow', method: 'volume' }, { ...volume, distance: true }, { ...volume, distance: '1' },
    { ...volume, distance: 0 }, { ...volume, distance: 1e-100 }, { ...volume, distance: Number.MAX_VALUE },
    { ...volume, distance: Infinity }, { ...volume, method: 'diameter' }, { ...sigma, method: undefined },
    { ...sigma, extra: true }, { ...volume, selectionView: [1] },
  ])('rejects malformed method-exclusive command %j before transport', async command => {
    expect(isSelectionMorphologyCommand(command as SceneCommand, false)).toBe(false);
    // No worker or request state is needed: this rejection precedes posting.
    await expect(Promise.resolve().then(() => CoreClient.prototype.command.call({} as CoreClient, command as SceneCommand))).rejects.toThrow('Invalid');
  });
  it('does not evaluate accessors or accept symbol/hidden fields', () => {
    let reads = 0;
    const accessor = { ...volume }; Object.defineProperty(accessor, 'distance', { enumerable: true, get() { reads++; return 1; } });
    const hidden = { ...volume }; Object.defineProperty(hidden, 'extra', { value: 1 });
    expect(isSelectionMorphologyCommand(accessor)).toBe(false);
    expect(isSelectionMorphologyCommand(hidden)).toBe(false);
    expect(isSelectionMorphologyCommand({ ...volume, [Symbol('extra')]: true })).toBe(false); expect(reads).toBe(0);
  });
  it('accepts only an unscoped readonly range request', async () => {
    expect(isMorphologyRangeCommand({ command: 'morphologyRange' })).toBe(true);
    for (const command of [{ command: 'morphologyRange', selectionView: null }, { command: 'morphologyRange', operation: 1 }]) {
      expect(isMorphologyRangeCommand(command)).toBe(false);
      await expect(Promise.resolve().then(() => CoreClient.prototype.command.call({} as CoreClient, command))).rejects.toThrow(
        Object.hasOwn(command, 'selectionView') ? 'This command does not accept a current-view camera.' : 'Invalid selection morphology command.');
    }
  });
  it('copies and freezes authoritative float metadata including the rounded native lower bound', () => {
    const parsed = validateMorphologyRange(range);
    expect(parsed).toEqual(range); expect(parsed).not.toBe(range); expect(Object.isFrozen(parsed)).toBe(true);
    expect(validateMorphologyRange(null)).toBeNull(); expect(validateMorphologyRange(undefined)).toBeNull();
  });
  it.each([
    { ...range, version: 2 }, { ...range, minimum: 0 }, { ...range, minimum: 1e-100 },
    { ...range, maximum: Infinity }, { ...range, maximum: .5, minimum: 1 },
    { ...range, default: 0 }, { ...range, default: Number.MAX_VALUE }, { ...range, extra: 1 },
    { ...range, [Symbol('extra')]: 1 }, { ...range, default: '1' },
  ])('rejects invalid or inexact-shape range metadata %j', value => {
    expect(() => validateMorphologyRange(value)).toThrow('Invalid native morphology range.');
  });
  it('refuses accessor range metadata without executing it', () => {
    let reads = 0; const value = { ...range };
    Object.defineProperty(value, 'default', { enumerable: true, get() { reads++; return 1; } });
    expect(() => validateMorphologyRange(value)).toThrow('Invalid native morphology range.'); expect(reads).toBe(0);
  });
});
