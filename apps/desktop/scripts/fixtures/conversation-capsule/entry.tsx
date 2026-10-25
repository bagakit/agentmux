import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { useMemo, useRef, useState } from 'react'
import { ClientUiProvider, type ClientUiPlatform } from '../../../../../packages/client-ui/src/platform'
import { AgentProviderIcon } from '../../../../../packages/client-ui/src/components/AgentProviderIcon'
import { ConversationMessage } from '../../../../../packages/client-ui/src/components/ConversationMessage'
import { DiagramImage } from '../../../../../packages/client-ui/src/components/DiagramImage'
import { ConversationCapsule } from '../../../src/renderer/src/components/ConversationCapsule'
import { CapsuleQuestionEditorsContext, type CapsuleQuestionEditor, type CapsuleQuestionEditorPort } from '../../../src/renderer/src/lib/capsule-question-editors'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import { ConversationReadingRuler } from '../../../src/renderer/src/components/ConversationReadingRuler'
import { conversationMessageSourceKey } from '../../../../../packages/client-ui/src/lib/conversation-message-location'
import type { RulerRecord } from '../../../src/renderer/src/lib/conversation-ruler'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import { unusedAvatarCalls } from './unused-avatar'
import { noticeReceiptsFacts } from '../conversation-style-entry/notice-receipts'
import '../../../src/renderer/src/styles/index.css'
// A narrow in-memory host port tests presentation lifetime only. The original Workbench
// writer and disk restore are separately consumed by capsule-question-editors.test.tsx.
const editors = new Map<string, CapsuleQuestionEditor>(), editorListeners = new Set<() => void>()
const editorPort: CapsuleQuestionEditorPort = {
  get: key => editors.get(key),
  compareAndSwap(key, expected, value) {
    if (editors.get(key) !== expected) return false
    if (value) editors.set(key, value); else editors.delete(key)
    for (const changed of editorListeners) changed()
    return true
  },
  subscribe(changed) { editorListeners.add(changed); return () => editorListeners.delete(changed) },
  flush: async () => {}
}
const root = createRoot(document.getElementById('root')!)
mountThemeRuntime(window, { appAppearance: 'dark' })
document.body.style.cssText = 'margin:0;padding:24px;background:var(--surface-0);color:var(--text);font-size:var(--fs-body);font-family:var(--font-sans);box-sizing:border-box;overflow:hidden'
// Retained vector output only: the engine suite already proves Mermaid/DOT/drawio.
// This probe checks their shared production image/viewer through the formal stylesheet.
const diagram = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="1200" viewBox="0 0 240 1200"><rect width="240" height="1200" fill="#edf4ef"/>${['观察', '构思', '实现', '审阅', '验证', '继续'].map((label, index) => `<rect x="30" y="${20 + index * 195}" width="180" height="90" rx="9" fill="#d4e8dc" stroke="#2d6549"/><text x="120" y="${75 + index * 195}" text-anchor="middle" font-size="24" fill="#20392b">${label}</text>${index < 5 ? `<path d="M120 ${110 + index * 195}v105" stroke="#2d6549" stroke-width="3"/>` : ''}`).join('')}</svg>`)
const platform: ClientUiPlatform = { overlayContainer: () => document.body, copyText: async () => true, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ name, providerId }) => <span className="conversation-avatar conversation-avatar--agent" role="img" aria-label={name}><AgentProviderIcon providerId={providerId ?? 'codex'} size={14} /></span>,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null,
  renderCapsuleEmbed: (input: any) => <ConversationCapsule key={input.uri} {...input} />,
  renderMarkdownDiagram: () => <DiagramImage src={diagram} alt="六步完整图表" onError={() => { throw new Error('The retained vector output must decode') }} /> }
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
    root.render(<WorkbenchDocumentContext.Provider value={{ document, window: originalWindow }}><CapsuleQuestionEditorsContext.Provider value={editorPort}><ClientUiProvider platform={platform}><Feed content={content} visible={visible} /></ClientUiProvider></CapsuleQuestionEditorsContext.Provider></WorkbenchDocumentContext.Provider>)
  },
  unmount() { root.render(null) },
  click(text: string) {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === text || button.textContent?.trim() === text)
    if (!button) throw new Error('Missing original Host action: ' + text)
    if (button.disabled) throw new Error('Original Host action is disabled: ' + text)
    button.click()
  },
  facts() { const page = document.querySelector<HTMLElement>('.conversation-capsule'), stage = document.querySelector<HTMLElement>('.browser-stage'), video = document.querySelector('video')
    const rect = (node: Element | null) => { const box = node?.getBoundingClientRect(); return box && { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom } }
    const header = page?.querySelector('.conversation-capsule__header'), actions = page?.querySelector('.conversation-capsule__actions')
    const image = document.querySelector<HTMLImageElement>('.md-diagram-image__thumb'), full = document.querySelector<HTMLImageElement>('.md-conversation-image__full')
    let pixels: number[] = []
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100
      const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0, 100, 100)
      pixels = [...context.getImageData(95, 95, 1, 1).data]
    }
    return { unusedAvatarCalls: unusedAvatarCalls(), noticeReceipts: noticeReceiptsFacts(), pixels, text: document.body.innerText, count: document.querySelectorAll('.conversation-capsule').length, height: stage?.getBoundingClientRect().height, presentationHeight: page?.querySelector('.browser-presentation')?.getBoundingClientRect().height,
      viewport: { width: innerWidth, height: innerHeight }, appearance: document.documentElement.dataset.appearance,
      layout: page && { card: rect(page), header: rect(header ?? null), headerDisplay: header && getComputedStyle(header).display,
        headerGap: header && parseFloat(getComputedStyle(header).columnGap), actions: rect(actions ?? null), actionsGap: actions && parseFloat(getComputedStyle(actions).columnGap),
        title: rect(header?.querySelector('strong') ?? null), mode: rect(page.querySelector('.conversation-capsule__mode')),
        buttons: [...(actions?.querySelectorAll('button') ?? [])].map(button => ({ text: button.textContent?.trim(), ...rect(button) })),
        overflow: page.scrollWidth > page.clientWidth + 1, questionChip: page.querySelector('[aria-label="Page questions"]')?.textContent },
      questions: [...document.querySelectorAll<HTMLElement>('.capsule-question')].map(question => ({ text: question.innerText, ...rect(question),
        answer: question.querySelector('textarea')?.value, readOnly: question.querySelector('textarea')?.readOnly,
        confirmDisabled: question.querySelector<HTMLButtonElement>('.capsule-question__confirm')?.disabled })),
      diagram: image && { ...rect(image), src: image.src, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, maxHeight: getComputedStyle(image).maxHeight,
        modal: rect(document.querySelector('.md-conversation-image__lightbox')), full: full && { ...rect(full), src: full.src, naturalHeight: full.naturalHeight },
        activeTrigger: document.activeElement === document.querySelector('.md-diagram-image') },
      browserId: stage?.dataset.nativeBrowserStage, keyframe: page?.dataset.conversationKeyframe, cachedFrame: document.querySelector<HTMLImageElement>('.conversation-axis__keyframe')?.src,
      ready: Boolean(video && video.readyState >= 2 && video.videoWidth > 0),
      videoWidth: video?.videoWidth, videoHeight: video?.videoHeight, notices: [...document.querySelectorAll('.browser-presentation-notice')].map(node => node.textContent),
      uri: page?.querySelector('.conversation-capsule__source code')?.textContent, inputs: [...document.querySelectorAll('input,textarea')].map(input => input.tagName) } }
}
