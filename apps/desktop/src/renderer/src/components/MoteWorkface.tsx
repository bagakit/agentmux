import { createPortal } from 'react-dom'
import { useMoteMainEntry } from '../lib/mote-main-entry'
import { MoteDialogueViewProvider, useMoteDialogueView } from '../lib/mote-dialogue-view'
import { useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import { useShallow } from 'zustand/react/shallow'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '../store'
import { MoteWorkfaceContext, useMoteWorkfaceScope, type MoteWorkfaceScope, type MoteRolloverStart } from '../lib/mote-workface'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { showMoteConversation } from '../lib/mote-conversation-mode'
import { confirmedMoteReference } from '../lib/mote-materials-actions'
import { sessionPresentationById } from '../lib/session-presentation'
import type { WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { useMoteSpace } from './MoteSpaceFrame'
import { MoteCooperation } from './MoteCooperation'
import { MoteFirstCooperation } from './MoteFirstCooperation'
import { MoteThreadsPanel } from './MoteThreadsPanel'
import { MoteMainActions } from './MoteMainActions'
import { MoteQuickModeDialog } from './MoteQuickMode'
import { openMoteMaterial } from '../lib/mote-materials-actions'
import { MoteConversationStart } from './MoteConversationStart'
import { MoteEntryReading } from './MoteEntryReading'
import { MoteConversationIdentity } from './MoteConversationIdentity'
import { moteEntryDraftKey, useMoteHeldEntryInput } from '../lib/mote-entry-hold'
import { MotePeriodConversation, MoteOriginalConversation } from '@agentmux/client-ui/components/MoteConversationThreads'
import type { MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import { api } from '../lib/api'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { motePresentationContextKey, usePublishMotePresentation } from '../lib/mote-presentation-context'

type ShownSelection = WorkbenchProjectionSelection | { workspaceId: string; groupId?: string | null | undefined; tabId?: string | null | undefined; regionId?: string | null | undefined }
function sameSelection(selected: ShownSelection, reference: string): boolean {
  const next = JSON.parse(reference) as { displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
  return ('displayWorkspaceId' in selected ? selected.displayWorkspaceId : selected.workspaceId) === next.displayWorkspaceId &&
    selected.groupId === next.groupId && selected.tabId === next.tabId && selected.regionId === next.regionId
}

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
  const [local, setLocal] = useState<{ owner: string; section: 'discussion' | 'threads'; member: boolean; original: boolean; token?: string; start?: boolean; period?: Extract<MoteDialogueLink, {kind:'main'}>; periodOriginal?: boolean; rollover?: MoteRolloverStart }>({ owner, section: 'discussion', member: false, original: false })
  const [floatingActionsHost, setFloatingActionsHost] = useState<HTMLSpanElement | null>(null)
  const [settings, setSettings] = useState(false)
  const settingsInvoker = useRef<HTMLElement | null>(null), ownerDocument = useWorkbenchDocument()
  // The dialog returns focus to the control that opened it, or to the Main menu trigger for menu actions.
  function openSettings(invoker?: HTMLElement | null) {
    const active = invoker ?? ownerDocument.activeElement
    settingsInvoker.current = active instanceof HTMLElement && active !== active.ownerDocument.body ? active : null
    setSettings(true)
  }
  const currentLocal = local.owner === owner ? local : { owner, section: 'discussion' as const, member: false, original: false }
  const sharedFrame = !floating && frame?.topicId === scope?.topic.id ? frame : null
  const section = sharedFrame?.section === 'threads' ? 'threads' : sharedFrame?.section === 'discussion' ? 'discussion' : currentLocal.section
  const entryHold = useMoteHeldEntryInput(scope ? moteEntryDraftKey(scope) : null, visible && section === 'discussion')
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
  function showNewRound() {
    setLocal({ owner, section: 'discussion', member: false, original: false, start: true })
  }
  const startRollover = useCallback((rollover: MoteRolloverStart) => {
    if (JSON.stringify(rollover.decision.target) !== JSON.stringify(dialogue?.target)) return false
    setLocal({ owner, section: 'discussion', member: false, original: false, start: true, rollover })
    return true
  }, [owner, dialogue?.target])
  function openMain(next: import('@agentmux/core/mote-preferences').MoteDefaultConversation) {
    if (!scope || !confirmedMoteReference(useAppStore.getState(), scope, { reference: next }) || !selectReference(next, 'main')) return
    setLocal({ owner, section: 'discussion', member: false, original: false })
    showMoteConversation(scope, { reference: next, floating })
  }
  function showThread(next: WorkbenchProjectionSelection) {
    if (!scope || !confirmedMoteReference(useAppStore.getState(), scope, { reference: next }) || !selectReference(next, 'member')) return false
    setLocal({ owner, section: 'threads', member: true, original: false })
    sharedFrame?.select('threads', next)
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
  const entryToken = visible && recoverOnOpen && section === 'discussion' && !currentLocal.start && !currentLocal.period ? sharedFrame?.entryToken ?? currentLocal.token ??
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
  const mainSelection = useRef<{ key: string; selected?: string; chosen?: string; ended?: boolean }>({ key: '' })
  // The selection this entry itself makes is not the person's choice of another occurrence.
  const landing = currentMain ? JSON.stringify({ displayWorkspaceId: currentMain.displayWorkspaceId, groupId: currentMain.groupId, tabId: currentMain.tabId, regionId: currentMain.regionId }) : null
  // One entry may wait for original metadata. The person choosing another occurrence meanwhile wins.
  useEffect(() => {
    const key = JSON.stringify([owner, entryToken, section]), shown = JSON.stringify(selected ?? null)
    if (mainSelection.current.key !== key) mainSelection.current = { key, chosen: shown }
    const attempt = mainSelection.current
    // Before this entry lands, a selection that changed to anything but its own Main is the person's choice; this entry then ends.
    if (attempt.selected === undefined && attempt.chosen !== shown && !(selected && landing && sameSelection(selected, landing))) attempt.ended = true
    if (attempt.ended || !visible || !recoverOnOpen || !entryToken || !scope || section !== 'discussion' || currentLocal.original) return
    const requested = JSON.stringify(currentMain)
    if (currentMain && attempt.selected !== requested) {
      const next = { displayWorkspaceId: currentMain.displayWorkspaceId, groupId: currentMain.groupId, tabId: currentMain.tabId, regionId: currentMain.regionId }
      const session = mainOccurrence?.session
      if (confirmedMoteReference(useAppStore.getState(), scope, { reference: next }) && session?.control.kind === 'agent' &&
          session.control.hostId === currentMain.hostId && session.control.agentSessionId === currentMain.sessionId) {
        const matches = Boolean(selected && sameSelection(selected, JSON.stringify(next)))
        if (matches && !onReferenceSelect || selectReference(next, 'main')) { showMoteConversation(scope, { reference: next, floating }); attempt.selected = requested }
      }
    }
    // Reading, scrolling or typing in this Mote is not a choice of another object, so it does not cancel this entry.
    // An explicit selection of another occurrence, a section change or closing does: the entry key or visibility changes.
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
  const showOriginal = !scope || presentation === 'workface' || section === 'threads' && memberIntent || section === 'discussion' && selectedMain && !currentLocal.start && !currentLocal.period
  // Only the original role owner can say there is no current Main. Reading, unknown or an unselected current Main is never the start welcome.
  const roleOwned = main?.status === 'ready' && !dialogue?.unavailable && main.identity?.hostId === scope?.workspace.hostId && main.identity?.moteId === scope?.topic.id
  const entry = !scope || section !== 'discussion' || showOriginal || currentLocal.period ? null : currentLocal.start ? 'welcome' as const
    : roleOwned && !main?.current ? 'welcome' as const : currentMain ? 'current' as const : !dialogue?.page && !dialogue?.issue ? 'reading' as const : 'unconfirmed' as const
  // A message held while reading goes to the Main the role owner then confirms, once it is shown, never to a guessed one.
  const heldInput = entryHold.held && showOriginal && selectedMain && currentMain && readingMain?.sessionId === currentMain.sessionId
    ? { operationId: entryHold.held.operationId, prompt: entryHold.held.prompt } : undefined
  const settleHeldInput = entryHold.settle
  // An unconfirmed role source sends nothing; the held text returns to the editable draft.
  useEffect(() => { if (entry === 'unconfirmed' && entryHold.held) entryHold.release() }, [entry, entryHold.held, entryHold.release])
  const context = useMemo(() => scope ? { ...scope, floating, defaultConversation: defaults.conversation, presentation, section, memberIntent, entryToken, bodyVisible: showOriginal,
    showOriginalWorkface: () => setLocal(previous => ({ ...previous, owner, original: true })),
    showConversation: showDiscussion, startRollover, showThreads, showThread, selectReference, heldInput, settleHeldInput,
    selectTab: (tabId: string, groupId: string) => onTabSelect ? onTabSelect(tabId, groupId) : useAppStore.getState().activateTab(workspaceId, groupId, tabId, 'local')
  } : null, [scope, floating, defaults.conversation, presentation, section, memberIntent, entryToken, showOriginal, owner, selectReference, onTabSelect, workspaceId, startRollover,
    heldInput?.operationId, settleHeldInput])
  usePublishMotePresentation(floating && visible && scope ? motePresentationContextKey(scope.topic.id, conversationEntry) : undefined, context, dialogue)
  const issue = scope?.issue ?? defaults.issue
  const selectedReference = selected?.groupId && selected.tabId && selected.regionId ? {
    displayWorkspaceId: 'displayWorkspaceId' in selected ? selected.displayWorkspaceId : selected.workspaceId,
    groupId: selected.groupId, tabId: selected.tabId, regionId: selected.regionId
  } : null
  const conversations = scope ? <MoteCooperation scope={scope} active={visible} reference={selectedReference} presentation="navigation" onSelect={showThread}
    conversation={{ mode: section === 'discussion' ? 'main' : memberIntent ? 'member' : 'threads', original: currentLocal.original,
      onMain: showDiscussion, onThreads: showThreads, onWorkspace: () => setLocal(previous => ({ ...previous, owner, original: !previous.original })) }}
    actions={<MoteFirstCooperation scope={scope} reference={selectedReference} disclosure />} /> : null
  const notice = issue ? <ServiceWindowNotice disclosure={{ scope: JSON.stringify(['mote-context', scope?.workspace.hostId, workspaceId, topicId ?? scope?.topic.id]), id: 'mote-context', occurrence: issue, cause: 'mote-context-observation', visible }} notice={{ kind: 'indeterminate', notice: {
    step: 'Mote context read incomplete', mode: issue, restore: 'Retry this Mote context. Its original Agents and drafts remain available.' } }} /> : null
  return <MoteWorkfaceContext.Provider value={context}>
    <div className={floating ? 'mote-workface' : 'workbench-context-frame'} data-mote-workface={scope?.topic.id} data-mote-section={section} data-mote-workface-presentation={scope ? presentation : undefined}>
      {floating && scope ? <header className="mote-workface__navigation"><MoteConversationIdentity scope={scope} visible={visible} />{conversations}<span className="mote-main-slot" ref={setFloatingActionsHost} />{navigationActions}</header> : null}
      {notice}
      {selectedMain && currentMain && readingMain?.sessionId !== currentMain.sessionId ? <div className="mote-workface__handoff" role="status">主 Agent 已更换，原对话和草稿保留。<button type="button" onClick={showDiscussion}>返回当前主对话</button></div> : null}
      {entryRecovery.issue ? <p role="status" className="mote-conversation__issue">{entryRecovery.issue}{entryRecovery.status === 'unavailable'
        ? <button type="button" className="small-button" onClick={showNewRound}>开始新一轮</button>
        : <button type="button" className="small-button" onClick={entryRecovery.inspect}>核对原恢复</button>}</p> : null}
      {scope && (floating ? floatingActionsHost : sharedFrame?.actionsHost) ? createPortal(<>
        {!floating && visible ? conversations : null}
        <MoteMainActions scope={scope} active={visible && section === 'discussion' && showOriginal && (!sharedFrame || sharedFrame.section === 'discussion')} entryToken={entryToken} presentation="menu" onConfigure={openSettings} onCreated={openMain} onStartNew={showNewRound} onOpenCreated={created => { showThread(created) }} onOpenWorkspace={() => setLocal(previous => ({ ...previous, owner, original: true }))} onRefresh={dialogue?.refresh} />
      </>, (floating ? floatingActionsHost : sharedFrame?.actionsHost)!) : null}
      {scope && entry === 'reading' ? <MoteEntryReading scope={scope} active={visible} held={entryHold.held} onHold={entryHold.hold} onRelease={entryHold.release} /> : null}
      {scope && entry === 'current' && currentMain ? <p role="status" className="mote-conversation__issue">{scope.topic.title} 已有当前主对话，原对话和草稿都在。{entryHold.held ? '读取中写下的那条消息会在打开主对话后发出。' : null}<button type="button" className="small-button" onClick={() => openMain(currentMain)}>打开当前主对话</button></p> : null}
      {scope && entry === 'unconfirmed' && !main?.current ? <p role="status" className="mote-conversation__issue">主对话的来源尚未确认，不会当作没有主对话而新建。原对话和草稿仍保留，读取中写下的消息没有发出。<button type="button" className="small-button" onClick={dialogue?.refresh}>重新核对</button><button type="button" className="small-button" onClick={showThreads}>查看 Threads</button></p> : null}
      {scope && entry === 'welcome' ? <MoteConversationStart scope={scope} active={visible} mode={currentLocal.start ? 'new' : 'start'} automatic={currentLocal.rollover}
        held={!currentLocal.start ? entryHold.held : null} onHeldSettled={entryHold.settle}
        onConfigure={openSettings} onOpenMain={openMain} onOpenPeriod={period => setLocal(previous => ({ ...previous, owner, period, periodOriginal: false }))} /> : null}
      {scope && section === 'discussion' && currentLocal.period && !showOriginal ? <div className="mote-workface__period"><button type="button" className="small-button" onClick={() => setLocal(previous => {
        if (previous.periodOriginal) return { ...previous, periodOriginal: false }
        const { period, periodOriginal, ...rest } = previous; return rest
      })}>{currentLocal.periodOriginal ? '← 返回这段历史' : '← 返回对话'}</button>
        {currentLocal.periodOriginal ? <MoteOriginalConversation source={currentLocal.period} client={api.conversation} visible={visible} name={scope.topic.title} />
          : <MotePeriodConversation source={currentLocal.period} client={api.conversation} visible={visible} name={scope.topic.title} onOpenOriginal={() => setLocal(previous => ({ ...previous, periodOriginal: true }))} />}</div> : null}
      {scope ? <MoteThreadsPanel scope={scope} requestedEvent={sharedFrame?.threadEvent} active={visible && section === 'threads' && !memberIntent && presentation !== 'workface'} onSelect={showThread} /> : null}
      {scope && section === 'discussion' && !showOriginal && !currentMain && main?.current ? <p role="status" className="mote-conversation__issue">原主对话的角色或位置尚未确认，原身份、工作和输入仍保留。<button type="button" className="small-button" onClick={dialogue?.refresh}>重新核对</button><button type="button" className="small-button" onClick={showThreads}>查看 Threads</button></p> : null}
      <div className="mote-workface__original" hidden={!showOriginal} inert={!showOriginal}>{children}</div>
      {settings && scope ? <MoteQuickModeDialog scope={scope} reference={reference} onOpenPath={path => openMoteMaterial(scope, path)} onClose={() => setSettings(false)} onContinue={showDiscussion} returnFocus={() => settingsInvoker.current?.isConnected ? settingsInvoker.current : null} /> : null}
    </div>
  </MoteWorkfaceContext.Provider>
}
