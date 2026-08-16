import { useState } from 'react'
import type { ComposerShortcut, SessionSnapshot } from '../../../shared/contracts'
import { ConversationMessage } from './ConversationMessage'
import { ComposerTextarea } from './ComposerTextarea'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { StatusDot } from './StatusDot'
import { SemanticIcon } from './semantic-icons'
import { AgentComposer, type ComposerQueuedMessage } from './AgentComposer'
import { appendSemanticReference, expandSemanticReferences, encodeSemanticReference } from '../lib/composer-semantic-reference'
import { composerShortcutForBareWord, composerShortcutSuggestion } from '../../../shared/composer-shortcut-library'
import { ComposerFeedback, useComposerFeedback } from './ComposerFeedback'
import { AgentAvatar } from './AgentAvatar'
import { AgentComposerTools } from './AgentComposerTools'
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
  observedAt: 0
}

const degradedNotice: RenderableServiceNotice = {
  kind: 'process-degraded',
  notice: {
    step: 'Prompt readiness did not complete',
    mode: 'The Agent is still alive; work can continue while readiness is degraded',
    restore: 'Retry readiness when the session is idle'
  }
}

export function ObservationSurfaceGallery() {
  const feedback = useComposerFeedback('gallery')
  const [draft, setDraft] = useState(() => appendSemanticReference('请检查 ', { token: '', label: 'review', kind: 'skill', reference: '@/skills/review/SKILL.md' }))
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
        <h2><SemanticIcon name="context" size={16} />对话、状态和服务窗</h2>
        <p>复用原有组件的事实边界，用 Workflow 的层级、密度和观察节奏呈现。</p>
      </header>
      <div className="observation-gallery__grid">
        <article className="observation-sample observation-sample--conversation">
          <div className="observation-sample__label">Conversation · example states</div>
          <div className="observation-sample__body">
            <ConversationMessage
              speaker={{ role: 'human', id: 'gallery-human' }}
              name="You"
              content="让对话也接入这一套组件，保留清楚的身份和状态。"
              status="complete"
              createdAt={1_789_552_800_000}
              origin={1_789_552_800_000}
            />
            <ConversationMessage
              speaker={{ role: 'agent', id: 'gallery-reviewer' }}
              name="Review agent"
              providerId="codex"
              content={'Shared message surface.\n\n- **Identity** stays with each message.\n- Read [ActivityView.tsx](src/ActivityView.tsx) in the workspace.'}
              status="streaming"
              createdAt={1_789_552_810_000}
              origin={1_789_552_800_000}
              workspaceRoot="/gallery"
              openWorkspaceFile={(path) => setConversationAction(`File action: ${path}`)}
              onContinue={() => setConversationAction('Continue requested for this example message; delivery belongs to the host.')}
            />
            <ConversationMessage
              speaker={{ role: 'agent', id: 'gallery-checker' }}
              name="Check agent"
              providerId="claude"
              content="The last check did not finish. Its partial response remains readable."
              status="failed"
              createdAt={1_789_552_820_000}
              origin={1_789_552_800_000}
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
          feedback={<ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />}
          identity={{ name: 'Review agent', avatar: <AgentAvatar providerId="codex" state="running" label="Review agent" /> }}
          onAttach={() => setComposerAction('Example file picker requested')}
          value={draft}
          disabled={false}
          placeholder="Ask, steer, or paste a command…"
          onChange={setDraft}
          queued={queued}
          onRemoveQueued={(id) => setQueued((items) => items.filter((item) => item.id !== id))}
          onSendQueued={(id) => { setComposerAction(`Example send: ${queued.find((item) => item.id === id)?.text}`); setQueued((items) => items.filter((item) => item.id !== id)) }}
          onSubmit={() => { setComposerAction(`Example payload: ${expandSemanticReferences(draft)}`); setDraft('') }}
          commands={[{ text: '/status', description: 'Provider command' }, composerShortcutSuggestion(GALLERY_PROMPT)]}
          onSelectSuggestion={(text) => { const mine = composerShortcutForBareWord([GALLERY_PROMPT], text.replace(/^\//, '')); return mine ? encodeSemanticReference({ token: text, label: mine.label, kind: 'subcommand', reference: mine.body }) : text }}
          onActivateSemanticReference={(reference) => setComposerAction(`Open reference: ${reference.reference}`)}
          tools={<AgentComposerTools onCapture={async () => { setComposerAction('Example screen capture requested') }} disabled={false} commands={[{ text: '/status', description: 'Inspect the current Agent state' }]} loadSkills={async () => [{ name: 'card', path: '/components/card.tsx', description: 'Example component reference', source: 'project' }]} onChooseSkill={(skill) => setDraft((text) => appendSemanticReference(text, { token: '', label: skill.name, kind: 'component', reference: `@${skill.path}` }))} onCommand={(command) => setDraft((text) => `${command} ${text}`)} runAction={feedback.run} />}
        />
        {composerAction ? <p role="status">{composerAction}</p> : null}
        <small>队列保留未投递消息和原因；旧 Run 条目不阻塞当前消息。引用以短 token 展示。</small>
      </article>
    </section>
  )
}
