import type { FilterGizmoFrame } from '../document/filterGizmo';

// Both native adapters supply the same bounded presentation records. Reading
// primitive endpoints/radii here does not compose a scene or widget transform.
export function GizmoDrawing({ frame, capturedHandle = 0, enabled = true, target = 'filter' }: {
  frame: FilterGizmoFrame; capturedHandle?: number; enabled?: boolean; target?: 'filter' | 'transform';
}) {
  const highlighted = capturedHandle || frame.hitHandle;
  return <svg className={`filter-gizmo-overlay${target === 'transform' ? ' transform-gizmo-overlay' : ''}${enabled ? '' : ' filter-gizmo-disabled'}`}
    aria-hidden="true" data-filter-gizmo={target === 'filter' ? true : undefined} data-transform-gizmo={target === 'transform' ? true : undefined}
    data-gizmo-hit={frame.hitHandle} data-gizmo-captured={capturedHandle || undefined}>
    {frame.primitives.map((primitive, index) => {
      const points = primitive.points, attributes = {
        className: `filter-gizmo-role-${primitive.role} ${primitive.type === 3 && primitive.handle >= 4 && primitive.handle <= 6 ? 'filter-gizmo-plane' : ''} ${primitive.handle && primitive.handle === highlighted ? 'filter-gizmo-highlight' : ''}`,
        'data-gizmo-handle': primitive.handle || undefined, 'data-gizmo-role': primitive.role,
        strokeWidth: primitive.weight,
      };
      if (primitive.type === 0) return <line key={index} {...attributes} x1={points[0]} y1={points[1]} x2={points[2]} y2={points[3]} />;
      if (primitive.type === 1) return <circle key={index} {...attributes} cx={points[0]} cy={points[1]} r={points[2]} />;
      if (primitive.type === 2) return <rect key={index} {...attributes} x={points[0] - points[2]} y={points[1] - points[2]} width={2 * points[2]} height={2 * points[2]} />;
      return <polygon key={index} {...attributes} points={[0, 2, 4, 6].map(at => `${points[at]},${points[at + 1]}`).join(' ')} />;
    })}
  </svg>;
}
