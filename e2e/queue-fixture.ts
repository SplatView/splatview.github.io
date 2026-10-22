export const queuePositions = [[-.6, 0, 0], [-.42, 0, 0], [-.24, 0, 0], [.7, 0, 0], [0, .85, 0]];
export function queuePly() {
  // Three touching footprints, a disconnected equal-color island, and a
  // separate blue island give independent RGB and opacity queue oracles.
  const rgb = [[.6, .4, .3], [.62, .4, .3], [.8, .4, .3], [.6, .4, .3], [.1, .2, .9]];
  const alpha = [.85, .5, .2, .85, .85], scale = Math.log(.1);
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  return new TextEncoder().encode(['ply', 'format ascii 1.0', `element vertex ${queuePositions.length}`,
    ...names.map(name => `property float ${name}`), 'end_header', ...queuePositions.map((point, i) =>
      [...point, ...rgb[i].map(value => (value - .5) / .2820947918), Math.log(alpha[i] / (1 - alpha[i])), scale, scale, scale, 1, 0, 0, 0].join(' ')), ''].join('\n'));
}
