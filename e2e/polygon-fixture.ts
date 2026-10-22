// ID 1 lies inside the final rectangle-shaped polygon. ID 2 has its center
// outside the right edge while its 3-sigma footprint intersects that edge.
// IDs 0/3 are independent baseline and Redo islands, outside both masks.
export const polygonPositions = [[-.7, -.65, 0], [.2, 0, 0], [.65, 0, 0], [-.7, .65, 0]];
export const polygonWorldOutline = [[-.05, -.3, 0], [.5, -.3, 0], [.5, .3, 0], [-.05, .3, 0]];
export const polygonCenterIds = [1], polygonTouchedIds = [1, 2], polygonBaselineIds = [0, 2];
export function polygonPly() {
  const rgb = [[.85, .15, .15], [.15, .85, .15], [.15, .15, .85], [.85, .85, .15]];
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  return new TextEncoder().encode(['ply', 'format ascii 1.0', `element vertex ${polygonPositions.length}`,
    ...names.map(name => `property float ${name}`), 'end_header', ...polygonPositions.map((point, i) => {
      const scale = Math.log(i === 2 ? .08 : .025);
      return [...point, ...rgb[i].map(value => (value - .5) / .2820947918), Math.log(.9 / .1), scale, scale, scale, 1, 0, 0, 0].join(' ');
    }), ''].join('\n'));
}
