// Pinned SplatView v1.0.2 ui_widgets.hpp:240-250. The caller retains the
// existing glyph slot and control ownership; CSS supplies size and state color.
export function DecorativeChevron({ direction = 'down' }: { direction?: 'down' | 'right' }) {
  return <svg className="desktop-chevron" data-direction={direction} viewBox="-5 -5 10 10" width="10" height="10"
    aria-hidden="true" focusable="false">
    <polyline points={direction === 'right' ? '-1.25,-2.5 1.25,0 -1.25,2.5' : '-2.5,-1.25 0,1.25 2.5,-1.25'}
      fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="butt" strokeLinejoin="miter" />
  </svg>;
}
