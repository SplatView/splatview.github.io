export type ColorMenuKind = 'auto' | 'presets';
export const COLOR_MENU_DELAY = 300;

type Rect = Readonly<{ left: number; right: number; top: number; bottom: number }>;
export type MenuPoint = Readonly<{ x: number; y: number }>;
export function containsMenuPoint(bounds: Rect, point: MenuPoint): boolean {
  return point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
}

/** selection_ui.cpp:148-164: the union is safe only while approaching a side popup. */
export function approachingColorMenu(trigger: Rect, menu: Rect, point: MenuPoint, deltaX: number): boolean {
  return containsMenuPoint({ left: Math.min(trigger.left, menu.left), right: Math.max(trigger.right, menu.right),
    top: Math.min(trigger.top, menu.top), bottom: Math.max(trigger.bottom, menu.bottom) }, point) &&
    (menu.right <= trigger.left && deltaX < 0 || menu.left >= trigger.right && deltaX > 0);
}

/** No DOM, focus, color analysis or frame work: just native selector timing and ownership. */
export class ColorMenuInteraction {
  open: ColorMenuKind | null = null;
  pinned = false;
  hovered: ColorMenuKind | null = null;
  dismissed: ColorMenuKind | null = null;
  private hoverSince = 0;
  private awaySince: number | null = null;

  enter(kind: ColorMenuKind, now: number): void {
    if (this.hovered !== kind) { this.hovered = kind; this.hoverSince = now; }
  }
  leave(kind: ColorMenuKind): void {
    if (this.hovered === kind) this.hovered = null;
    if (this.dismissed === kind) this.dismissed = null;
  }
  show(kind: ColorMenuKind, pin: boolean): void {
    this.open = kind; this.pinned = pin; this.dismissed = null; this.awaySince = null;
  }
  pin(): void { if (this.open) this.pinned = true; }
  dismiss(): void {
    this.dismissed = this.hovered === this.open ? this.open : null;
    this.open = null; this.pinned = false; this.awaySince = null;
  }
  retire(): void { this.dismiss(); this.hovered = null; }

  tick(now: number, overMenu: boolean, approaching: boolean, buttons: number): ColorMenuKind | 'dismiss' | null {
    if (this.hovered && this.hovered !== this.open && this.hovered !== this.dismissed &&
        now - this.hoverSince >= COLOR_MENU_DELAY && !buttons) return this.hovered;
    if (!this.open || this.pinned || this.hovered === this.open || overMenu || approaching) {
      this.awaySince = null; return null;
    }
    this.awaySince ??= now;
    return now - this.awaySince >= COLOR_MENU_DELAY ? 'dismiss' : null;
  }

  /** Idle selectors need no polling; only an outstanding threshold gets a timer. */
  nextDelay(now: number, buttons: number): number | null {
    const hover = this.hovered && this.hovered !== this.open && this.hovered !== this.dismissed && !buttons
      ? this.hoverSince + COLOR_MENU_DELAY : Infinity;
    const away = this.open && !this.pinned && this.awaySince !== null ? this.awaySince + COLOR_MENU_DELAY : Infinity;
    const deadline = Math.min(hover, away);
    return Number.isFinite(deadline) ? Math.max(0, deadline - now) : null;
  }
}
