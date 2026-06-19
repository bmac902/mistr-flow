export interface OverlayPosition {
  x: number;
  y: number;
}

export interface OverlayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const OVERLAY_WINDOW_WIDTH = 292;
export const OVERLAY_WINDOW_HEIGHT = 178;
export const OVERLAY_BOTTOM_MARGIN = 6;

export function resolveOverlayPosition({
  workArea,
  savedPosition,
}: {
  workArea: OverlayWorkArea;
  savedPosition?: OverlayPosition | null;
}): OverlayPosition {
  const position = isFiniteOverlayPosition(savedPosition)
    ? savedPosition
    : getDefaultOverlayPosition(workArea);

  return clampOverlayPosition(position, workArea);
}

export function getDefaultOverlayPosition(workArea: OverlayWorkArea): OverlayPosition {
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WINDOW_WIDTH) / 2),
    y: workArea.y + workArea.height - OVERLAY_WINDOW_HEIGHT - OVERLAY_BOTTOM_MARGIN,
  };
}

export function clampOverlayPosition(
  position: OverlayPosition,
  workArea: OverlayWorkArea,
): OverlayPosition {
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - OVERLAY_WINDOW_WIDTH);
  const maxY = Math.max(minY, workArea.y + workArea.height - OVERLAY_WINDOW_HEIGHT);

  return {
    x: clamp(Math.round(position.x), minX, maxX),
    y: clamp(Math.round(position.y), minY, maxY),
  };
}

export function isFiniteOverlayPosition(value: unknown): value is OverlayPosition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OverlayPosition>;
  return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
