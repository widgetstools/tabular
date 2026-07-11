/**
 * Interactive action-cluster painter — edit / menu / delete hit regions.
 */
import {
  drawIcon,
  type CellRenderParams,
  type CellRendererComp,
  type HitRegion,
} from '@tabular/core';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyParams = CellRenderParams<any>;

const ACTION_IDS = ['edit', 'menu', 'delete'] as const;
type ActionId = (typeof ACTION_IDS)[number];

function layout(params: AnyParams): { ids: ActionId[]; size: number; gap: number; startX: number; cy: number } {
  const count = 3;
  const size = Math.min(14, Math.max(10, params.height - 10));
  const gap = 6;
  const total = count * size + (count - 1) * gap;
  const startX = params.x + (params.width - total) / 2;
  const cy = params.y + params.height / 2;
  return { ids: [...ACTION_IDS], size, gap, startX, cy };
}

function iconAt(
  layoutInfo: ReturnType<typeof layout>,
  index: number,
): { x: number; y: number; size: number; id: ActionId } {
  const { ids, size, gap, startX, cy } = layoutInfo;
  return {
    id: ids[index]!,
    x: startX + index * (size + gap),
    y: cy - size / 2,
    size,
  };
}

/** Draw a simple pencil (edit) glyph when no dedicated Lucide name exists. */
function drawPencil(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(4, 20);
  ctx.lineTo(8, 20);
  ctx.lineTo(19, 9);
  ctx.lineTo(15, 5);
  ctx.lineTo(4, 16);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(13, 7);
  ctx.lineTo(17, 11);
  ctx.stroke();
  ctx.restore();
}

/** 2–3 icon action cluster with hitTest ids edit | menu | delete. */
export const actionClusterRenderer: CellRendererComp = {
  paint(ctx, params: AnyParams) {
    try {
      const t = params.theme;
      const L = layout(params);
      for (let i = 0; i < L.ids.length; i++) {
        const slot = iconAt(L, i);
        const color = t.textSecondary;
        if (slot.id === 'edit') drawPencil(ctx, slot.x, slot.y, slot.size, color);
        else if (slot.id === 'menu')
          drawIcon(ctx, 'kebab', slot.x, slot.y, slot.size, color, 2.4);
        else drawIcon(ctx, 'x', slot.x, slot.y, slot.size, color, 2.2);
      }
      return true;
    } catch {
      return true;
    }
  },

  hitTest(localX, localY, params: AnyParams): HitRegion | null {
    try {
      const L = layout(params);
      for (let i = 0; i < L.ids.length; i++) {
        const slot = iconAt(L, i);
        // hitTest coords are cell-local; layout uses absolute params.x/y
        const ax = slot.x - params.x;
        const ay = slot.y - params.y;
        if (
          localX >= ax - 2 &&
          localX <= ax + slot.size + 2 &&
          localY >= ay - 2 &&
          localY <= ay + slot.size + 2
        ) {
          return { id: slot.id, cursor: 'pointer' };
        }
      }
      return null;
    } catch {
      return null;
    }
  },
};

export function registerActionRenderers(
  register: (name: string, def: CellRendererComp) => void,
): void {
  register('actionCluster', actionClusterRenderer);
}
