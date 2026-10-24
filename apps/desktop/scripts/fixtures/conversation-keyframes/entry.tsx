import { fixtureEpoch as _privacyFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ClientUiProvider } from '../../../../../packages/client-ui/src/platform'
import { ConversationMessage } from '../../../../../packages/client-ui/src/components/ConversationMessage'
import { AgentProviderIcon } from '../../../../../packages/client-ui/src/components/AgentProviderIcon'
import { conversationMessageSourceKey } from '../../../../../packages/client-ui/src/lib/conversation-message-location'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import { ConversationReadingRuler } from '../../../src/renderer/src/components/ConversationReadingRuler'
import type { RulerRecord } from '../../../src/renderer/src/lib/conversation-ruler'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/activity.css'
import '../../../src/renderer/src/styles/conversation-ruler.css'
import '../../../src/renderer/src/styles/conversation-axis.css'
import '../../../src/renderer/src/styles/chrome.css'
import '../../../../../packages/client-ui/src/styles/index.css'

const session = 'keyframe-session', source = (id: string) => ({ kind: 'captured' as const, recordId: id })
const imagePath = (id: string) => new URL(`keyframe-fixture/.agentmux/pasted/${id}.png`, new URL('file:///')).pathname
function colorImage(fill: string, width: number, height: number, structure = false) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')!; context.fillStyle = fill; context.fillRect(0, 0, width, height)
  if (structure) {
    // A real authored six-step structure keeps geometry recognizable in the cached frame.
    const nodes = [[16, 8, 'Observe'], [16, 66, 'Draft'], [16, 124, 'Review'], [184, 124, 'Publish'], [184, 66, 'Verify'], [184, 8, 'Continue']] as const
    context.strokeStyle = '#fff'; context.fillStyle = '#fff'; context.lineWidth = 2; context.font = '13px system-ui'; context.textAlign = 'center'
    for (const [x, y, label] of nodes) { context.strokeRect(x, y, 120, 28); context.fillText(label, x + 60, y + 19) }
    context.beginPath()
    for (const [x, y, nextX, nextY] of [[76, 36, 76, 66], [76, 94, 76, 124], [136, 138, 184, 138], [244, 124, 244, 94], [244, 66, 244, 36], [184, 22, 136, 22]]) {
      context.moveTo(x!, y!); context.lineTo(nextX!, nextY!)
    }
    context.stroke()
  }
  return canvas.toDataURL('image/png')
}
const red = colorImage('#e02020', 320, 160, true), green = colorImage('#20b040', 320, 160)
const original = [
  { id: 'red-original', content: `Red review frame\n\n@${imagePath('red')}`, name: 'Review agent' },
  { id: 'green-original', content: `Green accepted frame\n\n@${imagePath('green')}`, name: 'Review agent' },
  { id: 'text-original', content: 'Text only: original author avatar stays here.', name: 'Review agent' }
]
const reads: string[] = [], selections: string[] = [], captures: string[] = [], observations: string[] = []
let encodes = 0
const toDataURL = HTMLCanvasElement.prototype.toDataURL
HTMLCanvasElement.prototype.toDataURL = function (...args) {
  if (args[0] === 'image/webp') encodes++
  return toDataURL.apply(this, args)
}
const NativeIntersectionObserver = window.IntersectionObserver
window.IntersectionObserver = class extends NativeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    super((entries, observer) => {
      for (const entry of entries) if (entry.target.matches('.md-conversation-image__thumb')) {
        observations.push(entry.target.closest<HTMLElement>('[data-message-source-key]')!.dataset.messageSourceKey!)
      }
      callback(entries, observer)
    }, options)
  }
}
const draw = CanvasRenderingContext2D.prototype.drawImage
CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
  const media = args[0] as Element
  if (media?.matches?.('.md-conversation-image__thumb')) captures.push(media.closest<HTMLElement>('[data-message-source-key]')!.dataset.messageSourceKey!)
  return draw.apply(this, args as any)
}
const readImage = async (path: string) => { reads.push(path); if (path === imagePath('red')) return { dataUrl: red }; if (path === imagePath('green')) return { dataUrl: green }; throw new Error('Only exact fixture-owned image paths may be read') }
const avatar = <span className="conversation-avatar conversation-avatar--agent" role="img" aria-label="Review agent" style={{ width: 16, height: 16 }}><AgentProviderIcon providerId="codex" size={12} /></span>
const describe = () => ({ name: 'Review agent', avatar })
const platform = { overlayContainer: () => document.body, copyText: async () => true, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => avatar, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
mountThemeRuntime(window, { appAppearance: 'light' })
document.body.style.cssText = 'margin:0;padding:20px;background:var(--surface-0);color:var(--text);font-family:var(--font-sans);overflow:hidden'
let control: { configure(input: any): void } | undefined
function Fixture() {
  const [feed, setFeed] = useState<HTMLDivElement | null>(null), [cluster, setCluster] = useState(false)
  const [invalidated, setInvalidated] = useState(false), [mismatch, setMismatch] = useState(false), [active, setActive] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [unrelatedRevision, setUnrelatedRevision] = useState(0), [omitRed, setOmitRed] = useState(false)
  const visible = useRef(null)
  const content = original.map((item, index) => index === 0 && invalidated ? { ...item, content: 'The red visual was removed in the current exact record.' }
    : index === 2 && unrelatedRevision ? { ...item, content: `${item.content} Unrelated revision ${unrelatedRevision}.` } : item)
  // Stable versions are the exact current content strings; names never associate a source.
  const records: RulerRecord[] = content.map((item, index) => ({ id: item.id, kind: 'ruler-record',
    sourceKey: conversationMessageSourceKey(mismatch ? 'different-session' : session, source(item.id)),
    recordedAt: _privacyFixtureEpoch(19675, 80000) + (cluster ? [0, 1, 10000][index]! : index * 10000),
    speaker: { role: 'agent', id: session }, target: { kind: 'observed', index },
    record: { id: item.id, kind: 'assistant_message', agentSessionId: session, content: item.content } as any })).filter(record => !omitRed || record.id !== 'red-original')
  control = { configure(input) { if (input.theme) updateThemeSelection({ appAppearance: input.theme }); if ('cluster' in input) setCluster(input.cluster)
    if ('invalidated' in input) setInvalidated(input.invalidated); if ('mismatch' in input) setMismatch(input.mismatch); if ('active' in input) setActive(input.active)
    if ('unrelatedRevision' in input) setUnrelatedRevision(input.unrelatedRevision); if ('omitRed' in input) setOmitRed(input.omitRed) } }
  return <ClientUiProvider platform={platform}><section aria-label="Conversation proof" style={{ width: 'min(920px,100%)', height: 'calc(100dvh - 40px)', marginInline: 'auto' }}>
    <div ref={setFeed} className="activity-feed">
      <ConversationReadingRuler feedEl={feed} sessionId={session} readingEnabled={active} rulerRecords={records} placed={records.map((_, index) => ({ key: `segment-${index}`, from: index, to: index }))}
        visibleShells={visible} rulerWindow="all" onWindow={() => {}} selectedRecordId={selected} hasMore={false} pending={false}
        activity={[]} describeSpeaker={describe} tools={null} selectRulerRecord={record => {
          selections.push(record.id); setSelected(record.id)
          const key = conversationMessageSourceKey(session, source(record.id))
          const target = [...document.querySelectorAll<HTMLElement>('[data-message-source-key]')].find(node => node.dataset.messageSourceKey === key)
          target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true })
        }} />
      <div style={{ padding: 20 }}>
        {content.map((item, index) => <div key={item.id} data-segment-key={`segment-${index}`}>
          <ConversationMessage conversationSessionId={session} itemRef={{ agentSessionId: session, source: source(item.id) } as any}
            content={item.content} messageId={item.id} contentBoundary="body" name={item.name} speaker={{ role: 'agent', id: session }}
            describeSpeaker={describe} readPastedImage={readImage} located={selected === item.id} active />
        </div>)}
      </div>
    </div>
  </section></ClientUiProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
