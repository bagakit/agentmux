import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { AgentTurnUsage } from '@agentmux/core'
import type { WorkspaceRecord } from '../../../../shared/contracts'
import type { FocusSettingsValues } from './FocusSettingsPane'
import { AgentContextContent } from '../AgentContextContent'
import { ResolvedAgentAvatar } from '../AgentAvatar'
import { AgentInputEntry, type InputPresentation } from '../AgentInputEntry'
import { AgentInformationSummary } from '../AgentInformationDetails'
import { deriveFocusProjectLanes } from '../../lib/focus-project-lanes'
import { focusCardTrackHeight } from '../../lib/focus-lane-layout'
import type { FocusContext } from '../../lib/focus-context'
import { useAgentPreviewIntent } from '../../lib/use-agent-preview-intent'
import { useWorkbenchDocument } from '../../lib/workbench-document'
import { FocusMapPreview } from './FocusMapSettings'

export type FocusPreviewScene = 'board' | 'reading' | 'links' | 'map'
const hour = 3_600_000
const exampleReply = 'The layout now keeps related work together. Long replies retain a readable excerpt, while the complete conversation stays available in the Agent preview. The original task and its sources remain intact.'
const inputs = ['Keep the original task and its sources.', 'Make the important information easier to scan.', 'Keep related work together.', 'Use a compact, readable layout.', 'Preserve the original conversation.', 'Show the current state clearly.', 'Let me inspect the full reply.', 'Keep the Agent beside its resources.', 'Make the controls work with the keyboard.', 'Use the shared components throughout.']
const usage: AgentTurnUsage = { scope: 'response', inputTokens: 1600, outputTokens: 400, totalTokens: 2000, cumulative: { scope: 'native-session', inputTokens: 28000, outputTokens: 4000, totalTokens: 32000 }, context: { usedTokens: 8000, capacityTokens: 32000 }, observedAt: 1 }
function exampleContexts(now: number): FocusContext[] {
  return ['Atlas', 'Studio', 'Review', 'Research'].map((name, index) => {
    const workspace: WorkspaceRecord = { id: 'example-' + index, name, path: 'example:' + index, hostId: 'example', kind: 'folder' }
    const base: FocusContext = { id: 'example-agent-' + index, name: ['Refine the workspace', 'Review the reading flow', 'Review a request', 'Inspect the original task'][index]!,
      detail: exampleReply, state: 'done', stateLabel: 'Completed', processState: 'running', bucket: 'results', kind: 'agent', providerId: 'codex', hostId: 'example', topicId: null,
      workspaceId: workspace.id, workspaceName: name, workspacePath: workspace.path, workspace, liveAgent: true, actionable: false,
      lastActivityAt: now - (index === 0 ? 30 : 18) * hour, runId: 'example-run-' + index, workingEnteredAt: null,
      recap: { text: exampleReply, source: 'Last assistant message', origin: 'timeline' }, detailIsRecap: true }
    return index === 2 ? { ...base, state: 'waiting', stateLabel: 'Needs you', bucket: 'attention', actionable: true, detail: 'Allow access to the selected project?', detailKind: 'service', detailIsRecap: false, recap: null }
      : index === 3 ? { ...base, state: 'running', stateLabel: 'Activity not confirmed', bucket: 'idle', activitySemantic: 'unknown', detail: 'Activity not confirmed · Original Agent remains available', detailKind: 'service', detailIsRecap: false, lastActivityAt: null, recap: null } : base
  })
}

