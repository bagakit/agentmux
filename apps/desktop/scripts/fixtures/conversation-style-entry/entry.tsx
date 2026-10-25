import { createRoot } from 'react-dom/client'
import { ClientUiProvider, type ClientUiPlatform } from '../../../../../packages/client-ui/src/platform'
import { ConversationMessage } from '../../../../../packages/client-ui/src/components/ConversationMessage'
import { AgentProviderIcon } from '../../../../../packages/client-ui/src/components/AgentProviderIcon'
import { DiagramImage } from '../../../../../packages/client-ui/src/components/DiagramImage'
import { ConversationCapsule } from '../../../src/renderer/src/components/ConversationCapsule'
import { WorkbenchDocumentContext } from '../../../src/renderer/src/lib/workbench-document'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import { noticeReceiptsFacts } from './notice-receipts'
import '../../../src/renderer/src/styles/index.css'

const root = createRoot(document.getElementById('root')!)
mountThemeRuntime(window, { appAppearance: 'dark' })
document.body.style.cssText = 'margin:0;padding:24px;box-sizing:border-box;background:var(--surface-0);color:var(--text);font-size:var(--fs-body);font-family:var(--font-sans)'
// The engine suite already proves rendering. This exact retained vector tests only its shared viewer/CSS.
const diagram = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="1200" viewBox="0 0 240 1200"><rect width="240" height="1200" fill="#edf4ef"/>' + ['观察', '构思', '实现', '审阅', '验证', '继续'].map((label, index) => `<rect x="30" y="${20 + index * 195}" width="180" height="90" rx="9" fill="#d4e8dc" stroke="#2d6549"/><text x="120" y="${75 + index * 195}" text-anchor="middle" font-size="24" fill="#20392b">${label}</text>`).join('') + '</svg>')
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ name, providerId }) => <span className="conversation-avatar conversation-avatar--agent" aria-label={name}><AgentProviderIcon providerId={providerId ?? 'codex'} size={14} /></span>,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null,
  renderCapsuleEmbed: input => <ConversationCapsule {...input} />,
  renderMarkdownDiagram: () => <DiagramImage src={diagram} alt="六步完整图表" onError={() => { throw new Error('The retained vector must decode') }} /> }
const rect = (node: Element | null) => { const r = node?.getBoundingClientRect(); return r && { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
;(window as any).conversationStyleProbe = {
  async show(capsuleId: string, theme = 'dark') {
    const originalWindow = await (window as any).capsuleProbe.call('window')
    updateThemeSelection({ appAppearance: theme })
    root.render(<WorkbenchDocumentContext.Provider value={{ document, window: originalWindow }}><ClientUiProvider platform={platform}>
      <main className="activity-feed" data-workbench-reading-scroll style={{ maxWidth: 780, margin: '0 auto', height: 'calc(100dvh - 48px)', overflow: 'auto' }}>
        <ConversationMessage messageId="original-style-page" conversationSessionId="style-agent" speaker={{ role: 'agent', id: 'style-agent' }} name="Research" providerId="codex"
          content={`![一页 HTML 的持久生命：保存结果与原始阅读现场](amux://capsule/${capsuleId})`} />
        <ConversationMessage messageId="original-style-diagram" conversationSessionId="style-agent" speaker={{ role: 'agent', id: 'style-agent' }} name="Research" providerId="codex"
          content={'```mermaid\nflowchart TD\nA-->B-->C-->D-->E-->F-->A\n```'} />
      </main>
    </ClientUiProvider></WorkbenchDocumentContext.Provider>)
  },
  theme(value: 'light' | 'dark') { updateThemeSelection({ appAppearance: value }) },
  facts() {
    const card = document.querySelector<HTMLElement>('.conversation-capsule'), header = card?.querySelector('.conversation-capsule__header'), stage = card?.querySelector<HTMLElement>('.browser-stage')
    const video = stage?.querySelector('video'), image = document.querySelector<HTMLImageElement>('.md-diagram-image__thumb'), full = document.querySelector<HTMLImageElement>('.md-conversation-image__full')
    let pixels: number[][] = []
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100
      const context = canvas.getContext('2d')!; context.drawImage(video, 0, 0, 100, 100)
      pixels = [20, 80].map(x => [...context.getImageData(x, 85, 1, 1).data])
    }
    return { theme: document.documentElement.dataset.appearance, focused: document.hasFocus(), viewport: { width: innerWidth, height: innerHeight },
      card: rect(card), header: rect(header ?? null), headerDisplay: header && getComputedStyle(header).display, headerGap: header && parseFloat(getComputedStyle(header).gap),
      overflow: card && card.scrollWidth > card.clientWidth + 1, presentation: rect(card?.querySelector('.browser-presentation') ?? null), stage: rect(stage ?? null), browserId: stage?.dataset.nativeBrowserStage,
      ready: Boolean(video && video.readyState >= 2 && video.videoWidth > 0), video: video && { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState }, pixels,
      notices: [...document.querySelectorAll('.browser-presentation-notice')].map(node => node.textContent),
      image: image && { ...rect(image), src: image.src, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight },
      viewer: full && { ...rect(full), src: full.src, naturalHeight: full.naturalHeight },
      activeTrigger: document.activeElement === document.querySelector('.md-diagram-image'),
      documentWidth: document.documentElement.scrollWidth, noticeReceipts: noticeReceiptsFacts() }
  }
}