const bounds = (node: Element | null) => { const box = node?.getBoundingClientRect(); return box ? { left: box.left, top: box.top, width: box.width, height: box.height, right: box.right, bottom: box.bottom } : null }
async function pixels(image: HTMLImageElement) {
  await image.decode()
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0)
  return [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data]
}
;(window as any).conversationKeyframeProbe = {
  configure(input: unknown) { control?.configure(input) },
  async facts() {
    const keyframes = [...document.querySelectorAll<HTMLImageElement>('.conversation-axis__keyframe, .conversation-axis__entry-keyframe')]
    return { hidden: document.hidden, appearance: document.documentElement.dataset.appearance, reads: [...reads], captures: [...captures], encodes, observations: [...observations], selections: [...selections],
      axis: bounds(document.querySelector('.conversation-axis')), feed: bounds(document.querySelector('.activity-feed')),
      marks: await Promise.all([...document.querySelectorAll<HTMLElement>('.conversation-axis__mark')].map(async mark => ({ label: mark.getAttribute('aria-label'), count: mark.querySelector('.conversation-axis__count')?.textContent,
        ...bounds(mark), avatar: Boolean(mark.querySelector('.conversation-avatar')), avatarGlyph: Boolean(mark.querySelector('[data-agent-provider="codex"] svg path')), keyframe: Boolean(mark.querySelector('.conversation-axis__keyframe')) }))),
      keyframes: await Promise.all(keyframes.map(async image => ({ src: image.src, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, pixel: await pixels(image), ...bounds(image) }))),
      entries: [...document.querySelectorAll('.conversation-axis__entry')].map(entry => ({ text: entry.textContent, avatar: Boolean(entry.querySelector('.conversation-avatar')), keyframe: Boolean(entry.querySelector('.conversation-axis__entry-keyframe')) })),
      messages: [...document.querySelectorAll<HTMLElement>('.log-turn')].map(message => ({ id: message.dataset.messageId, sourceKey: message.dataset.messageSourceKey,
        located: message.dataset.messageLocated, active: document.activeElement === message, image: Boolean(message.querySelector('.md-conversation-image__thumb')), avatar: Boolean(message.querySelector('.conversation-avatar')) })),
      originalImages: [...document.querySelectorAll<HTMLImageElement>('.md-conversation-image__thumb')].map(image => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })) }
  }
}
