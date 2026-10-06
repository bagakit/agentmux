export type NoteCanvasBlockPort = { blockId: string; top: number }
export type NoteCanvasBlockRows = { original: HTMLElement | null; byId: ReadonlyMap<string, readonly HTMLElement[]> }

/** Refresh only when the displayed original DOM or its requested identities change. */
export function findNoteCanvasBlockRows(body: HTMLElement, requested: readonly string[]): NoteCanvasBlockRows {
  const original = body.querySelector<HTMLElement>('.mobile-note-body'), wanted = new Set(requested), byId = new Map<string, HTMLElement[]>()
  for (const row of original?.querySelectorAll<HTMLElement>('[data-block-id]') ?? []) {
    const id = row.dataset.blockId
    // An embedded Reader is another projection, even if it repeats this original block identity.
    if (!id || !wanted.has(id) || row.closest('.mobile-note-body') !== original) continue
    const held = byId.get(id) ?? []; held.push(row); byId.set(id, held)
  }
  return { original, byId }
}

/** Geometry only: callers supply original rows for identities confirmed against the displayed snapshot. */
export function measureNoteCanvasBlockPorts(card: HTMLElement, body: HTMLElement, rows: NoteCanvasBlockRows): NoteCanvasBlockPort[] {
  const cardBox = card.getBoundingClientRect(), viewport = body.getBoundingClientRect()
  const scale = cardBox.width / card.offsetWidth
  if (!rows.original || !Number.isFinite(scale) || scale <= 0 || viewport.width <= 0 || viewport.height <= 0) return []
  const ports: NoteCanvasBlockPort[] = []
  for (const [blockId, held] of rows.byId) {
    if (held.length !== 1) continue
    const box = held[0]!.getBoundingClientRect()
    const top = Math.max(box.top, viewport.top), bottom = Math.min(box.bottom, viewport.bottom)
    if (box.width <= 0 || top >= bottom || box.right <= viewport.left || box.left >= viewport.right) continue
    ports.push({ blockId, top: ((top + bottom) / 2 - cardBox.top) / scale - card.clientTop })
  }
  return ports
}
