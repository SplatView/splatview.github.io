import { createRenderer, ResourceLedger, estimateSceneBytes, packedStride, IDENTITY_MATRIX,
  DEFAULT_STEADY_SETTINGS } from '../splatview-renderer.js';

// No editor, camera WASM, codecs, framework or application bootstrap is used.
export const ready = start();
ready.catch(error => { document.querySelector('#status').textContent = error.message; });

async function start() {
  const params = new URL(location.href).searchParams, preference = params.get('backend') ?? 'auto';
  const degree = Number(params.get('degree') ?? 0), count = 3;
  const status = document.querySelector('#status'), selector = document.querySelector('#backend');
  selector.value = preference;
  selector.addEventListener('change', () => { params.set('backend', selector.value); location.search = params.toString(); });
  let canvas = document.querySelector('#scene');
  const renderer = await createRenderer(canvas, { preference, fallback: reason => { status.textContent = reason; },
    replaceCanvas: async previous => { const next = previous.cloneNode(); previous.replaceWith(next); canvas = next; return next; } });
  const ledger = new ResourceLedger(128 * 1024 ** 2);
  renderer.admitWork = bytes => ledger.reserve('work', bytes);
  renderer.admitSortScratch = bytes => ledger.reserve('render', bytes);
  renderer.admitSteady = bytes => ledger.reserve('render', bytes);
  renderer.admitHistogram = bytes => ledger.reserve('render', bytes);
  renderer.admitGeometryDepth = bytes => ledger.reserve('render', bytes);
  const credit = ledger.reserve('render', estimateSceneBytes(count, degree));
  let scene;
  try {
    scene = await renderer.allocateScene(count, degree);
    const stride = packedStride(degree), bytes = new ArrayBuffer(count * stride), floats = new Float32Array(bytes), half = new DataView(bytes);
    for (let i = 0; i < count; i++) {
      floats.set([(i - 1) * .55, 0, -2, .8, .025, 0, 0, .025, 0, .025], i * stride / 4);
      half.setUint16(i * stride + 40 + i * 2, 0x3c00, true); // RGB SH DC, all remaining coefficients zero.
    }
    await scene.upload(0, count, bytes); // Upload consumes the owned buffer on WebGL2.
    const camera = { view: new Float32Array(IDENTITY_MATRIX), eye: new Float32Array(3), revision: 0, background: 'black',
      projection: new Float32Array([.75,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]) };
    let closing = false, scheduled = 0, needed = false, drawing, disposal;
    const requestFrame = () => {
      if (closing) return;
      needed = true;
      if (scheduled || drawing) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0; needed = false;
        void draw().catch(error => { status.textContent = error.message; });
      });
    };
    const draw = () => {
      if (closing) return Promise.resolve();
      if (drawing) return drawing;
      // Publish the in-flight owner before render can synchronously request a frame.
      drawing = Promise.resolve().then(async () => { await renderer.render(scene, camera); await (renderer.displayCompletion()?.done ?? renderer.finish());
        status.textContent = `${renderer.backend} / ${renderer.steadySnapshot.status} / SH${degree}`;
      }).finally(() => { drawing = undefined; if (needed) requestFrame(); });
      return drawing;
    };
    renderer.onFrameNeeded = requestFrame;
    renderer.onLost = message => { status.textContent = message; };
    const setSteady = enabled => { renderer.setRenderSettings({ ...DEFAULT_STEADY_SETTINGS, mode: enabled ? 'steady' : 'sorted' }); return draw(); };
    document.querySelector('#steady').addEventListener('change', event => { void setSteady(event.target.checked).catch(error => { status.textContent = error.message; }); });
    const dispose = () => disposal ??= (async () => {
      closing = true; cancelAnimationFrame(scheduled); renderer.onFrameNeeded = undefined;
      try { await drawing; } finally { try { await scene.dispose(); await renderer.finish(); }
        finally { await renderer.close(); credit(); } }
    })();
    window.addEventListener('pagehide', () => { void dispose(); }, { once: true });
    await draw();
    return { renderer, scene, camera, ledger, draw, setSteady, dispose };
  } catch (error) {
    try { await scene?.dispose(); } finally { await renderer.close(); credit(); }
    throw error;
  }
}
