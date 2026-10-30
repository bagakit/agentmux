import { createPortal } from 'react-dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useMoteMainEntry } from '../lib/mote-main-entry'
import { MoteDialogueViewProvider, useMoteDialogueView } from '../lib/mote-dialogue-view'
import { useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import { useShallow } from 'zustand/react/shallow'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { MoteWorkfaceContext, useMoteWorkfaceScope, type MoteWorkfaceScope } from '../lib/mote-workface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { showMoteConversation } from '../lib/mote-conversation-mode'
import { confirmedMoteReference } from '../lib/mote-materials-actions'
import { sessionPresentationById } from '../lib/session-presentation'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useMoteSpace } from './MoteSpaceFrame'
import { SurfaceModeSwitch } from './SurfaceModeSwitch'
import { MoteThreadsPanel } from './MoteThreadsPanel'
import { MoteMainActions } from './MoteMainActions'
import { MoteQuickModeDialog } from './MoteQuickMode'
import { openMoteMaterial } from '../lib/mote-materials-actions'

const ThreadsIcon = semanticIconComponent('object.conversations')

type Props = {
  workspaceId: string; topicId?: string | undefined; floating?: boolean; visible?: boolean; recoverOnOpen?: boolean
  navigationActions?: ReactNode
  onTabSelect?: ((tabId: string, groupId?: string) => void) | undefined; children: ReactNode
  onReferenceSelect?: ((reference: WorkbenchProjectionSelection, intent?: 'main' | 'member') => boolean) | undefined
  reference?: WorkbenchProjectionSelection | null | undefined; conversationEntry?: number | undefined; memberEntry?: boolean | undefined; threadsEntry?: number | undefined
}
/** This wrapper supplies original object context. The original workbench never unmounts. */
export function MoteWorkface(props: Props) {
  const scope = useMoteWorkfaceScope(props.workspaceId, props.topicId, props.visible ?? true)
  return <MoteDialogueViewProvider scope={scope} active={props.visible ?? true}><MoteWorkfaceBody {...props} scope={scope} /></MoteDialogueViewProvider>
}
function MoteWorkfaceBody({ scope, workspaceId, topicId, floating = false, visible = true, recoverOnOpen = visible,
  reference, conversationEntry, memberEntry = false, threadsEntry, navigationActions, onTabSelect, onReferenceSelect, children }: Props & { scope: MoteWorkfaceScope | null }) {
  const defaults = useMoteDefaultConversation(scope?.topic, scope?.workspace.id ?? workspaceId, visible)
  const dialogue = useMoteDialogueView(), frame = useMoteSpace()
  const owner = JSON.stringify([scope?.workspace.hostId, scope?.workspace.id, scope?.workspace.path, scope?.topic.id, scope?.rootPath])
  const [local, setLocal] = useState<{ owner: string; section: 'discussion' | 'threads'; member: boolean; original: boolean; token?: string }>({ owner, section: 'discussion', member: false, original: false })
  const [floatingActionsHost, setFloatingActionsHost] = useState<HTMLSpanElement | null>(null)
  const [settings, setSettings] = useState(false)
  const currentLocal = local.owner === owner ? local : { owner, section: 'discussion' as const, member: false, original: false }
  const sharedFrame = !floating && frame?.topicId === scope?.topic.id ? frame : null
  const section = sharedFrame?.section === 'threads' ? 'threads' : sharedFrame?.section === 'discussion' ? 'discussion' : currentLocal.section
  const memberIntent = section === 'threads' && currentLocal.member
  const presentation = currentLocal.original ? 'workface' as const : 'conversation' as const
  const selectReference = useCallback((next: WorkbenchProjectionSelection, intent?: 'main' | 'member') => {
    if (onReferenceSelect) return onReferenceSelect(next, intent)
    const state = useAppStore.getState()
    return state.selectMainRegion(next, state.workbenchSpaceSelection)
  }, [onReferenceSelect])
  function showDiscussion() {
    dialogue?.refresh()
    setLocal({ owner, section: 'discussion', member: false, original: false, token: crypto.randomUUID() })
    sharedFrame?.select('discussion')
  }
  function showThreads() {
    setLocal({ owner, section: 'threads', member: false, original: false })
    sharedFrame?.select('threads')
  }
  function showThread(next: WorkbenchProjectionSelection) {
    if (!scope || !confirmedMoteReference(useAppStore.getState(), scope, { reference: next }) || !selectReference(next, 'member')) return false
    setLocal({ owner, section: 'threads', member: true, original: false })
    if (sharedFrame?.section !== 'threads') sharedFrame?.select('threads')
    showMoteConversation(scope, { reference: next, floating })
    return true
  }
  const lastEntry = useRef<string>('')
  useEffect(() => {
    const entry = floating ? `${owner}:${conversationEntry}:${memberEntry}` : `${owner}:${sharedFrame?.navigationRevision}`
    if (lastEntry.current === entry) return
    lastEntry.current = entry
    if (floating && conversationEntry !== undefined) {
      setLocal(previous => ({ owner, section: memberEntry ? 'threads' : 'discussion', member: memberEntry, original: false, ...(!memberEntry && previous.owner === owner && previous.token ? { token: previous.token } : {}) }))
    } else if (sharedFrame?.section === 'threads') {
      setLocal({ owner, section: 'threads', member: Boolean(sharedFrame.threadReference), original: false })
    } else if (sharedFrame?.section === 'discussion') setLocal({ owner, section: 'discussion', member: false, original: false })
  }, [owner, floating, conversationEntry, memberEntry, sharedFrame?.navigationRevision])
  useEffect(() => {
    if (floating && threadsEntry !== undefined) setLocal({ owner, section: 'threads', member: false, original: false })
  }, [owner, floating, threadsEntry])
  const entryToken = visible && recoverOnOpen && section === 'discussion' ? sharedFrame?.entryToken ?? currentLocal.token ??
    (floating && conversationEntry !== undefined && !memberEntry ? `${owner}:${conversationEntry}:${memberEntry}` : undefined) : undefined
  const entryRecovery = useMoteMainEntry({ scope, entryToken, active: visible && section === 'discussion' && !memberIntent })
  const selected = useAppStore(state => floating ? reference : state.workbenchSpaceSelection)
  const main = dialogue?.page?.main
  const currentMain = main?.status === 'ready' && !dialogue?.unavailable && main.identity?.hostId === scope?.workspace.hostId && main.identity?.moteId === scope?.topic.id ? main.current : null
  const mainOccurrence = useAppStore(useShallow(state => currentMain ? {
    region: state.tabs[currentMain.tabId]?.regions[currentMain.regionId],
    session: state.tabs[currentMain.tabId]?.regions[currentMain.regionId]?.kind === 'agent'
      ? sessionPresentationById(state.sessions).get((state.tabs[currentMain.tabId]!.regions[currentMain.regionId] as {sessionId: string}).sessionId) : undefined
  } : null))
  const mainSelection = useRef<{ key: string; cancelled: boolean; selected?: string }>({ key: '', cancelled: false })
  // One entry may wait for original metadata. Later input or another selection wins.
  useEffect(() => {
    const key = JSON.stringify([owner, entryToken, section])
    if (mainSelection.current.key !== key) mainSelection.current = { key, cancelled: false }
    const attempt = mainSelection.current
    if (!visible || !recoverOnOpen || !entryToken || !scope || section !== 'discussion' || currentLocal.original) return
    const cancel = () => { attempt.cancelled = true }
    const requested = JSON.stringify(currentMain)
    if (currentMain && !attempt.cancelled && attempt.selected !== requested) {
      const next = { displayWorkspaceId: currentMain.displayWorkspaceId, groupId: currentMain.groupId, tabId: currentMain.tabId, regionId: currentMain.regionId }
      const session = mainOccurrence?.session
      if (confirmedMoteReference(useAppStore.getState(), scope, { reference: next }) && session?.control.kind === 'agent' &&
          session.control.hostId === currentMain.hostId && session.control.agentSessionId === currentMain.sessionId) {
        const matches = selected && ('displayWorkspaceId' in selected ? selected.displayWorkspaceId : selected.workspaceId) === next.displayWorkspaceId && selected.groupId === next.groupId && selected.tabId === next.tabId && selected.regionId === next.regionId
        if (matches && !onReferenceSelect || selectReference(next, 'main')) { showMoteConversation(scope, { reference: next, floating }); attempt.selected = requested }
      }
    }
    for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) document.addEventListener(event, cancel, true)
    return () => { for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) document.removeEventListener(event, cancel, true) }
  }, [visible, owner, section, main?.roleRevision, currentMain, mainOccurrence, entryToken, currentLocal.original, selectReference, selected, onReferenceSelect])
  // A later role observation does not move the original reading or active draft.
  const retainedReadingMain = useRef<{ owner: string; reference: NonNullable<typeof currentMain> } | null>(null)
  const matchesSelection = (candidate: NonNullable<typeof currentMain> | null | undefined) => Boolean(candidate && selected &&
    ('displayWorkspaceId' in selected ? selected.displayWorkspaceId : selected.workspaceId) === candidate.displayWorkspaceId &&
    selected.groupId === candidate.groupId && selected.tabId === candidate.tabId && selected.regionId === candidate.regionId)
  if (currentMain && matchesSelection(currentMain)) retainedReadingMain.current = { owner, reference: currentMain }
  const retainedMain = retainedReadingMain.current?.owner === owner ? retainedReadingMain.current.reference : null
  const readingMain = matchesSelection(currentMain) ? currentMain : matchesSelection(retainedMain) ? retainedMain :
    main?.identity?.hostId === scope?.workspace.hostId && main?.identity?.moteId === scope?.topic.id ? main?.current : null
  const selectedMain = matchesSelection(readingMain)
  const showOriginal = !scope || presentation === 'workface' || section === 'threads' && memberIntent || section === 'discussion' && selectedMain
  const context = useMemo(() => scope ? { ...scope, floating, defaultConversation: defaults.conversation, presentation, section, memberIntent, entryToken, bodyVisible: showOriginal,
    showOriginalWorkface: () => setLocal(previous => ({ ...previous, owner, original: true })),
    showConversation: showDiscussion, showThreads, showThread, selectReference,
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId, groupId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId, 'local')
  } : null, [scope, floating, defaults.conversation, presentation, section, memberIntent, entryToken, showOriginal, owner, selectReference, onTabSelect, workspaceId])
  const issue = scope?.issue ?? defaults.issue
  const notice = issue ? <ServiceWindowNotice disclosure={{ scope: JSON.stringify(['mote-context', scope?.workspace.hostId, workspaceId, topicId ?? scope?.topic.id]), id: 'mote-context', occurrence: issue, cause: 'mote-context-observation', visible }} notice={{ kind: 'indeterminate', notice: {
    step: 'Mote context read incomplete', mode: issue, restore: 'Retry this Mote context. Its original Agents and drafts remain available.' } }} /> : null
  return <MoteWorkfaceContext.Provider value={context}>
    <div className={floating ? 'mote-workface' : 'workbench-context-frame'} data-mote-workface={scope?.topic.id} data-mote-section={section} data-mote-workface-presentation={scope ? presentation : undefined}>
      {floating && scope ? <header className="mote-workface__navigation"><SurfaceModeSwitch value={section} active={visible} ariaLabel="Mote pages" options={[{ value: 'discussion', label: 'Discussion' }, { value: 'threads', label: <><ThreadsIcon size={13} aria-hidden="true" />Threads</> }]} onChange={next => next === 'discussion' ? showDiscussion() : showThreads()} /><span className="mote-main-slot" ref={setFloatingActionsHost} />{navigationActions}</header> : null}
      {notice}
      {selectedMain && currentMain && readingMain?.sessionId !== currentMain.sessionId ? <div className="mote-workface__handoff" role="status">主 Agent 已更换，原对话和草稿保留。<button type="button" onClick={showDiscussion}>返回当前主对话</button></div> : null}
      {entryRecovery.issue ? <p role="status" className="mote-conversation__issue">{entryRecovery.issue}<button type="button" className="small-button" onClick={entryRecovery.inspect}>核对原恢复</button></p> : null}
      {scope && section === 'discussion' && !dialogue?.page && !dialogue?.issue ? <div className="mote-entry-loading" role="status" aria-live="polite"><span className="mote-entry-loading__orbit" /><span>正在接回 {scope.topic.title} 的主对话…</span></div> : null}
      {scope && (floating ? floatingActionsHost : sharedFrame?.actionsHost) ? createPortal(<MoteMainActions scope={scope} active={visible && section === 'discussion'} entryToken={entryToken} reference={reference} presentation={readingMain ? 'menu' : 'setup'} onConfigure={() => setSettings(true)} onCreated={() => showDiscussion()} onOpenCreated={created => { showThread(created) }} onOpenWorkspace={() => setLocal(previous => ({ ...previous, owner, original: true }))} onRefresh={dialogue?.refresh} />, (floating ? floatingActionsHost : sharedFrame?.actionsHost)!) : null}
      {scope ? <MoteThreadsPanel scope={scope} active={visible && section === 'threads' && !memberIntent && presentation !== 'workface'} onSelect={showThread} /> : null}
      {scope && (memberIntent || presentation === 'workface') ? <div className="mote-workface__thread-navigation">
        <button type="button" onClick={showThreads}>← Threads</button>
        {presentation === 'workface' ? <button type="button" onClick={() => setLocal(previous => ({ ...previous, original: false }))}>返回对话</button> : <button type="button" onClick={() => setLocal(previous => ({ ...previous, owner, original: true }))}>在工作区打开 ↗</button>}
      </div> : null}
      {scope && section === 'discussion' && !showOriginal && !currentMain && main?.current ? <p role="status" className="mote-conversation__issue">原主对话的角色或位置尚未确认，原身份、工作和输入仍保留。<button type="button" className="small-button" onClick={dialogue?.refresh}>重新核对</button><button type="button" className="small-button" onClick={showThreads}>查看 Threads</button></p> : null}
      <div className="mote-workface__original" hidden={!showOriginal} inert={!showOriginal}>{children}</div>
      {settings && scope ? <MoteQuickModeDialog scope={scope} reference={reference} onOpenPath={path => openMoteMaterial(scope, path)} onClose={() => setSettings(false)} returnFocus={() => null} /> : null}
    </div>
  </MoteWorkfaceContext.Provider>
}
