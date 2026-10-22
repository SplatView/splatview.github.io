import { validateGeometryDescriptor, type GeometryDescriptor } from '../../document/geometry';
import { checkedBytes, MiB } from '../../document/resources';
import type { GaussianRenderer } from './renderer';

/** Readonly PLY vertex/index storage; never owns Gaussian masks or sorting. */
export class GpuGeometryScene {
  readonly kind = 'geometry' as const;
  readonly descriptor: GeometryDescriptor;
  readonly vertices: GPUBuffer;
  readonly indices?: GPUBuffer;
  readonly drawGroup: GPUBindGroup;
  readonly count: number;
  readonly revision: number;
  readonly contentRevision: number;
  retired = false;
  private pendingUploadBytes = 0;
  private retirement?: Promise<void>;
  get deviceEpoch() { return this.renderer.deviceEpoch; }
  constructor(readonly renderer: GaussianRenderer, descriptor: GeometryDescriptor) {
    this.descriptor = Object.freeze(validateGeometryDescriptor(descriptor));
    this.count = this.descriptor.vertexCount;
    if (this.count > 10_000_000 || this.descriptor.triangleCount > 10_000_000)
      throw new Error('This PLY geometry exceeds the native GPU preview budget.');
    this.revision = this.descriptor.revision; this.contentRevision = this.descriptor.contentRevision;
    const { vertexBytes, indexBytes, kind } = this.descriptor, { device } = renderer;
    if (vertexBytes > device.limits.maxBufferSize || indexBytes > device.limits.maxBufferSize)
      throw new Error('This PLY geometry exceeds the graphics device buffer limit.');
    const allocations: GPUBuffer[] = [];
    try {
      this.vertices = device.createBuffer({ label: 'Readonly PLY vertices', size: vertexBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      allocations.push(this.vertices);
      if (kind === 2) {
        this.indices = device.createBuffer({ label: 'Readonly PLY triangle indices', size: indexBytes,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        allocations.push(this.indices);
      }
      this.drawGroup = renderer.bind(kind === 2 ? renderer.geometryMesh : renderer.geometryPoints, [[0, renderer.frame]]);
    } catch (error) { for (const buffer of allocations) buffer.destroy(); throw error; }
  }
  get allocationBytes() { return this.vertices.size + (this.indices?.size ?? 0); }
  private async upload(buffer: GPUBuffer | undefined, first: number, count: number, stride: number,
    total: number, bytes: ArrayBuffer) {
    this.renderer.requireScene(this);
    if (!buffer || !Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count <= 0 ||
      first > total || count > total - first || bytes.byteLength > MiB || bytes.byteLength !== checkedBytes(count, stride))
      throw new Error('Invalid readonly PLY geometry upload.');
    this.renderer.device.queue.writeBuffer(buffer, checkedBytes(first, stride), bytes);
    this.pendingUploadBytes += bytes.byteLength;
    if (this.pendingUploadBytes >= 16 * MiB) {
      await this.renderer.device.queue.onSubmittedWorkDone(); this.pendingUploadBytes = 0;
      this.renderer.requireScene(this);
    }
  }
  uploadVertices(first: number, count: number, bytes: ArrayBuffer) {
    return this.upload(this.vertices, first, count, 16, this.count, bytes);
  }
  uploadIndices(first: number, count: number, bytes: ArrayBuffer) {
    // A compromised or mismatched stream cannot address outside this allocation.
    if (bytes.byteLength % 4 || new Uint32Array(bytes).some(index => index >= this.count))
      return Promise.reject(new Error('Invalid readonly PLY triangle index.'));
    return this.upload(this.indices, first, count, 4, this.descriptor.triangleCount * 3, bytes);
  }
  dispose(): Promise<void> {
    if (this.retirement) return this.retirement;
    this.retired = true;
    this.retirement = (async () => {
      try { await this.renderer.device.queue.onSubmittedWorkDone(); } catch { /* Device already lost. */ }
      this.vertices.destroy(); this.indices?.destroy();
      await this.renderer.releaseGeometryScene(this);
    })();
    return this.retirement;
  }
}
