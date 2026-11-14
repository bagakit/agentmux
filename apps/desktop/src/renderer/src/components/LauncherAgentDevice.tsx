import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { HostConfig, WorkspaceRecord } from '../../../shared/contracts'
import { isScratchWorkspaceId } from '../../../shared/contracts'
import { useAppStore, type LauncherExecutionSelection } from '../store'
import { agentWorkModeLabel, launcherWorkPlacement, workReferenceHostId, workHostLabel } from '../lib/agent-work-mode'
import { AgentWorkModeSetup } from './AgentWorkModeSetup'
import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const ModeIcon = semanticIconComponent('object.remote-execution')
const DownIcon = semanticIconComponent('navigation.down')
const NO_WORKSPACES: WorkspaceRecord[] = []

/** One compact entry for every direction, editing the original unstarted Launcher only. */
export function LauncherAgentDevice({ hosts, workspace, agentWorkspace, explicitAgentWorkspaceId, disabled, active, onSelect, onPreparingChange, onEditArrangement }: {
  hosts: HostConfig[]; workspace: WorkspaceRecord | undefined; agentWorkspace: WorkspaceRecord | undefined
  explicitAgentWorkspaceId: string | undefined; disabled: boolean; active: boolean
  onSelect(selection: LauncherExecutionSelection): boolean
  onPreparingChange(pending: boolean): void
  onEditArrangement?: (() => void) | undefined
}) {
  const workspaces = useAppStore(state => state.config?.workspaces ?? NO_WORKSPACES)
  const [open, setOpen] = useState(false), [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  const surface = useRef<HTMLDivElement>(null)
  const attach = useCallback((node: HTMLDivElement | null) => { surface.current = node; setContent(node) }, [])
  useEffect(() => { onPreparingChange(open && active); return () => onPreparingChange(false) }, [open, active])
  useEffect(() => { if (!active) setOpen(false) }, [active])
  useEffect(() => { setOpen(false) }, [workspace?.id, workspace?.hostId, workspace?.path])
  useLayoutEffect(() => {
    if (!open || !active || !anchor || !content) return
    let current = true
    const position = async () => {
      const result = await computePosition(anchor, content, { strategy: 'fixed', placement: 'bottom-end', middleware: [offset(8), flip(), shift({ padding: 12 }),
        size({ padding: 12, apply: ({ availableHeight, availableWidth }) => {
          if (current) Object.assign(content.style, { maxHeight: `${Math.max(0, availableHeight)}px`, maxWidth: `${Math.max(0, availableWidth)}px` })
        } })] })
      if (current) Object.assign(content.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, content, () => { void position() })
    return () => { current = false; stop() }
  }, [open, active, anchor, content])
  if (!workspace) return null
  const selectedAgent = explicitAgentWorkspaceId === undefined ? agentWorkspace ?? workspace : agentWorkspace
  const placement = launcherWorkPlacement(workspace, selectedAgent,
    isScratchWorkspaceId(workspace.id) ? workReferenceHostId(hosts) : workspace.hostId)
  if (isScratchWorkspaceId(workspace.id)) return <span className="launcher-work-arrangement" title="This context keeps its original project and Agent. Split tools require registered project folders.">
    <ModeIcon size={12} /><span>{agentWorkModeLabel(placement.mode)}</span>{onEditArrangement ? <button className="agent-work-text-action" type="button" onClick={onEditArrangement}>Remote work</button> : null}
  </span>
  return <Dialog.Root modal={false} open={open && active} onOpenChange={setOpen}>
    <span className="launcher-work-arrangement"><Dialog.Trigger asChild><button ref={setAnchor} type="button" className="launcher-work-arrangement__trigger" disabled={disabled || !active}
      aria-label="Agent location" title={`Agent on ${workHostLabel(hosts, placement.agentHostId)} · Project on ${workHostLabel(hosts, placement.projectHostId)}`}>
      <AgentWorkModeBadge placement={placement} hosts={hosts} showLocal hideTooltip={open || !active} /><DownIcon size={11} /></button></Dialog.Trigger></span>
    <DocumentOverlayPortal component={Dialog.Portal}>
      <Dialog.Content ref={attach} className="launcher-work-arrangement__dialog" style={{ visibility: 'hidden' }}
        onOpenAutoFocus={event => { event.preventDefault(); surface.current?.focus({ preventScroll: true }) }}>
        <Dialog.Title>Choose the Agent’s device</Dialog.Title>
        <Dialog.Description>Choose a device to run the Agent for this project.</Dialog.Description>
        <AgentWorkModeSetup config={{ hosts, workspaces }} active={active && open} allowLocal actionLabel="Apply" disabled={disabled}
          fixedResourceWorkspaceId={workspace.id}
          initialSelection={{ resourceWorkspaceId: workspace.id, agentWorkspaceId: explicitAgentWorkspaceId ?? null }}
          onCancel={() => setOpen(false)} onApply={selection => { const applied = onSelect(selection); if (applied) setOpen(false); return applied }} />
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
