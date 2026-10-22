// Same SH0 color, different opacities. The first three Gaussian footprints
// overlap into one island; the fourth is separated by transparent background.
// Fill must follow opacity connectivity, unlike ordinary scene-wide Color.
export const fillPositions = [[-.6, 0, 0], [-.42, 0, 0], [-.24, 0, 0], [.7, 0, 0]];
export function fillPly() {
  const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = ['ply', 'format ascii 1.0', `element vertex ${fillPositions.length}`,
    ...properties.map(name => `property float ${name}`), 'end_header'];
  const opacity = [.85, .5, .2, .85], scale = Math.log(.1);
  return new TextEncoder().encode([...header, ...fillPositions.map((point, index) =>
    [...point, 0, 0, 0, Math.log(opacity[index] / (1 - opacity[index])), scale, scale, scale, 1, 0, 0, 0].join(' ')), ''].join('\n'));
}
