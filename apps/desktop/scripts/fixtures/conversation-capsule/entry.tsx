import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useMemo, useRef, useState } from 'react'
import { ClientUiProvider, type ClientUiPlatform } from '../../../../../packages/client-ui/src/platform'
import { AgentProviderIcon } from '../../../../../packages/client-ui/src/components/AgentProviderIcon'
import { ConversationMessage } from '../../../../../packages/client-ui/src/components/ConversationMessage'
import { ConversationCapsule } from '../../../src/renderer/src/components/ConversationCapsule'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import { ConversationReadingRuler } from '../../../src/renderer/src/components/ConversationReadingRuler'
import { conversationMessageSourceKey } from '../../../../../packages/client-ui/src/lib/conversation-message-location'
import type { RulerRecord } from '../../../src/renderer/src/lib/conversation-ruler'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/browser.css'
import '../../../src/renderer/src/styles/capsule-interaction.css'
import '../../../src/renderer/src/styles/activity.css'
import '../../../src/renderer/src/styles/agent.css'
import '../../../src/renderer/src/styles/service-notice.css'
import '../../../src/renderer/src/styles/conversation-ruler.css'
import '../../../src/renderer/src/styles/conversation-axis.css'
import '../../../src/renderer/src/styles/chrome.css'
import '../../../../../packages/client-ui/src/styles/index.css'
import '../../../../../packages/client-ui/src/styles/conversation-capsule.css'
const root = createRoot(document.getElementById('root')!)
mountThemeRuntime(window, { appAppearance: 'dark' })
document.body.style.cssText = 'margin:0;padding:24px;background:var(--surface-0);color:var(--text);font:14px/1.55 system-ui;box-sizing:border-box;overflow:hidden'
const platform: ClientUiPlatform = { overlayContainer: () => document.body, copyText: async () => true, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ name, providerId }) => <span className="conversation-avatar conversation-avatar--agent" role="img" aria-label={name}><AgentProviderIcon providerId={providerId ?? 'codex'} size={14} /></span>,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null,
  renderCapsuleEmbed: (input: any) => <ConversationCapsule key={input.uri} {...input} /> }
const describeSpeaker = () => ({ name: 'Original agent', avatar: platform.renderMessageAvatar({ name: 'Original agent', speaker: { role: 'agent', id: 'original-session' }, providerId: 'codex' }) })
function Feed({ content, visible }: { content: string; visible: boolean }) {
  const [feed, setFeed] = useState<HTMLDivElement | null>(null), [selected, setSelected] = useState<string | null>(null)
  const shells = useRef(null)
  const records = useMemo(() => [{ id: 'original-message', kind: 'ruler-record', sourceKey: conversationMessageSourceKey('original-session', { kind: 'captured', recordId: 'original-message' }),
    recordedAt: _privacyFixtureEpoch(19675, 80000), speaker: { role: 'agent', id: 'original-session' },
    record: { id: 'original-message', kind: 'assistant_message', agentSessionId: 'original-session', content }, target: { kind: 'observed', index: 0 } }] as RulerRecord[], [content])
  return <div ref={setFeed} className="activity-feed" data-workbench-reading-scroll style={{ height: 'calc(100dvh - 48px)', overflow: 'auto' }}>
    <ConversationReadingRuler feedEl={feed} sessionId="original-session" readingEnabled={visible} rulerRecords={records}
      placed={[{ key: 'original-segment', from: 0, to: 0 }]} visibleShells={shells} rulerWindow="all" onWindow={() => {}}
      selectedRecordId={selected} hasMore={false} pending={false} activity={[]} describeSpeaker={describeSpeaker} tools={null}
      selectRulerRecord={record => { setSelected(record.id); document.querySelector('[data-message-id="original-message"]')?.scrollIntoView({ block: 'nearest' }) }} />
    <div data-segment-key="original-segment"><ConversationMessage messageId="original-message" conversationSessionId="original-session" executionHostId="local"
      inputSource={{ kind: 'captured', submissionId: 'original-message' }} speaker={{ role: 'agent', id: 'original-session' }} content={content} active={visible} />
    </div>
  </div>
}
;(window as any).conversationCapsuleProbe = {
  async set(content: string, visible = true, theme = 'dark') {
    const originalWindow = await (window as any).capsuleProbe.call('window')
    updateThemeSelection({ appAppearance: theme })
    root.render(<WorkbenchDocumentContext.Provider value={{ document, window: originalWindow }}><ClientUiProvider platform={platform}><Feed content={content} visible={visible} /></ClientUiProvider></WorkbenchDocumentContext.Provider>)
  },
  unmount() { root.render(null) },
  click(text: string) { [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)?.click() },
  facts() { const page = document.querySelector<HTMLElement>('.conversation-capsule'), stage = document.querySelector<HTMLElement>('.browser-stage'), video = document.querySelector('video')
    return { text: document.body.innerText, count: document.querySelectorAll('.conversation-capsule').length, height: stage?.getBoundingClientRect().height,
      browserId: stage?.dataset.nativeBrowserStage, keyframe: page?.dataset.conversationKeyframe, cachedFrame: document.querySelector<HTMLImageElement>('.conversation-axis__keyframe')?.src,
      ready: Boolean(video && video.readyState >= 2 && video.videoWidth > 0),
      videoWidth: video?.videoWidth, videoHeight: video?.videoHeight, notices: [...document.querySelectorAll('.browser-presentation-notice')].map(node => node.textContent),
      uri: page?.querySelector('code')?.textContent, inputs: [...document.querySelectorAll('input,textarea')].map(input => input.tagName) } }
}
