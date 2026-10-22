// Four isolated SH0 Gaussians. Their positions and distinct colors provide
// independent native/GPU membership oracles rather than renderer snapshots.
export const gesturePositions = [[-.65, -.65, 0], [.65, .25, 0], [.05, .25, 0], [-.65, .65, 0]];
export function gesturePly() {
  const rgb = [[.85, .15, .15], [.15, .85, .15], [.15, .15, .85], [.85, .85, .15]], scale = Math.log(.035);
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  return new TextEncoder().encode(['ply', 'format ascii 1.0', `element vertex ${gesturePositions.length}`,
    ...names.map(name => `property float ${name}`), 'end_header', ...gesturePositions.map((point, i) =>
      [...point, ...rgb[i].map(value => (value - .5) / .2820947918), Math.log(.9 / .1), scale, scale, scale, 1, 0, 0, 0].join(' ')), ''].join('\n'));
}
