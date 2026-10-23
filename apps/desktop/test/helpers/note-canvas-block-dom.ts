import { vi } from 'vitest'

/** Browser geometry fixture only; original Files/Reader/ReactFlow continue to execute. */
export function installNoteCanvasBlockRows() {
  const state = { scale: 1, rows: { 'target-block': 140, 'source-reference-0': 120, 'source-reference-1': 170, 'source-reference-2': 220, 'source-inline': 270 } as Record<string, number>, reads: 0 }
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.react-flow__node,.note-canvas-card') ? 288 : 900 })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.matches('.react-flow__node,.note-canvas-card') ? 600 : 600 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const card = this.closest<HTMLElement>('.note-canvas-card'), node = this.closest<HTMLElement>('.react-flow__node'), id = node?.dataset.id
    if (!card && !this.classList.contains('react-flow__node')) return new DOMRect(0, 0, 900, 600)
    const x = id === 'target' ? 500 : 0, y = 100, scale = state.scale
    const rect = (left: number, top: number, width: number, height: number) => new DOMRect(x + left * scale, y + top * scale, width * scale, height * scale)
    if (this.matches('.note-canvas-card,.react-flow__node')) return rect(0, 0, 288, 600)
    if (this.matches('.note-canvas-body')) return rect(1, 80, 286, 240)
    if (this.dataset.blockId) { state.reads++; return rect(15, state.rows[this.dataset.blockId] ?? 1000, 258, 30) }
    if (this.matches('.react-flow__handle')) {
      const exact = this.closest<HTMLElement>('.note-canvas-row-endpoint')
      return rect(this.dataset.handlepos === 'left' ? -2.5 : 285.5, exact ? Number.parseFloat(exact.style.top) - 2.5 : this.closest('header') ? 42 : 450, 5, 5)
    }
    return rect(1, 80, 286, 240)
  })
  return state
}
