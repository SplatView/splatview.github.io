import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const label = process.argv[2], origin = process.argv[3], folder = resolve('.build/load-switch-20261025-01', label);
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-unsafe-webgpu'] });
const samples = [];
try {
  for (const backend of ['webgpu', 'webgl2']) for (let repetition = 0; repetition < 3; repetition++) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('splatview.tutorial.v1', JSON.stringify({ tutorial_prompt_handled: 'handled' }));
      const probe = window.latencyProbe = { phase: null, expected: null, start: 0, next: 0, frames: {}, submissions: [], compilers: [], startupMs: null };
      const begin = (phase, expected) => { probe.phase = phase; probe.expected = expected; probe.start = performance.now(); };
      document.addEventListener('click', event => {
        const button = event.target.closest?.('button');
        if (button && (button.getAttribute('aria-label') ?? button.textContent).trim() === 'Open example') begin('load', 'sorted');
      }, true);
      document.addEventListener('change', event => {
        if (event.target.matches?.('select[aria-label="Gaussian renderer"]')) begin('switch-' + ++probe.next, event.target.value);
      }, true);
      const record = (phase, kind, started, submitted) => {
        if (phase && phase === probe.phase && kind === probe.expected && !probe.frames[phase])
          probe.frames[phase] = { kind, submittedMs: submitted - started, completedMs: performance.now() - started };
      };
      new MutationObserver(() => {
        if (probe.startupMs !== null) return;
        const button = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Open example');
        if (button && !button.disabled) probe.startupMs = performance.now();
      }).observe(document, { childList: true, subtree: true, attributes: true });
      if (globalThis.GPUQueue) {
        const setPipeline = GPURenderPassEncoder.prototype.setPipeline, submit = GPUQueue.prototype.submit, done = GPUQueue.prototype.onSubmittedWorkDone;
        let kind, submission;
        GPURenderPassEncoder.prototype.setPipeline = function (pipeline) {
          kind = pipeline.label === 'SteadySplats display' ? 'steady' : pipeline.label === 'Native Gaussian composition' ? 'sorted' : null;
          return setPipeline.call(this, pipeline);
        };
        GPUQueue.prototype.submit = function (...args) {
          const result = submit.apply(this, args);
          submission = { phase: probe.phase, kind, started: probe.start, submitted: performance.now() };
          probe.submissions.push(submission); return result;
        };
        GPUQueue.prototype.onSubmittedWorkDone = function (...args) {
          const result = done.apply(this, args), current = submission;
          if (current) void result.then(() => record(current.phase, current.kind, current.started, current.submitted), () => {});
          return result;
        };
      }
      const proto = WebGL2RenderingContext.prototype, sources = new WeakMap(), programs = new WeakMap(), fences = new WeakMap();
      const shaderSource = proto.shaderSource, attach = proto.attachShader, link = proto.linkProgram,
        use = proto.useProgram, fence = proto.fenceSync, wait = proto.clientWaitSync;
      let kind;
      proto.shaderSource = function (shader, source) { sources.set(shader, source); return shaderSource.call(this, shader, source); };
      proto.attachShader = function (program, shader) {
        const source = sources.get(shader) ?? '';
        if (source.includes('uniform sampler2D reconstructedColor')) programs.set(program, 'steady');
        else if (source.includes('gaussianColorOpacity.rgb*alpha')) programs.set(program, 'sorted');
        return attach.call(this, program, shader);
      };
      proto.linkProgram = function (program) { probe.compilers.push({ start: performance.now(), kind: programs.get(program) ?? null }); return link.call(this, program); };
      proto.useProgram = function (program) { kind = programs.get(program); return use.call(this, program); };
      proto.fenceSync = function (...args) {
        const result = fence.apply(this, args);
        if (result) fences.set(result, { phase: probe.phase, kind, started: probe.start, submitted: performance.now() });
        return result;
      };
      proto.clientWaitSync = function (sync, ...args) {
        const result = wait.call(this, sync, ...args), current = fences.get(sync);
        if (current && (result === this.ALREADY_SIGNALED || result === this.CONDITION_SATISFIED)) record(current.phase, current.kind, current.started, current.submitted);
        return result;
      };
    });
    await page.goto(`${origin}/?graphics=${backend}`);
    await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Open example', exact: true }).click();
    await page.waitForFunction(() => window.latencyProbe.frames.load, {}, { timeout: 30000 });
    await expect(page).toHaveTitle('Bench example.sog — SplatView');
    if (!await page.getByRole('button', { name: 'Settings', exact: true }).isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const mode = page.getByRole('combobox', { name: 'Gaussian renderer', exact: true });
    await expect(mode).toHaveValue('sorted');
    // Identical fixed reading interval on both revisions; warmup cost is outside
    // selection latency and remains part of the raw compiler trace.
    await page.waitForTimeout(500);
    for (let cycle = 0; cycle < 3; cycle++) for (const value of ['steady', 'sorted']) {
      await mode.selectOption(value);
      await page.waitForFunction(() => window.latencyProbe.frames[window.latencyProbe.phase], {}, { timeout: 30000 });
      const canvas = page.getByLabel('SplatView scene', { exact: true });
      let frames, stable = 0;
      for (let i = 0; i < 150 && stable < 5; i++) {
        await page.waitForTimeout(30); const next = await canvas.getAttribute('data-frames');
        stable = next === frames ? stable + 1 : 0; frames = next;
      }
      if (stable < 5) throw new Error('The actual App did not return to idle.');
    }
    const result = await page.evaluate(async () => ({ ...window.latencyProbe,
      manifest: await (await fetch('build-manifest.json', { cache: 'no-store' })).json(),
      environment: { userAgent: navigator.userAgent, secure: isSecureContext, crossOriginIsolated } }));
    samples.push({ backend, repetition, errors, ...result });
    await writeFile(resolve(folder, 'samples.json'), JSON.stringify({ label, origin, browser: browser.version(), viewport: { width: 1280, height: 800 }, settingsReadingMs: 500, samples }, null, 2) + '\n');
    console.log(JSON.stringify({ backend, repetition, startupMs: result.startupMs, frames: result.frames, errors }));
    await page.close();
  }
} finally { await browser.close(); }
