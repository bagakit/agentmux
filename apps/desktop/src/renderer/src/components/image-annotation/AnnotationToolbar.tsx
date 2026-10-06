import { RovingToolbar, RovingToolbarButton } from '../RovingToolbar'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ScreenshotTool } from './drawing-model'

export type AnnotationTool = ScreenshotTool | 'select' | 'pan' | 'erase' | 'crop' | 'pixelate' | 'cover' | 'note'
const icon = semanticIconComponent
export const ANNOTATION_TOOLS: Array<{ id: AnnotationTool; label: string; key: string; icon: ReturnType<typeof icon> }> = [
  { id: 'select', label: 'Select', key: 'V', icon: icon('drawing.select') },
  { id: 'pan', label: 'Pan', key: 'Space', icon: icon('action.pan') },
  { id: 'pen', label: 'Pen', key: 'P', icon: icon('drawing.freehand') },
  { id: 'highlight', label: 'Highlighter', key: 'H', icon: icon('drawing.highlight') },
  { id: 'arrow', label: 'Arrow', key: 'A', icon: icon('drawing.arrow') },
  { id: 'rect', label: 'Rectangle', key: 'R', icon: icon('drawing.rectangle') },
  { id: 'ellipse', label: 'Ellipse', key: 'E', icon: icon('drawing.circle') },
  { id: 'text', label: 'Text', key: 'T', icon: icon('drawing.text') },
  { id: 'note', label: 'Numbered note', key: 'N', icon: icon('drawing.note') },
  { id: 'crop', label: 'Crop', key: 'C', icon: icon('drawing.crop') },
  { id: 'pixelate', label: 'Pixelate', key: 'M', icon: icon('drawing.pixelate') },
  { id: 'cover', label: 'Cover', key: 'B', icon: icon('drawing.cover') },
  { id: 'erase', label: 'Erase', key: 'X', icon: icon('action.erase') }
]
const UndoIcon = icon('action.undo'), RedoIcon = icon('action.redo'), DeleteIcon = icon('action.remove')

export function AnnotationToolbar({ tool, busy, undoable, redoable, selected, clearable, onTool, onUndo, onRedo, onDelete, onClear }: {
  tool: AnnotationTool; busy: boolean; undoable: boolean; redoable: boolean; selected: boolean; clearable: boolean
  onTool(tool: AnnotationTool): void; onUndo(): void; onRedo(): void; onDelete(): void; onClear(): void
}) {
  return <RovingToolbar className="image-annotation-toolbar" aria-label="Screenshot markup tools">
    <div className="image-annotation-toolbar__tools">{ANNOTATION_TOOLS.map(item => <RovingToolbarButton key={item.id} type="button"
      aria-label={item.label} title={item.label + ' (' + item.key + ')'} aria-keyshortcuts={item.key}
      aria-pressed={tool === item.id} className={tool === item.id ? 'selected' : ''} disabled={busy && item.id !== 'pan'} onClick={() => onTool(item.id)}>
      <item.icon size={16} />
    </RovingToolbarButton>)}</div>
    <div className="image-annotation-toolbar__history">
      <RovingToolbarButton type="button" aria-label="Undo" title="Undo" disabled={busy || !undoable} onClick={onUndo}><UndoIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Redo" title="Redo" disabled={busy || !redoable} onClick={onRedo}><RedoIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Delete selected" title="Delete selected (Delete)" disabled={busy || !selected} onClick={onDelete}><DeleteIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Clear all" title="Clear all" disabled={busy || !clearable} onClick={onClear}>Clear</RovingToolbarButton>
    </div>
  </RovingToolbar>
}
