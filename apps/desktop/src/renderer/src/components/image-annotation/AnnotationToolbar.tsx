import { useEffect, useState } from 'react'
import * as DropdownMenu from '../DropdownMenu'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { RovingToolbar, RovingToolbarButton, RovingToolbarItem } from '@agentmux/client-ui/components/RovingToolbar'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ScreenshotTool } from '@agentmux/client-ui/image-annotation'

export type AnnotationTool = ScreenshotTool | 'select' | 'pan' | 'erase' | 'crop' | 'pixelate' | 'cover' | 'blur' | 'note' | 'spotlight' | 'callout' | 'wand'
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
  { id: 'spotlight', label: 'Spotlight', key: 'L', icon: icon('drawing.spotlight') },
  { id: 'callout', label: 'Magnifier', key: 'Z', icon: icon('drawing.callout') },
  { id: 'crop', label: 'Crop', key: 'C', icon: icon('drawing.crop') },
  { id: 'wand', label: 'Magic wand', key: 'W', icon: icon('drawing.magic-wand') },
  { id: 'pixelate', label: 'Pixelate', key: 'M', icon: icon('drawing.pixelate') },
  { id: 'cover', label: 'Cover', key: 'B', icon: icon('drawing.cover') },
  { id: 'blur', label: 'Blur', key: 'U', icon: icon('drawing.blur') },
  { id: 'erase', label: 'Erase', key: 'X', icon: icon('action.erase') }
]
const DownIcon = icon('navigation.down')
const SelectionIcon = icon('status.selected')
const UndoIcon = icon('action.undo'), RedoIcon = icon('action.redo'), DeleteIcon = icon('action.remove')
const TOOL_GROUPS: ReadonlyArray<{ label: string; tools: readonly AnnotationTool[] }> = [
  { label: 'View and select', tools: ['select', 'pan'] },
  { label: 'Draw', tools: ['pen', 'highlight', 'arrow', 'rect', 'ellipse'] },
  { label: 'Annotate', tools: ['text', 'note', 'spotlight', 'callout'] },
  { label: 'Process image', tools: ['crop', 'wand', 'pixelate', 'cover', 'blur', 'erase'] }
]

export function AnnotationToolbar({ active = true, tool, busy, undoable, redoable, selected, clearable, onTool, onUndo, onRedo, onDelete, onClear }: {
  active?: boolean; tool: AnnotationTool; busy: boolean; undoable: boolean; redoable: boolean; selected: boolean; clearable: boolean
  onTool(tool: AnnotationTool): void; onUndo(): void; onRedo(): void; onDelete(): void; onClear(): void
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => { if (!active) setOpen(false) }, [active])
  const current = ANNOTATION_TOOLS.find(item => item.id === tool)
  return <RovingToolbar className="image-annotation-toolbar" aria-label="Screenshot markup tools">
    <DropdownMenu.Root modal={false} open={active && open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild><RovingToolbarButton type="button" className="image-annotation-toolbar__compact" aria-label="Markup tool" title="Choose a markup tool">
        {current ? <current.icon size={16} /> : null}<span>{current?.label ?? 'Tools'}</span><DownIcon size={12} />
      </RovingToolbarButton></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu image-annotation-tools-menu" align="start" sideOffset={4} collisionPadding={8}
        onCloseAutoFocus={event => { if (!active) event.preventDefault() }}
        onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault(); else event.stopPropagation() }}>
        <DropdownMenu.RadioGroup value={tool}>{ANNOTATION_TOOLS.map(item => <DropdownMenu.RadioItem className="tab-context-menu__item" key={item.id} value={item.id} aria-label={item.label} aria-keyshortcuts={item.key}
          disabled={busy && item.id !== 'pan'} onSelect={() => onTool(item.id)}><item.icon size={16} /><span>{item.label}</span><kbd>{item.key}</kbd>
          <span className="image-annotation-tools-menu__selection" aria-hidden="true"><DropdownMenu.ItemIndicator asChild><SelectionIcon size={12} /></DropdownMenu.ItemIndicator></span>
        </DropdownMenu.RadioItem>)}</DropdownMenu.RadioGroup>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    <div className="image-annotation-toolbar__tools">{TOOL_GROUPS.map(group => <div key={group.label} className="image-annotation-toolbar__group" role="group" aria-label={group.label}>
      {ANNOTATION_TOOLS.filter(item => group.tools.includes(item.id)).map(item => {
        const current = tool === item.id
        const disabled = busy && item.id !== 'pan'
        return <RovingToolbarItem key={item.id} asChild active={current} focusable={!disabled}>
          <IconButton aria-label={item.label} title={item.label + ' (' + item.key + ')'} aria-keyshortcuts={item.key}
            aria-pressed={current} disabled={disabled} onClick={() => onTool(item.id)}><item.icon size={16} /></IconButton>
        </RovingToolbarItem>
      })}
    </div>)}</div>
    <div className="image-annotation-toolbar__history">
      <RovingToolbarButton type="button" aria-label="Undo" title="Undo" disabled={busy || !undoable} onClick={onUndo}><UndoIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Redo" title="Redo" disabled={busy || !redoable} onClick={onRedo}><RedoIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Delete selected" title="Delete selected (Delete)" disabled={busy || !selected} onClick={onDelete}><DeleteIcon size={15} /></RovingToolbarButton>
      <RovingToolbarButton type="button" aria-label="Clear all" title="Clear all" disabled={busy || !clearable} onClick={onClear}>Clear</RovingToolbarButton>
    </div>
  </RovingToolbar>
}