/** Static example facts and local interaction only; original product leaves own the drawings. */
export function FocusSettingsPreview({ values, active, scene, onScene, previewRef, returnAction, mapPreviewLastValid = false }: { values: FocusSettingsValues; active: boolean; scene: FocusPreviewScene; onScene(value: FocusPreviewScene): void; previewRef?: Ref<HTMLElement>; returnAction?: ReactNode; mapPreviewLastValid?: boolean }) {
  const document = useWorkbenchDocument(), [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    if (!active) return
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden')
    update(); document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [active, document])
  const enabled = active && documentVisible, [now] = useState(Date.now), id = useId()
  const contexts = useMemo(() => exampleContexts(now), [now])
  const config = useMemo(() => ({ workspaces: contexts.map(context => context.workspace!), focus: { recentActivityHours: values.recentActivityHours } }), [contexts, values.recentActivityHours])
  const lanes = useMemo(() => deriveFocusProjectLanes(contexts, config, undefined, undefined, now), [contexts, config, now])
  const [peek, setPeek] = useState(false), [inspected, setInspected] = useState<number | null>(null), [resourceOpen, setResourceOpen] = useState(false), [agentOpen, setAgentOpen] = useState(false)
  const inspectionRef = useRef<HTMLElement>(null), previousInspection = useRef<HTMLElement | null>(null), cardRef = useRef<HTMLButtonElement>(null), readingRef = useRef<HTMLElement>(null), entryRef = useRef<HTMLDivElement | null>(null), enterReading = useRef(false), returningFocus = useRef(false)
  function openPeek(focus = false) { if (!enabled) return; if (focus && readingRef.current) readingRef.current.focus(); else if (focus) enterReading.current = true; setPeek(true) }
  useLayoutEffect(() => { if (peek && enterReading.current) { enterReading.current = false; readingRef.current?.focus() } }, [peek])
  useLayoutEffect(() => {
    const focused = document.activeElement
    if (inspected !== null) {
      previousInspection.current = inspectionRef.current
      if (focused === entryRef.current || focused === readingRef.current || focused === document.body) inspectionRef.current?.focus()
    } else if (entryRef.current?.isConnected) {
      if (focused === document.body || previousInspection.current?.contains(focused)) entryRef.current.focus()
      entryRef.current = null; previousInspection.current = null
    }
  }, [inspected, document])
  function closePeek() { intent.cancel(); returningFocus.current = true; setPeek(false); cardRef.current?.focus(); queueMicrotask(() => { returningFocus.current = false }) }
  const intent = useAgentPreviewIntent(() => openPeek(), values.previewTrigger, enabled && scene === 'reading')
  useEffect(() => { setPeek(false); setInspected(null); setResourceOpen(false); setAgentOpen(false) }, [scene])
  useEffect(() => { if (!enabled) { intent.cancel(); setPeek(false) } }, [enabled, intent.cancel])
  const style = { '--focus-reply-lines': values.replyLines, '--focus-card-track-height': `${focusCardTrackHeight(values.replyLines)}px` } as CSSProperties
  const card = (context: FocusContext, interactive = false) => {
    const content = <AgentContextContent context={context} presentation="card" identity={<ResolvedAgentAvatar label="Example Executor" providerId="codex" size={18} />} />
    if (!interactive) return <div className="focus-context focus-context--card" data-example-agent={context.id} data-bucket={context.bucket}>{content}</div>
    return <button type="button" className="focus-context focus-context--card" tabIndex={interactive ? 0 : -1} data-example-agent={context.id} data-bucket={context.bucket} aria-label={`Example Agent: ${context.name}`} ref={interactive ? cardRef : undefined}
    onPointerEnter={interactive ? intent.schedule : undefined} onPointerLeave={interactive ? intent.cancel : undefined}
    onFocus={() => { if (interactive && enabled && !returningFocus.current && values.previewTrigger !== 'keyboard') setPeek(true) }} onClick={() => { if (interactive) { intent.cancel(); setPeek(false); setAgentOpen(true) } }} onKeyDown={event => { if (interactive && event.key === 'ArrowDown') { event.preventDefault(); intent.cancel(); openPeek(true) } }}>
    {content}
  </button>
  }
  return <aside ref={previewRef} tabIndex={-1} className="focus-settings-preview" aria-label="Focus settings live example" inert={!enabled} data-active={enabled} style={style}>
    <header><span><SemanticIcon name="navigation.focus" size={15} /><strong>Live preview</strong></span><div className="settings-preview-header-actions"><small>Example workspace</small>{returnAction}</div></header>
    <nav aria-label="Focus example view">{([['board', 'Board'], ['reading', 'Agent preview'], ['links', 'Links'], ['map', 'Map']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={scene === key} onClick={() => onScene(key)}>{label}</button>)}</nav>
    <div className="focus-settings-preview__canvas" data-scene={scene}>
      {scene === 'map' ? <FocusMapPreview value={values.map} contexts={contexts} lastValid={mapPreviewLastValid} /> : null}
      {scene === 'board' ? <div className="focus-settings-preview__board">
        <div className="focus-settings-preview__caption"><span>Project contexts</span><span>Recent · {values.recentActivityHours === 168 ? '1 week' : `${values.recentActivityHours}h`}</span></div>
        {lanes.map(lane => { const context = contexts.find(item => item.id === lane.contextIds[0])!; return <section className="focus-settings-preview__lane" key={lane.id} data-example-project={lane.name}>
          <header><SemanticIcon name="object.project" size={13} /><strong>{lane.name}</strong><small>{context.lastActivityAt === null ? 'Activity unknown' : `${Math.round((now - context.lastActivityAt) / hour)}h ago`}</small></header>
          {card(context)}
        </section> })}
      </div> : null}
      {scene === 'reading' ? <div className="focus-settings-preview__reading" onKeyDown={event => { if (event.key === 'Escape' && (peek || inspected !== null)) { event.preventDefault(); event.stopPropagation(); if (inspected !== null) setInspected(null); else closePeek() } }}>
        <p className="focus-settings-preview__hint">{values.previewTrigger === 'keyboard' ? 'Focus the card and press ↓, or try the preview button.' : 'Hover the card to feel the preview timing.'}</p>
        {card(contexts[0]!, true)}
        {agentOpen ? <div className="focus-settings-preview__workface" role="status"><strong>Example Agent workspace</strong><p>Clicking the card opens its Agent. Use ↓ to read the preview.</p><button type="button" className="small-button" onClick={() => setAgentOpen(false)}>Back to the example</button></div> : null}
        <button type="button" className="small-button focus-settings-preview__try" aria-expanded={peek} onClick={() => { intent.cancel(); if (peek) setPeek(false); else openPeek(true) }}>Try preview <SemanticIcon name="navigation.disclosure" size={12} /></button>
        {peek ? <section ref={readingRef} tabIndex={-1} className="focus-settings-preview__peek" aria-label="Example Agent reading">
          <header><strong>Refine the workspace</strong><span><SemanticIcon name="status.completed" size={12} />Completed</span></header>
          <div hidden={inspected !== null} inert={inspected !== null}><p>{exampleReply}</p><section className="agent-input-recall"><h4>Recent inputs <small>{Math.min(values.recentInputs, inputs.length)} shown</small></h4><ol>{inputs.slice(-values.recentInputs).map((text, index) => {
            const presentation: InputPresentation = { reading: { text, truncated: false }, date: null, author: 'You', time: 'Example input', provenance: 'Example only · No Session is read' }
            return <li key={text}><AgentInputEntry presentation={presentation} expanded={false} controls={id + '-input'} onOpen={anchor => { entryRef.current = anchor; setInspected(inputs.length - values.recentInputs + index) }} /></li>
          })}</ol></section></div>{inspected !== null ? <section ref={inspectionRef} tabIndex={-1} id={id + '-input'} aria-label="Example original input"><button type="button" className="small-button" onClick={() => setInspected(null)}><SemanticIcon name="navigation.back" size={12} /> Recent inputs</button><p>{inputs[inspected]}</p></section> : null}
          <footer><AgentInformationSummary usage={usage} descriptionId={id + '-metrics'} /><small>Example</small></footer>
        </section> : <div className="focus-settings-preview__idle"><SemanticIcon name="object.conversation" size={28} /><span>Read without leaving the board.</span></div>}
      </div> : null}
      {scene === 'links' ? <div className="focus-settings-preview__links" data-destination={values.linkDestination} data-open={resourceOpen}>
        <div className="focus-settings-preview__tabs"><span data-selected={!resourceOpen || values.linkDestination === 'region'}>Agent</span>{resourceOpen && values.linkDestination === 'tab' ? <span data-selected>Resource</span> : null}</div>
        <div className="focus-settings-preview__resource-layout"><section><ResolvedAgentAvatar label="Example Executor" providerId="codex" size={24} /><strong>Refine the workspace</strong><p>The source is ready to inspect.</p><button type="button" onClick={() => setResourceOpen(true)} className="focus-settings-preview__link">Open example source <SemanticIcon name="action.open-external" size={12} /></button></section>
          {resourceOpen ? <section className="focus-settings-preview__resource"><SemanticIcon name="object.file" size={24} /><strong>Original source</strong><p>{values.linkDestination === 'region' ? 'The Agent stays beside it.' : 'The resource has its own Tab in Space.'}</p><button type="button" className="small-button" onClick={() => setResourceOpen(false)}>Try again</button></section> : null}</div>
      </div> : null}
    </div>
    <p className="focus-settings-preview__footnote">Changes here are a preview until you save.</p>
  </aside>
}
