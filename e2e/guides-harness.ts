// Actual mounted App/native worker/WebGPU observations. No guides math is
// imported here: projection and lattice expectations live independently in the spec.
import './opacity-harness';
import { useApp } from '../src/app/store';
import { IDENTITY_MATRIX } from '../src/document/types';

const controller = () => window.geometryViewer.controllerForSourceNavigation();
const numeric = (element: Element, name: string) => Number(element.getAttribute(name));
const vector = (element: Element, name: string) => element.getAttribute(name)!.split(',').map(Number);
function view() {
  const app = controller(), camera = app.camera!, canvas = app.renderer!.canvas, bounds = canvas.getBoundingClientRect();
  return { state: camera.state, view: Array.from(camera.view), projection: Array.from(camera.projection),
    revision: camera.revision, background: camera.background, dpr: devicePixelRatio,
    width: bounds.width, height: bounds.height, backingWidth: canvas.width, backingHeight: canvas.height };
}
function presentation() {
  const svg = document.querySelector<SVGSVGElement>('.viewport-guides');
  if (!svg) return null;
  return { mode: svg.dataset.guidesMode, step: Number(svg.dataset.guidesStep), revision: Number(svg.dataset.guidesCameraRevision),
    width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height,
    lines: Array.from(svg.querySelectorAll('line')).map(line => ({
      kind: line.dataset.guideKind, axis: line.dataset.guideAxis ?? null, direction: line.dataset.guideDirection ?? null,
      cell: line.dataset.guideCell === undefined ? null : Number(line.dataset.guideCell), major: line.dataset.guideMajor === 'true',
      from: vector(line, 'data-world-from'), to: vector(line, 'data-world-to'),
      x1: numeric(line, 'x1'), y1: numeric(line, 'y1'), x2: numeric(line, 'x2'), y2: numeric(line, 'y2'),
      stroke: line.getAttribute('stroke'), opacity: numeric(line, 'stroke-opacity'), width: numeric(line, 'stroke-width'),
    })),
    labels: Array.from(svg.querySelectorAll<SVGGElement>('.viewport-guide-label')).map(group => {
      const ink = group.querySelector('.viewport-guide-label-ink')!, shadow = group.querySelector('.viewport-guide-label-shadow')!;
      return { axis: group.dataset.guideAxis, text: ink.textContent, x: numeric(ink, 'x'), y: numeric(ink, 'y'),
        shadowX: numeric(shadow, 'x'), shadowY: numeric(shadow, 'y'), color: ink.getAttribute('fill') };
    }),
    origin: (() => { const circle = svg.querySelector('circle'); return circle ? { x: numeric(circle, 'cx'), y: numeric(circle, 'cy'),
      radius: numeric(circle, 'r'), fill: circle.getAttribute('fill'), opacity: numeric(circle, 'fill-opacity') } : null; })(),
  };
}
async function digest(bytes: BufferSource) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function capture() {
  const app = controller(), state = useApp.getState();
  if (!app.scene) throw new Error('Open an actual scene before capturing.');
  // Raw renderer capture intentionally excludes every DOM overlay. Forward all
  // current independent grade/geometry/opacity scopes, as the production API does.
  const blob = await app.renderer!.capture(app.scene, app.camera!, 'image/png', state.grade,
    state.transformPreview?.matrix ?? IDENTITY_MATRIX, state.colorSelectedOnly,
    state.transformPreview?.selectedOnly ?? false, state.opacityPreview?.scale ?? 1, state.opacityPreview?.selectedOnly ?? false);
  const bytes = await blob.arrayBuffer(), bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return { bytes: bytes.byteLength, hash: await digest(bytes), pixelHash: await digest(context.getImageData(0, 0, bitmap.width, bitmap.height).data),
      width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}
let notifications = 0, unsubscribe: (() => void) | undefined;
const frames = (count: number) => new Promise<void>(resolve => {
  let remaining = count;const next = () => { if (--remaining <= 0) resolve(); else requestAnimationFrame(next); };requestAnimationFrame(next);
});
const harness = {
  ready: () => window.opacityHarness.ready(), view, presentation, capture,
  state: () => ({ ...window.opacityHarness.state(), guides: presentation()?.mode ?? 'none' }),
  snapshot: () => window.opacityHarness.snapshot(),
  load: (name?: string) => window.opacityHarness.load(name ?? 'guides-literals-sh3.ply'),
  loadGeometry: (source: 'points' | 'mesh') => window.geometryViewer.load(source),
  async settle() { await controller().renderer!.device.queue.onSubmittedWorkDone();await frames(6); },
  setCamera(values: number[]) { controller().camera!.set(values);controller().invalidate(); },
  async close() { const app = controller();await app.closeScene();if (useApp.getState().navigationPrompt) await app.discardAndContinue(); },
  async saveView() {
    const app = controller();if (!await app.updateThumbnail()) throw new Error(useApp.getState().viewStatus ?? 'The actual saved view was refused.');
    const record = (app as unknown as { savedViewRecord?: { view: Record<string, unknown> } }).savedViewRecord;
    if (!record) throw new Error('No actual saved-view record was published.');return structuredClone(record.view);
  },
  resetCamera() { controller().resetCamera(); },
  observe() {
    unsubscribe?.();notifications = 0;unsubscribe = controller().subscribeViewport(() => notifications++);window.opacityHarness.observe();
  },
  counters: () => ({ frames: controller().renderer!.frames, notifications, commands: window.opacityHarness.commands(),
    cameraRevision: controller().camera!.revision }),
  async waitFrames(count = 8) { await frames(count); },
  recover: () => window.opacityHarness.recover(),
  stop() { unsubscribe?.();unsubscribe = undefined;window.opacityHarness.stop(); },
};
declare global { interface Window { guidesHarness: typeof harness } }
window.guidesHarness = harness;
