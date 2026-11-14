import * as Dialog from '@agentmux/client-ui/components/Modal'
import { Button } from '@agentmux/client-ui/components/Button'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { mintObjectId } from '@agentmux/core/object-id'
import { useAppStore } from '../store'
import { surveyCompositionDestinations, type SurveyCompositionDestinationIntent } from '../lib/survey-composition-destinations'
import type { SurveyCompositionSource, SurveyCompositionRequest } from '../lib/survey-tab-composition'
import { surveyExplorationName } from '../lib/survey-exploration-name'
import { SelectionField } from './SelectionField'
import { DocumentOverlayPortal } from './WindowOverlayHost'

/** One opening holds its original source; target choices always name exact existing display Groups. */
export function SurveyMoveTabsDialog({ sources, catalog, visible, onClose, intent, requestId, surveyGroupId, onMoved, onUnconfirmed }: {
  onMoved?(): void
  onUnconfirmed?(requestId: string): void
  intent?: SurveyCompositionDestinationIntent; requestId?: string
  surveyGroupId?: string | null
  sources: readonly SurveyCompositionSource[]; catalog: AgentMuxSpaceCatalog | null; visible: boolean; onClose(): void
}) {
  const names = useAppStore(state => state.surveyExplorationNames), collected = useAppStore(state => state.surveyCollectedZones)
  const layouts = useAppStore(state => state.layouts), config = useAppStore(state => state.config), tabs = useAppStore(state => state.tabs)
  const [chosen, setChosen] = useState(''), [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const [consumed, setConsumed] = useState(false), mounted = useRef(true), pending = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const destinations = surveyCompositionDestinations({ config, tabs, layouts, surveyCollectedZones: collected, surveyExplorationNames: names }, catalog, sources, intent)
  const destination = destinations.find(item => item.value === chosen)
  const pageCount = sources.filter(source => source.kind === 'page').length, tabCount = sources.length - pageCount
  const pageOnly = tabCount === 0, mixed = pageCount > 0 && tabCount > 0
  const moveLabel = mixed ? 'Move content' : pageOnly ? sources.length > 1 ? 'Move pages' : 'Move page' : sources.length > 1 ? 'Move Tabs' : 'Move Tab'
  const scope = [pageCount ? `${pageCount} exact ${pageCount === 1 ? 'page' : 'pages'}` : '', tabCount ? `${tabCount} complete ${tabCount === 1 ? 'Tab' : 'Tabs'}` : ''].filter(Boolean).join(' · ')

  const newResearch = intent?.kind === 'new-research', placeholder = newResearch ? 'Choose a location…' : 'Choose a research…'
  async function move() {
    if (!destination || pending.current || consumed) return
    pending.current = true; setBusy(true); setIssue(null)
    const result = await useAppStore.getState().composeSurveyTabs({ requestId: requestId ?? mintObjectId(), sources, target: destination.target,
      ...(surveyGroupId === undefined ? {} : { surveyGroupId }) })
    pending.current = false
    if (!mounted.current) return
    setBusy(false)
    if (result.outcome === 'moved') { onMoved?.(); onClose() }
    else if (result.outcome === 'unknown' || result.outcome === 'partial') { onUnconfirmed?.(result.requestId); onClose() }
    else { setIssue(result.issue ?? 'The original move is unconfirmed. Read its source and target before another request.'); setConsumed(result.outcome !== 'refused') }
  }
  return <Dialog.Root open={visible} onOpenChange={open => { if (!open) onClose() }}>
    <DocumentOverlayPortal component={Dialog.Portal}><Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="confirmation-dialog dialog-surface">
        <Dialog.Title className="confirmation-dialog__title">{intent?.kind === 'new-research' ? 'Combine into new research' : `${moveLabel} to research`}</Dialog.Title>
        <Dialog.Description className="confirmation-dialog__description">{intent?.kind === 'new-research' ? 'Keep these original pages and Tabs. Choose where this independent research belongs.' : mixed ? 'Move only the selected exact pages and complete Tabs. Other panels stay in place.' : pageOnly ? 'Move only the selected pages. Other panels in their current Tabs stay in place.' : 'Keep each selected Tab’s pages, notes and running Agents together.'} Choose the research and its exact display location.</Dialog.Description>
        {sources.length > 1 ? <details className="confirmation-dialog__description"><summary>{scope}</summary><ul>
          {sources.map((source, index) => <li key={index}>{source.kind === 'page'
            ? `Page · ${(source.tab.regions[source.regionId] as { title?: string }).title || 'Original page'}`
            : `Complete Tab · ${surveyExplorationName(undefined, [source.tab])}`}</li>)}
        </ul></details> : null}
        <SelectionField label={newResearch ? "Research location" : "Destination research"} value={chosen} triggerLabel={destination ? undefined : placeholder}
          options={[{ value: '', label: placeholder, disabled: true }, ...destinations]} onValueChange={setChosen} disabled={busy || consumed} searchable />
        {!destinations.length ? <p role="status" className="confirmation-dialog__description">{newResearch ? 'An original location is not confirmed. Restore that position, then combine this same content.' : 'Create another research first. Your original content stays here.'}</p> : null}
        {issue ? <p role="alert" className="surface-inline-error">{issue}</p> : null}
        <footer className="confirmation-dialog__actions"><Button type="button" onClick={onClose}>{busy ? 'Keep working' : 'Cancel'}</Button>
          <Button type="button" variant="secondary" disabled={!destination || busy || consumed} onClick={() => void move()}>{busy ? 'Moving…' : intent?.kind === 'new-research' ? 'Create research' : moveLabel}</Button></footer>
      </Dialog.Content>
    </DocumentOverlayPortal>
  </Dialog.Root>
}
