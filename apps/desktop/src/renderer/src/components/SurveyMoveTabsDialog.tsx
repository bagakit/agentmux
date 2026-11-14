import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { groupIds } from '@agentmux/layout'
import { mintObjectId } from '@agentmux/core/object-id'
import { useAppStore } from '../store'
import { surveyExplorationName } from '../lib/survey-exploration-name'
import type { SurveyCompositionSource, SurveyCompositionRequest } from '../lib/survey-tab-composition'
import { SelectionField } from './SelectionField'
import { DocumentOverlayPortal } from './WindowOverlayHost'

/** One opening holds its original source; target choices always name exact existing display Groups. */
export function SurveyMoveTabsDialog({ sources, catalog, visible, onClose }: {
  sources: readonly SurveyCompositionSource[]; catalog: AgentMuxSpaceCatalog | null; visible: boolean; onClose(): void
}) {
  const names = useAppStore(state => state.surveyExplorationNames), collected = useAppStore(state => state.surveyCollectedZones)
  const layouts = useAppStore(state => state.layouts), config = useAppStore(state => state.config), tabs = useAppStore(state => state.tabs)
  const [chosen, setChosen] = useState(''), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const [consumed, setConsumed] = useState(false), mounted = useRef(true), pending = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const destinations: { value: string; label: string; description: string; target: SurveyCompositionRequest['target'] }[] = []
  for (const zone of catalog?.zones ?? []) {
    if (!collected[zone.zoneId] || sources.every(source => source.zoneId === zone.zoneId)) continue
    const locations = catalog!.locations.filter(location => location.zoneId === zone.zoneId)
    const seen = new Set<string>()
    const groups = locations.length ? locations.map(location => ({ displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId }))
      : (layouts[zone.workspaceId]?.groups ?? []).map(group => ({ displayWorkspaceId: zone.workspaceId, groupId: group.id }))
    for (const position of groups) {
      const layout = layouts[position.displayWorkspaceId]
      if (!layout || !groupIds(layout.root).includes(position.groupId)) continue
      const value = JSON.stringify([zone.zoneId, position.displayWorkspaceId, position.groupId])
      if (seen.has(value)) continue
      seen.add(value)
      const members = catalog!.tabs.filter(tab => tab.zoneId === zone.zoneId).flatMap(tab => tabs[tab.tabId] ? [tabs[tab.tabId]!] : [])
      destinations.push({ value, label: surveyExplorationName(names[zone.zoneId], members),
        description: `${config?.workspaces.find(workspace => workspace.id === position.displayWorkspaceId)?.name ?? 'Original workspace'} · Group ${groupIds(layout.root).indexOf(position.groupId) + 1}`,
        target: { zoneId: zone.zoneId, workspaceId: zone.workspaceId, ...position } })
    }
  }
  const destination = destinations.find(item => item.value === chosen)
  const pageOnly = sources.every(source => source.kind === 'page')
  async function move() {
    if (!destination || pending.current || consumed) return
    pending.current = true; setBusy(true); setIssue(null)
    const result = await useAppStore.getState().composeSurveyTabs({ requestId: mintObjectId(), sources, target: destination.target })
    pending.current = false
    if (!mounted.current) return
    setBusy(false)
    if (result.outcome === 'moved') onClose()
    else { setIssue(result.issue ?? 'The original move is unconfirmed. Read its source and target before another request.'); setConsumed(result.outcome !== 'refused') }
  }
  return <Dialog.Root open={visible} onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface">
        <Dialog.Title className="confirmation-dialog__title">{pageOnly ? 'Move page to research' : 'Move Tab to research'}</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">{pageOnly ? 'Move only this page. Other panels in its current Tab stay in place.' : 'Keep this Tab’s pages, notes and running Agents together.'} Choose the research and its exact display location.</Dialog.Description>
        <SelectionField label="Destination research" value={chosen} triggerLabel={destination ? undefined : 'Choose a research…'}
          options={[{ value: '', label: 'Choose a research…', disabled: true }, ...destinations]} onValueChange={setChosen} disabled={busy || consumed} searchable />
        {!destinations.length ? <p role="status" className="confirmation-dialog__description">Create another research first. Your original content stays here.</p> : null}
        {issue ? <p role="alert" className="surface-inline-error">{issue}</p> : null}
        <footer className="confirmation-dialog__actions"><Button type="button" onClick={onClose}>{busy ? 'Keep working' : 'Cancel'}</Button>
          <Button type="button" variant="secondary" disabled={!destination || busy || consumed} onClick={() => void move()}>{busy ? 'Moving…' : pageOnly ? 'Move page' : 'Move Tab'}</Button></footer>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
