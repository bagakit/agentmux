import { fixtureEpoch as _reshape_fixtureEpoch, fixturePath as _reshape_fixturePath } from "../../../../../../test/fixture-values.mjs"
import { useEffect, useState } from 'react'
import type { AppConfig, ComposerShortcut, ScratchTopicSnapshot, SessionSnapshot } from '../../../shared/contracts'
import { DEFAULT_MOTE_FACE } from '../../../shared/mote-avatars'
import { SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '../../../shared/scratch-topics'
import { scratchTopicsScope } from '../lib/scratch-topic-snapshots'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { StatusDot } from './StatusDot'
import { SemanticIcon } from './semantic-icons'
import { AgentComposer } from '@agentmux/client-ui/components/AgentComposer'
import { AgentContextUsage } from './AgentContextUsage'
import type { ComposerQueuedMessage } from './ComposerOutbox'
import { appendSemanticReference, expandSemanticReferences, encodeSemanticReference } from '@agentmux/client-ui/composer-semantic-reference'
import { composerShortcutForBareWord, composerShortcutSuggestion } from '../../../shared/composer-shortcut-library'
import { ComposerFeedback, useComposerFeedback } from './ComposerFeedback'
import { AgentAvatar, ExecutorIdentityContext } from './AgentAvatar'
import { useAppStore } from '../store'
import { AgentComposerTools } from './AgentComposerTools'
import { SessionMailbox } from './SessionMailbox'
import { useServiceNotices } from '../lib/use-service-notices'
import type { RenderableServiceNotice } from '../lib/service-window-notice'

// 画廊里那条示例 prompt。它是**一份 fixture**，不是第二套注册表：画廊要画出「用户自己的 prompt
// 混在 Provider 命令里长什么样」，而画廊没有 store、读不到真实配置。形状用真类型，所以字段一改
// 这里当场编译不过。
const GALLERY_PROMPT: ComposerShortcut = {
  id: 'gallery-review',
  keyword: 'review-changes',
  label: 'Review changes',
  body: 'Review the current changes. Identify concrete bugs and missing tests.'
}

const workingStatus: SessionSnapshot['status'] = {
  state: 'working',
  source: 'native-hook',
  observedAt: _reshape_fixtureEpoch(0, 0, 0)
}

const degradedNotice: RenderableServiceNotice = {
  kind: 'process-degraded',
  notice: {
    step: 'Prompt readiness did not complete',
    mode: 'The Agent is still alive; work can continue while readiness is degraded',
    restore: 'Retry readiness when the session is idle'
  }
}

const galleryOrigin = Date.now()

export function ObservationSurfaceGallery() {
  const feedback = useComposerFeedback('gallery')
  const inbox = useServiceNotices('gallery', [{ id: 'delivery', notice: degradedNotice }])
  const [draft, setDraft] = useState(() => `${appendSemanticReference('请检查 ', { token: '', label: 'review', kind: 'skill', reference: '@/skills/review/SKILL.md' })}${("@" + _reshape_fixturePath("gallery/.agentmux/pasted/capture.png") + " ")}`)
  const [queued, setQueued] = useState<ComposerQueuedMessage[]>([
    { id: 'gallery-q-1', text: 'Run the focused tests', status: 'deferred', deliverable: true, error: 'The Agent is not ready to accept another message yet.' },
    { id: 'gallery-q-2', text: 'Summarize the remaining risk', status: 'failed', deliverable: false, error: 'Previous run ended before delivery' }
  ])
  const [composerAction, setComposerAction] = useState('')
  const [conversationAction, setConversationAction] = useState('')
  return (
    <section className="observation-gallery" aria-label="Existing observation surfaces">
      <header className="observation-gallery__heading">
        <span className="observation-gallery__eyebrow">Existing surface language</span>
        <h2><SemanticIcon name="object.context" size={16} />对话、状态和服务窗</h2>
        <p>复用原有组件的事实边界，用 Workflow 的层级、密度和观察节奏呈现。</p>
      </header>
      <div className="observation-gallery__grid">
        <AgentLinksSample />
        <article className="observation-sample observation-sample--conversation">
          <div className="observation-sample__label">Conversation · example states</div>
          <div className="observation-sample__body">
            <ConversationMessage
              speaker={{ role: 'human', id: 'gallery-human' }}
              name="You"
              content="让对话也接入这一套组件，保留清楚的身份和状态。"
              status="complete"
              createdAt={(galleryOrigin + 0)}
              origin={(galleryOrigin + 0)}
            />
            <ConversationMessage
              speaker={{ role: 'agent', id: 'gallery-reviewer' }}
              name="Review agent"
              providerId="codex"
              content={'Shared message surface.\n\n- **Identity** stays with each message.\n- Read [ActivityView.tsx](src/ActivityView.tsx) in the workspace.'}
              status="streaming"
              createdAt={(galleryOrigin + 10000)}
              origin={(galleryOrigin + 0)}
              workspaceRoot={new URL("./gallery", import.meta.url).pathname}
              openWorkspaceFile={(path) => setConversationAction(`File action: ${path}`)}
              onContinue={() => setConversationAction('Continue requested for this example message; delivery belongs to the host.')}
            />
            <ConversationMessage
              speaker={{ role: 'agent', id: 'gallery-checker' }}
              name="Check agent"
              providerId="claude"
              content="The last check did not finish. Its partial response remains readable."
              status="failed"
              createdAt={(galleryOrigin + 20000)}
              origin={(galleryOrigin + 0)}
            />
            {conversationAction ? <p role="status">{conversationAction}</p> : null}
          </div>
        </article>
        <article className="observation-sample">
          <div className="observation-sample__label">Live status</div>
          <div className="observation-sample__status"><StatusDot status={workingStatus} withLabel /> <span>持续观察中</span></div>
          <ServiceWindowNotice notice={degradedNotice} />
        </article>
        <article className="observation-sample observation-sample--composer">
          <div className="observation-sample__label">Composer</div>
          <ComposerTextarea value={draft} onValueChange={setDraft} placeholder="补充一条 steer…" aria-label="Gallery composer" />
          <small>{draft ? '草稿已输入，交付仍由宿主负责。' : '受控输入与 IME 处理仍由原有组件负责。'}</small>
        </article>
      </div>
      <article id="composer-details" className="observation-sample observation-sample--composer observation-sample--full">
        <div className="observation-sample__label">Agent workspace composer</div>
        <AgentComposer
          primaryAction="stop"
          onInterrupt={() => setComposerAction('Example current reply interrupted; Session retained')}
          contextUsage={<AgentContextUsage usage={{ inputTokens: 24000, outputTokens: 0, totalTokens: 24000, observedAt: _reshape_fixtureEpoch(0, 0, 1), context: { usedTokens: 24000, capacityTokens: 100000 } }} />}
          readPastedImage={async () => ({ dataUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="#e9edf4"/><rect x="12" y="12" width="216" height="20" rx="4" fill="#7586ab"/><rect x="12" y="44" width="60" height="102" rx="4" fill="#bbc8de"/><rect x="84" y="44" width="144" height="62" rx="4" fill="#8ba9dd"/><rect x="84" y="118" width="108" height="8" rx="4" fill="#7586ab"/></svg>')}` })}
          feedback={<ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />}
          onAttach={() => setComposerAction('Example file picker requested')}
          value={draft}
          disabled={false}
          placeholder="Ask, steer, or paste a command…"
          onChange={setDraft}
          mailbox={<SessionMailbox visible system={inbox} queued={queued}
          onArchiveQueued={async (id,expectedText,archived) => setQueued(items => items.map(item => {
            if (item.id !== id || item.text !== expectedText) return item
            if (archived) return {...item,archived:true as const}
            const {archived:_archive,...original}=item; return {...original,awaitingExplicitSend:true as const}
          }))}
          onSendQueued={(id) => { setComposerAction(`Example send: ${queued.find((item) => item.id === id)?.text}`); setQueued((items) => items.filter((item) => item.id !== id)) }} />}
          onSubmit={() => { setComposerAction(`Example payload: ${expandSemanticReferences(draft)}`); setDraft('') }}
          commands={[{ text: '/status', description: 'Provider command' }, composerShortcutSuggestion(GALLERY_PROMPT)]}
          onSelectSuggestion={(text) => { const mine = composerShortcutForBareWord([GALLERY_PROMPT], text.replace(/^\//, '')); return mine ? encodeSemanticReference({ token: text, label: mine.label, kind: 'subcommand', reference: mine.body }) : text }}
          onActivateSemanticReference={(reference) => setComposerAction(`Open reference: ${reference.reference}`)}
          tools={<><AgentComposerTools onCapture={async () => { setComposerAction('Example screen capture requested') }} disabled={false} commands={[{ text: '/status', description: 'Inspect the current Agent state' }]} loadSkills={async () => [{ name: 'card', path: new URL("./components/card.tsx", import.meta.url).pathname, description: 'Example component reference', source: 'project' }]} onChooseSkill={(skill) => setDraft((text) => appendSemanticReference(text, { token: '', label: skill.name, kind: 'component', reference: `@${skill.path}` }))} onCommand={(command) => setDraft((text) => `${command} ${text}`)} runAction={feedback.run} /></>}
        />
        {composerAction ? <p role="status">{composerAction}</p> : null}
        <small>队列保留未投递消息和原因；旧 Run 条目不阻塞当前消息。引用以短 token 展示。</small>
      </article>
    </section>
  )
}

/** Explicit Gallery observations, never discovery of the user's Sessions or Runtime. */
function AgentLinksSample() {
  const currentConfig = useAppStore(state => state.config)
  const base: AppConfig = currentConfig ?? { version: 9, hosts: [], workspaces: [], executors: {}, appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const workspace = currentConfig?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID) ??
    { id: SCRATCH_WORKSPACE_ID, hostId: 'local', path: new URL("./gallery-inline-topics", import.meta.url).pathname, name: 'Gallery Topics', kind: 'folder' as const }
  const mote: ScratchTopicSnapshot = { id: 'launcher:gallery-inline-mote', title: '负责共享对话组件与行内对象呈现的同事',
    directoryPath: `${workspace.path}/${scratchTopicDirectoryName('launcher:gallery-inline-mote')}`,
    topicPath: 'gallery-only/topic.md', summary: '', collaborators: [],
    soul: { path: 'gallery-only/SOUL.md', content: '# Gallery Mote', version: 'gallery' } }
  const moteTarget = topicSpaceIconTarget(workspace, mote)!
  const sessions: Extract<SessionSnapshot, { kind: 'agent' }>[] = [
    { id: 'gallery-linked-reviewer', label: 'Interface reviewer', providerId: 'codex', executorId: 'gallery-reviewer' },
    { id: 'gallery-linked-builder', label: '负责共享对话组件与行内对象呈现的同事', providerId: 'claude', executorId: 'gallery-builder' }
  ].map((identity, index) => ({ ...identity, kind: 'agent', hostId: workspace.hostId, workspacePath: index === 1 ? mote.directoryPath : new URL("./projects/amux", import.meta.url).pathname,
    createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), agentSessionUpdatedAt: _reshape_fixtureEpoch(0, 0, 1), processState: 'running', latestOutputBytes: 0,
    status: { state: index === 0 ? 'working' : 'done', source: 'native-hook', observedAt: Date.now() },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: workspace.hostId, agentSessionId: identity.id, run: { runId: 'gallery-only-' + identity.id } } }))
  useEffect(() => {
    const ids = new Set(sessions.map(session => session.id))
    const before = useAppStore.getState()
    const snapshot = before.scratchTopicSnapshots[workspace.id]
    const installed = { scope: scratchTopicsScope(workspace), revision: 1, reading: false, error: null,
      topics: [...(snapshot?.topics ?? []).filter(topic => topic.id !== mote.id), mote] }
    const installedConfig = { ...base, workspaces: base.workspaces.some(item => item.id === workspace.id)
      ? base.workspaces : [...base.workspaces, workspace] }
    const icon = { ...DEFAULT_MOTE_FACE, palette: 'peach' as const, accessory: 'glasses' as const }
    useAppStore.setState(state => ({ config: installedConfig,
      sessions: [...state.sessions.filter(session => !ids.has(session.id)), ...sessions],
      scratchTopicSnapshots: { ...state.scratchTopicSnapshots, [workspace.id]: installed },
      spaceObjectIcons: { ...state.spaceObjectIcons, [moteTarget.key]: icon } }))
    return () => { useAppStore.setState(state => {
      const topics = { ...state.scratchTopicSnapshots }, icons = { ...state.spaceObjectIcons }
      if (topics[workspace.id] === installed) {
        if (snapshot) topics[workspace.id] = snapshot; else delete topics[workspace.id]
      }
      if (icons[moteTarget.key] === icon) {
        const previous = before.spaceObjectIcons[moteTarget.key]
        if (previous) icons[moteTarget.key] = previous; else delete icons[moteTarget.key]
      }
      return { config: state.config === installedConfig ? before.config : state.config,
        sessions: state.sessions.filter(session => !ids.has(session.id)), scratchTopicSnapshots: topics, spaceObjectIcons: icons }
    }) }
  }, [])
  const config: AppConfig = { ...base, executors: { ...base.executors,
    'gallery-reviewer': { label: 'Review', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true,
      avatar: { tint: '#8eaecc' } },
    'gallery-builder': { label: 'Build', providerId: 'claude', command: 'claude', args: [], env: {}, injectAgentMuxGuide: true,
      avatar: { tint: '#ccad8e' } } } }
  return <article className="observation-sample observation-sample--agent-links">
    <div className="observation-sample__label">Inline Agent links · example observations</div>
    <ExecutorIdentityContext.Provider value={{ config }}><div className="observation-sample__body">
      <ConversationMessage speaker={{ role: 'human', id: 'gallery-human' }} name="You" status="complete"
        content="请让 amux://agent/gallery-linked-reviewer 看一下，再交给 [共享组件同事](amux://agent/gallery-linked-builder)。" />
      <ConversationMessage speaker={{ role: 'agent', id: 'gallery-author' }} name="Coordinator" providerId="codex" status="complete"
        content={'正在由 amux://agent/gallery-linked-reviewer 审阅。\n\n- 长名称：amux://agent/gallery-linked-builder\n- 尚无资料：amux://agent/gallery-unobserved\n\n原始引用仍是 `amux://agent/gallery-linked-reviewer`，复制消息保留原文。'} />
    </div></ExecutorIdentityContext.Provider>
  </article>
}
