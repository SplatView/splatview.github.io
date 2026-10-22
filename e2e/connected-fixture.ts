type Point = { position: number[]; color: number[]; opacity?: number; sigma?: number };
export const connectedPositions = [[-.6, 0, 0], [-.42, 0, 0], [-.24, 0, 0], [.7, 0, 0]];
const colors = [[.6, .4, .3], [.62, .4, .3], [.8, .4, .3], [.6, .4, .3]];
export const mixedPositions = [[-.4, 0, -.08], [-.4, 0, .08], [.6, 0, -.08]];
function ply(points: Point[]) {
  const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = ['ply', 'format ascii 1.0', `element vertex ${points.length}`, ...properties.map(name => `property float ${name}`), 'end_header'];
  return new TextEncoder().encode([...header, ...points.map(({ position, color, opacity = .85, sigma = .1 }) => {
    const scale = Math.log(sigma);
    return [...position, ...color.map(value => (value - .5) / .2820947918), Math.log(opacity / (1 - opacity)), scale, scale, scale, 1, 0, 0, 0].join(' ');
  }), ''].join('\n'));
}
export function connectedPly() {
  // One overlapping island plus one disconnected equal source color.
  return ply(connectedPositions.map((position, i) => ({ position, color: colors[i] })));
}
export function mixedPly() {
  // Red contributes .55 at its center; the blue rear layer contributes about
  // .45*.95=.4275. The winner is red, but the composited seed is purple.
  // Native source SH matching must still use the red contributor's color.
  return ply(mixedPositions.map((position, i) => ({ position, color: i === 1 ? [.1, .1, .9] : [.9, .1, .1], opacity: i === 1 ? .95 : .55 })));
}
