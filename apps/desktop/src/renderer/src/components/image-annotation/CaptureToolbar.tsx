import type { ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { RovingToolbar, RovingToolbarButton } from '../RovingToolbar'
import { ANNOTATION_TOOLS, type AnnotationTool } from './AnnotationToolbar'

const icon = semanticIconComponent
const PinIcon = icon('action.pin'), SaveIcon = icon('action.save'), ExpandIcon = icon('layout.expand'), CloseIcon = icon('action.close')
/** The marks a capture selection offers, in toolbar order; labels, icons and keys are the shared editor's. */
export const CAPTURE_TOOLS = (['rect', 'ellipse', 'arrow', 'pen', 'pixelate', 'blur', 'text', 'note', 'callout'] as const).map(id => ANNOTATION_TOOLS.find(item => item.id === id)!)

export function CaptureToolbar({ tool, busy, loaded, label, discard, onTool, onPin, onSavePng, onExpand, onCancel, onComplete }: {
  tool: AnnotationTool; busy: boolean; loaded: boolean
  /** The primary delivery's visible name. */
  label: string
  /** The in-place discard confirmation, shown instead of Cancel. */
  discard: ReactNode
  onTool(tool: AnnotationTool): void; onPin(): void; onSavePng(): void; onExpand(): void; onCancel(): void; onComplete(): void
}) {
  const divider = <span className="image-annotation-capture-toolbar__divider" aria-hidden="true" />
  return <RovingToolbar className="image-annotation-capture-toolbar" aria-label="Capture tools">
    {/* Pressing the current mark again returns to adjusting the selection. */}
    <div className="image-annotation-capture-toolbar__group" role="group" aria-label="Marks">{CAPTURE_TOOLS.map(item => <RovingToolbarButton key={item.id} type="button"
      aria-label={item.label} title={item.label + ' (' + item.key + ')'} aria-keyshortcuts={item.key} aria-pressed={tool === item.id} disabled={busy}
      onClick={() => onTool(tool === item.id ? 'select' : item.id)}><item.icon size={15} /></RovingToolbarButton>)}</div>
    {divider}
    <div className="image-annotation-capture-toolbar__group" role="group" aria-label="Output">
      <RovingToolbarButton type="button" aria-label="Pin image" title="Pin (⌘P)" aria-keyshortcuts="Meta+P" disabled={busy || !loaded} onClick={onPin}><PinIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Save PNG" title="Save PNG (⌘S)" aria-keyshortcuts="Meta+S" disabled={busy || !loaded} onClick={onSavePng}><SaveIcon size={15} /></RovingToolbarButton>
    </div>
    {divider}
    <RovingToolbarButton type="button" aria-label="Expand editor" title="Expand editor (⌘E)" aria-keyshortcuts="Meta+E" disabled={busy} onClick={onExpand}><ExpandIcon size={14} /></RovingToolbarButton>
    {divider}
    {discard ?? <RovingToolbarButton type="button" aria-label="Cancel" title="Cancel (Esc)" aria-keyshortcuts="Escape" onClick={onCancel}><CloseIcon size={14} /></RovingToolbarButton>}
    <RovingToolbarButton type="button" className="primary-button" aria-label={label} title={label + ' (↵)'} aria-keyshortcuts="Enter" disabled={busy || !loaded} onClick={onComplete}>
      {label}<kbd aria-hidden="true">↵</kbd>
    </RovingToolbarButton>
  </RovingToolbar>
}

/** The one line a capture shows before its selection exists, with the Cancel entry the toolbar carries afterwards. */
export function CaptureHint({ text, onCancel }: { text: string; onCancel(): void }) {
  return <div className="image-annotation-editor__capture-hint">
    <span>{text}</span>
    <button type="button" aria-label="Cancel" title="Cancel (Esc)" aria-keyshortcuts="Escape" onClick={onCancel}><CloseIcon size={14} /></button>
  </div>
}
