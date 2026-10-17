import * as Menu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactNode } from 'react'
import { terminalMenuChords } from '../lib/terminal-menu-chords'
import { isMacPlatform } from '../lib/host-platform'
import type { TerminalFileMenuAction } from '../lib/terminal-file-action'
import { terminalSelectionSuppressionHint, type MouseTrackingMode } from '../lib/terminal-selection-mode'
import { moveAlongWorkbenchActionRow, WorkbenchActionRows } from './WorkbenchActionRows'

export type TerminalMenuToolProps = {
  hasSelection: boolean; historyBoundary: string | null; mouseTrackingMode: MouseTrackingMode
  pathActions: readonly TerminalFileMenuAction[]
  onClear(): void; onCopy(): void; onCopyScrollback(): void; onCopyViewport(): void
  onPaste(): void; onSearch(): void; onSelectAll(): void; onScrollToBottom(): void
}

const Copy = semanticIconComponent('action.copy'), Paste = semanticIconComponent('action.paste')
const Select = semanticIconComponent('action.select-text'), Find = semanticIconComponent('action.search')
const Document = semanticIconComponent('object.document'), Bottom = semanticIconComponent('action.current')
const Clear = semanticIconComponent('action.erase')
type Action = { name: string; label: string; icon: ReactNode; onSelect(): void; disabled?: boolean }

/** Original terminal operations in compact rows, without another menu or control owner. */
export function TerminalMenuTools(props: TerminalMenuToolProps) {
  const chords = terminalMenuChords(isMacPlatform())
  const hint = terminalSelectionSuppressionHint(props.mouseTrackingMode)
  const text: Action[] = [
    { name: 'Copy', label: `Copy · ${chords.copy}`, icon: <Copy size={16} />, onSelect: props.onCopy, disabled: !props.hasSelection },
    { name: 'Paste', label: `Paste · ${chords.paste}`, icon: <Paste size={16} />, onSelect: props.onPaste },
    { name: 'Select all', label: 'Select all', icon: <Select size={16} />, onSelect: props.onSelectAll },
    { name: 'Find', label: `Find · ${chords.search}`, icon: <Find size={16} />, onSelect: props.onSearch }
  ]
  const output: Action[] = [
    { name: 'Copy visible output', label: 'Copy visible output', icon: <Copy size={16} />, onSelect: props.onCopyViewport },
    { name: 'Copy all output', label: 'Copy all output', icon: <Document size={16} />, onSelect: props.onCopyScrollback },
    { name: 'Scroll to bottom', label: 'Scroll to bottom', icon: <Bottom size={16} />, onSelect: props.onScrollToBottom },
    { name: 'Clear terminal', label: `Clear terminal · ${chords.clear}`, icon: <Clear size={16} />, onSelect: props.onClear }
  ]
  const renderRow = (id: string, label: string, actions: Action[]) => <WorkbenchActionRows
    Group={Menu.Group} Label={Menu.Label} rows={[{ id, label, clusters: [actions] }]} itemKey={action => action.name}
    renderItem={(action, attributes) => <Menu.Item {...attributes} className="tab-context-menu__item workbench-menu-row__item"
      aria-label={action.name} aria-description={action.label} textValue={action.name} disabled={action.disabled ?? false}
      onSelect={action.onSelect} onKeyDown={moveAlongWorkbenchActionRow}>{action.icon}</Menu.Item>} />
  return <div data-terminal-menu-tools="">
    {renderRow('terminal-text', 'Text', text)}
    {hint ? <Menu.Label className="tab-context-menu__hint" role="note">{hint}</Menu.Label> : null}
    {renderRow('terminal-output', 'Output', output)}
    {props.historyBoundary ? <Menu.Label className="tab-context-menu__hint" role="note">{props.historyBoundary}</Menu.Label> : null}
    {props.pathActions.map(action => <Menu.Item key={action.key} className="tab-context-menu__item"
      title={action.title} onSelect={action.onSelect}><action.icon size={14} /><span>{action.label}</span></Menu.Item>)}
  </div>
}
