import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { productAllowed } from '../src/generated/product-policy';
import { requireWorkerProductCommand, webFeatureAllowed } from '../src/app/productPolicy';
import { TUTORIAL_STEPS } from '../src/app/tutorialCatalog';

describe('pinned product policy', () => {
  it('replays the same availability fixture as the native adapters', () => {
    const cases = JSON.parse(readFileSync(new URL('../contracts/product/fixtures/availability.json', import.meta.url), 'utf8'));
    for (const test of cases.filter((test: { binding?: string }) => !test.binding)) expect(productAllowed(test.feature, test.platform, test.profile, test.surface,
      test.host, test.capabilities ? test.capabilities.split(',') : []), test.feature).toBe(test.allowed);
  });
  it('keeps manual editing and refuses advanced commands at the worker boundary', () => {
    for (const command of ['brush', 'rectangle', 'polygon', 'colorPick', 'fillPick', 'delete', 'crop', 'undo', 'beginTransform', 'alignScale', 'autoColor'])
      expect(() => requireWorkerProductCommand({ command })).not.toThrow();
    for (const command of ['beginFilter', 'morphology', 'duplicate', 'detectFloor', 'beginOpacity', 'futureCommand'])
      expect(() => requireWorkerProductCommand({ command })).toThrow(/unavailable/);
    expect(() => requireWorkerProductCommand(null)).toThrow();
    expect(() => requireWorkerProductCommand({ command: 'colorPick', rangeEnabled: true })).toThrow(/range is unavailable/);
    expect(() => requireWorkerProductCommand({ command: 'colorPick', rangeEnabled: false })).not.toThrow();
  });
  it('refuses current-view selection without restricting ordinary camera or edit scope', () => {
    const camera = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1];
    for (const command of ['brush', 'rectangle', 'colorPick', 'beginTransform'])
      expect(() => requireWorkerProductCommand({ command, selectionView: camera })).toThrow(/Current-view selection is unavailable/);
    for (const selectionView of [null, undefined])
      expect(() => requireWorkerProductCommand({ command: 'brush', selectionView, camera })).not.toThrow();
    expect(() => requireWorkerProductCommand({ command: 'beginTransform', kind: 'numeric', selectedOnly: true })).not.toThrow();
    expect(() => requireWorkerProductCommand({ command: 'beginTransform', kind: 'gizmo', selectedOnly: false })).not.toThrow();
  });
  it('does not restore ordinary measurement, an agent server, or overwrite', () => {
    for (const feature of ['measurement.agent', 'measurement.compatibility', 'agent.access', 'agent.protocol', 'save.overwrite'])
      expect(webFeatureAllowed(feature)).toBe(false);
  });
  it('projects ordinary tutorial topics to the lightweight interface', () => {
    const targets = TUTORIAL_STEPS.map(step => step.target);
    for (const excluded of ['filter', 'refine', 'duplicate', 'current-view', 'range', 'pro-color', 'floor', 'coordinates', 'pivot', 'modes'])
      expect(targets).not.toContain(excluded);
    for (const required of ['open', 'save', 'capture', 'brushes', 'area', 'gizmo', 'auto-color']) expect(targets).toContain(required);
    expect(TUTORIAL_STEPS.map(step => step.index)).toEqual(TUTORIAL_STEPS.map((_, index) => index + 1));
    expect(TUTORIAL_STEPS.some(step => /\bPro\b/.test(step.text))).toBe(false);
  });
});
