export function gaussianPly(degree = 3): Uint8Array<ArrayBuffer> {
  const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2',
    ...Array.from({ length: 3 * ((degree + 1) ** 2 - 1) }, (_, i) => `f_rest_${i}`),
    'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const points = [[-.4, 0, 0, .5, 0, 0], [.4, 0, 0, 0, .5, 0], [0, .4, .1, 0, 0, .5]];
  const header = ['ply', 'format ascii 1.0', 'element vertex 3', ...properties.map(name => `property float ${name}`), 'end_header'].join('\n');
  const body = points.map(point => [...point, ...Array(3 * ((degree + 1) ** 2 - 1)).fill(.02),
    1.38629436, -2.12026354, -2.30258509, -2.52572864, 1, 0, 0, 0].join(' ')).join('\n');
  return new TextEncoder().encode(header + '\n' + body + '\n');
}
