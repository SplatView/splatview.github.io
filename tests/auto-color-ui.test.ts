import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { colorFields, colorPresets, desktopIcons } from '../src/generated/desktop';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import { AUTO_COLOR_ACTIONS, AutoColorActions, ColorApplyButton, colorPresetName, colorPresetNames,
  dispatchAutoColor, dispatchColorApply, dispatchColorPreset } from '../src/ui/AutoColorActions';

// SSR normally reads Zustand's initial hydration snapshot. These CPU-only
// markup checks render the current test store, as the mounted client UI does.
vi.mock('../src/app/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/store')>();
  return { ...actual, useApp: Object.assign(() => actual.useApp.getState(), actual.useApp) };
});
const initial = useApp.getState();
function controller(enabled = true, pending = false, previewEnabled = enabled) {
  return { colorControlsEnabled: enabled, colorPreviewEnabled: previewEnabled, colorPending: pending,
    autoColor: vi.fn().mockResolvedValue(true), commitGrade: vi.fn().mockResolvedValue(true), setGrade: vi.fn() };
}
afterEach(() => { setApp(initial, true); vi.restoreAllMocks(); });

describe('desktop Auto color controls', () => {
  it('keeps the native Basic seven and sorted Pro JSON map order independently of generated insertion order', () => {
    expect(colorPresetNames('basic')).toEqual(['neutral', 'warm', 'cool', 'vibrant', 'muted', 'cinematic', 'grayscale']);
    // Captured gsmod_presets.json color keys, in Recipe=nlohmann::json's map
    // iteration order. This literal does not sort the implementation result.
    expect(colorPresetNames('pro')).toEqual([
      'autumn_warm', 'bleach_bypass', 'blue_hour', 'boost_midtones', 'cinematic', 'cinestill_800t', 'compress_highlights', 'cool',
      'cross_process', 'decrease_contrast', 'desaturate_mild', 'desaturate_strong', 'dramatic', 'enhance_colors', 'faded_print', 'fuji_velvia',
      'golden_hour', 'grayscale', 'high_key', 'ilford_hp5', 'increase_contrast', 'kodak_ektachrome', 'kodak_portra', 'lift_shadows', 'low_key',
      'midday_sun', 'moonlight', 'muted', 'neutral', 'overcast', 'sepia_tone', 'spring_fresh', 'summer_bright', 'sunrise', 'sunset',
      'teal_orange', 'vibrant', 'vintage', 'warm', 'winter_cold',
    ]);
    expect(Object.isFrozen(colorPresetNames('pro'))).toBe(true); expect(Object.isFrozen(colorPresetNames('basic'))).toBe(true);
  });
  it('uses the native first sorted match even for equivalent recipes, including labels in Basic', () => {
    const before = colorPresets.cool;
    try {
      colorPresets.cool = { ...colorPresets.warm };
      const values = colorFields.map(field => Math.fround(colorPresets.warm[field.name] ?? field.neutral));
      expect(colorPresetName(values)).toBe('cool');
      setApp({ grade: values, mode: 'basic' });
      expect(renderToStaticMarkup(createElement(AutoColorActions, { controller: controller(), method: 'enhance', onMethodChanged: vi.fn() }))).toContain('>cool<');
    } finally { colorPresets.cool = before; }
  });
  it('dispatches every retained field of a Pro preset without applying it or rounding its recipe in the UI', () => {
    const target = controller(); expect(dispatchColorPreset(target, 'cross_process')).toBe(true);
    expect(target.setGrade).toHaveBeenCalledExactlyOnceWith([1, 1.2, 1, 1.4, 1, 0, 0, 0, 0, 0, 120, .2, -120, .15, 15]);
    expect(target.commitGrade).not.toHaveBeenCalled(); expect(target.autoColor).not.toHaveBeenCalled();
    target.setGrade.mockClear(); expect(dispatchColorPreset(target, 'warm')).toBe(true);
    expect(target.setGrade).toHaveBeenCalledExactlyOnceWith([1, 1, 1, 1, 1, .7333333333333333, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
  it('sends one full replacement to the shared desired-value callback without also dispatching or baking', () => {
    const target = controller(), replacement = vi.fn();
    expect(dispatchColorPreset(target, 'cross_process', true, replacement)).toBe(true);
    expect(replacement).toHaveBeenCalledExactlyOnceWith([1, 1.2, 1, 1.4, 1, 0, 0, 0, 0, 0, 120, .2, -120, .15, 15]);
    expect(target.setGrade).not.toHaveBeenCalled();expect(target.commitGrade).not.toHaveBeenCalled();expect(target.autoColor).not.toHaveBeenCalled();
    const values = replacement.mock.calls[0][0] as number[];values[14] = 99;
    expect(colorPresets.cross_process.hue_shift).toBe(15);
  });
  it('never publishes a preset replacement callback through invalid text or stale preview admission', () => {
    const target = controller(), replacement = vi.fn();
    expect(dispatchColorPreset(target, 'warm', false, replacement)).toBe(false);
    target.colorPreviewEnabled = false;expect(dispatchColorPreset(target, 'warm', true, replacement)).toBe(false);
    target.colorPreviewEnabled = true;expect(dispatchColorPreset(target, 'unknown', true, replacement)).toBe(false);
    expect(replacement).not.toHaveBeenCalled();expect(target.setGrade).not.toHaveBeenCalled();
  });
  it.each(['toString', '__proto__', 'constructor', 'Warm', '', null, 0, {}])('refuses unknown preset %j before staging', name => {
    const target = controller(); expect(dispatchColorPreset(target, name)).toBe(false); expect(target.setGrade).not.toHaveBeenCalled();
  });
  it('fences invalid local grade text in Auto, preset and Apply callbacks as well as their disabled controls', async () => {
    const target = controller(true, true, true);
    expect(await dispatchAutoColor(target, 'enhance', false)).toBe(false);
    expect(dispatchColorPreset(target, 'warm', false)).toBe(false); expect(await dispatchColorApply(target, false)).toBe(false);
    expect(target.autoColor).not.toHaveBeenCalled(); expect(target.setGrade).not.toHaveBeenCalled(); expect(target.commitGrade).not.toHaveBeenCalled();
    const markup = renderToStaticMarkup(createElement(AutoColorActions, { controller: target, method: 'enhance', onMethodChanged: vi.fn(), validInput: false }));
    const triggers = markup.match(/<button\b[^>]*>/g)!; expect(triggers).toHaveLength(2); expect(triggers.every(button => button.includes('disabled'))).toBe(true);
    expect(renderToStaticMarkup(createElement(ColorApplyButton, { controller: target, validInput: false }))).toContain('disabled');
    expect(await dispatchAutoColor(target, 'enhance', true)).toBe(true); expect(dispatchColorPreset(target, 'warm', true)).toBe(true);
    expect(await dispatchColorApply(target, true)).toBe(true);
  });
  it('uses fresh Apply/preset admission and preserves controller refusal after text becomes valid', async () => {
    const target = controller(false, true, false); expect(await dispatchColorApply(target)).toBe(false); expect(dispatchColorPreset(target, 'warm')).toBe(false);
    target.colorControlsEnabled = true; target.colorPreviewEnabled = true; target.colorPending = false;
    expect(await dispatchColorApply(target)).toBe(false); expect(target.commitGrade).not.toHaveBeenCalled();
    target.colorPending = true; target.commitGrade.mockResolvedValue(false);
    expect(await dispatchColorApply(target)).toBe(false); expect(target.commitGrade).toHaveBeenCalledOnce();
    expect(dispatchColorPreset(target, 'warm')).toBe(true);
  });
  it('dispatches exactly the four desktop method identifiers in desktop order', async () => {
    const target = controller();
    for (const method of ['enhance', 'exposure', 'contrast', 'white_balance']) expect(await dispatchAutoColor(target, method)).toBe(true);
    expect(target.autoColor.mock.calls).toEqual([['enhance'], ['exposure'], ['contrast'], ['white_balance']]);
    expect(AUTO_COLOR_ACTIONS.map(action => [action.method, action.label, action.icon])).toEqual([
      ['enhance', 'Auto', 'AutoColor'], ['exposure', 'Exposure', 'Exposure'],
      ['contrast', 'Contrast', 'AutoContrast'], ['white_balance', 'White balance', 'WhiteBalance'],
    ]);
  });
  it.each(['auto', 'whiteBalance', 'white balance', 'exposure ', 'Exposure', '', null, 0, {}, ['enhance']])(
    'refuses malformed method %j before forwarding', async method => {
      const target = controller(); expect(await dispatchAutoColor(target, method)).toBe(false); expect(target.autoColor).not.toHaveBeenCalled();
    });
  it('uses current controller admission and returns native/controller refusal without converting it to success', async () => {
    const target = controller(false);
    expect(await dispatchAutoColor(target, 'enhance')).toBe(false); expect(target.autoColor).not.toHaveBeenCalled();
    target.colorControlsEnabled = true; target.autoColor.mockResolvedValue(false);
    expect(await dispatchAutoColor(target, 'enhance')).toBe(false); expect(target.autoColor).toHaveBeenCalledExactlyOnceWith('enhance');
  });
  for (const mode of ['basic', 'pro'] as const) for (const action of AUTO_COLOR_ACTIONS) {
    it(`${mode} renders the remembered ${action.label} with its exact desktop SVG`, () => {
      setApp({ mode, grade: [...NEUTRAL_COLOR] });
      const markup = renderToStaticMarkup(createElement(AutoColorActions, { controller: controller(), method: action.method, onMethodChanged: vi.fn() }));
      expect(markup).toContain('aria-label="Auto color"'); expect(markup).toContain('aria-haspopup="menu"');
      expect(markup).toContain(`Current action: ${action.label}.`);
      expect(markup).toContain(currentDesktopIcons[action.icon] ?? desktopIcons[action.icon]);
      expect(markup).not.toContain(currentDesktopIcons.Help ?? desktopIcons.Help);
      expect(markup).toContain('aria-label="Color preset"'); expect(markup).not.toContain('being implemented');
    });
  }
  it('reflects all 15 absolute values in the preset label, including preserved Pro-only fields', () => {
    for (const [name, preset] of Object.entries(colorPresets)) {
      const values = colorFields.map(field => preset[field.name] ?? field.neutral);
      expect(colorPresetName(values)).toBe(name);
    }
    const values = [...NEUTRAL_COLOR]; values[12] = .31;
    expect(colorPresetName(values)).toBe('Custom'); expect(colorPresetName(values.slice(0, 14))).toBe('Custom');
    setApp({ grade: values, mode: 'basic' });
    expect(renderToStaticMarkup(createElement(AutoColorActions, { controller: controller(), method: 'enhance', onMethodChanged: vi.fn() })))
      .toContain('>Custom<');
  });
  it('keeps Warm and every other preset named after exact float32 native acknowledgement', () => {
    for (const [name, preset] of Object.entries(colorPresets)) {
      const acknowledged = colorFields.map(field => Math.fround(preset[field.name] ?? field.neutral));
      expect(colorPresetName(acknowledged)).toBe(name);
    }
    const warm = colorFields.map(field => Math.fround(colorPresets.warm[field.name] ?? field.neutral));
    expect(warm[5]).not.toBe(colorPresets.warm.temperature);
    setApp({ grade: warm, appliedGrade: [...warm] });
    const markup = renderToStaticMarkup(createElement(AutoColorActions, { controller: controller(), method: 'enhance', onMethodChanged: vi.fn() }));
    expect(markup).toContain('>warm<'); expect(markup).not.toContain('>Custom<');
    for (const bad of [NaN, Infinity, -Infinity]) {
      const invalid = [...warm]; invalid[5] = bad; expect(colorPresetName(invalid)).toBe('Custom');
    }
    const bits = new Uint32Array(new Float32Array([warm[0]]).buffer);bits[0]++;
    const neighboring = [...warm];neighboring[0] = new Float32Array(bits.buffer)[0];
    expect(Math.abs(neighboring[0] - warm[0])).toBeLessThan(.000001);
    expect(colorPresetName(neighboring)).toBe('Custom');
  });
  it('shows Apply for a pending neutral restoration and hides an already applied nonneutral grade', () => {
    const applied = [...NEUTRAL_COLOR]; applied[0] = 1.3;
    setApp({ grade: [...NEUTRAL_COLOR], appliedGrade: applied });
    const pending = renderToStaticMarkup(createElement(ColorApplyButton, { controller: controller(true, true) }));
    expect(pending).not.toContain('disabled'); expect(pending).not.toContain('hidden');
    setApp({ grade: applied, appliedGrade: [...applied] });
    const clean = renderToStaticMarkup(createElement(ColorApplyButton, { controller: controller(true, false) }));
    expect(clean).toContain('disabled'); expect(clean).toContain('hidden=""');
    const busy = renderToStaticMarkup(createElement(ColorApplyButton, { controller: controller(false, true) }));
    expect(busy).toContain('disabled'); expect(busy).not.toContain('hidden');
  });
  it('fences Auto and Apply during a manual bake while leaving the admitted preset preview enabled', () => {
    const target = controller(false, true, true);
    const markup = renderToStaticMarkup(createElement(AutoColorActions, { controller: target, method: 'enhance', onMethodChanged: vi.fn() }));
    const triggers = markup.match(/<button\b[^>]*>/g)!;
    expect(triggers).toHaveLength(2); expect(triggers[0]).toContain('disabled'); expect(triggers[1]).not.toContain('disabled');
    expect(renderToStaticMarkup(createElement(ColorApplyButton, { controller: target }))).toContain('disabled');
  });
});
