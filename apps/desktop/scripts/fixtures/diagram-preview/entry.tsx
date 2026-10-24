import { createRoot } from 'react-dom/client'
import { ClientUiProvider } from '../../../../../packages/client-ui/src/platform'
import { AgentMarkdown } from '../../../../../packages/client-ui/src/components/AgentMarkdown'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import { DiagramFilePreview } from '../../../src/renderer/src/components/file-preview/DiagramFilePreview'
import { DotFilePreview } from '../../../src/renderer/src/components/file-preview/DotFilePreview'
import { DrawioFilePreview } from '../../../src/renderer/src/components/file-preview/DrawioFilePreview'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/file-preview.css'
import '../../../../../packages/client-ui/src/styles/markdown.css'
import '../../../../../packages/client-ui/src/styles/conversation-image.css'
import '../../../../../packages/client-ui/src/styles/diagram-image.css'

// Same public host boundary as DesktopClientUiProvider; no private parser or substitute diagram.
// The complete Workbench, Session store and window overlay service are outside this focused probe.
const platform = { overlayContainer: () => document.body,
  renderMarkdownDiagram: ({ code, language, visible }: any) => language === 'dot' || language === 'gv'
    ? <DotFilePreview content={code} visible={visible} /> : language === 'drawio'
      ? <DrawioFilePreview content={code} visible={visible} /> : <DiagramFilePreview content={code} kind={language} visible={visible} /> }
let workers = 0
const OriginalWorker = window.Worker
window.Worker = class extends OriginalWorker { constructor(...args: ConstructorParameters<typeof Worker>) { super(...args); workers++ } }
const root = createRoot(document.getElementById('root')!)
mountThemeRuntime(window, { appAppearance: 'light' })
document.body.style.cssText = 'margin:0;padding:24px;background:var(--surface-0);color:var(--text);font-family:system-ui;box-sizing:border-box;overflow:hidden'
const rect = (element: Element | null) => {
  const box = element?.getBoundingClientRect()
  return box ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height } : null
}
;(window as any).diagramPreviewProbe = {
  set({ language, code, theme, name, slug }: any) {
    updateThemeSelection({ appAppearance: theme })
    root.render(<ClientUiProvider platform={platform}><section aria-label="File reading region" data-scenario={slug} style={{ height: 'calc(100dvh - 48px)', width: 'min(900px,100%)', marginInline: 'auto' }}>
      <AgentMarkdown key={slug} className="file-markdown-preview" documentMode content={`# ${name}\n\n图表保留完整结构，点击放大后继续阅读。\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n## 接着阅读\n\n原始文档和阅读位置在关闭大图后保留。\n\n${Array.from({length: 18}, (_, i) => `第 ${i + 1} 段。继续查看当前工作面的说明。`).join('\n\n')}`} />
    </section></ClientUiProvider>)
  },
  facts() {
    const image = document.querySelector<HTMLImageElement>('.md-diagram-image__thumb')
    const documentRoot = document.querySelector<HTMLElement>('.file-markdown-preview')
    const preview = document.querySelector<HTMLElement>('.file-diagram-preview')
    const full = document.querySelector<HTMLImageElement>('.md-conversation-image__full')
    const viewport = document.querySelector<HTMLElement>('.md-conversation-image__viewport')
    return { viewport: { width: innerWidth, height: innerHeight }, workers, appearance: document.documentElement.dataset.appearance,
      reading: documentRoot && { ...rect(documentRoot), scrollTop: documentRoot.scrollTop, scrollWidth: documentRoot.scrollWidth, clientWidth: documentRoot.clientWidth },
      preview: preview && { ...rect(preview), scrollHeight: preview.scrollHeight, clientHeight: preview.clientHeight, scrollWidth: preview.scrollWidth, clientWidth: preview.clientWidth },
      image: image && { ...rect(image), src: image.src, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, maxHeight: getComputedStyle(image).maxHeight },
      trigger: rect(document.querySelector('.md-diagram-image')), page: document.querySelector('[aria-label="Diagram page"]')?.textContent,
      modal: rect(document.querySelector('.md-conversation-image__lightbox')), imageViewport: rect(viewport),
      full: full && { ...rect(full), src: full.src, naturalWidth: full.naturalWidth, naturalHeight: full.naturalHeight, transform: getComputedStyle(full).transform },
      zoom: document.querySelector('[aria-label="Zoom level"]')?.textContent,
      controls: Array.from(document.querySelectorAll('.md-conversation-image__control')).map(button => {
        const href = button.querySelector('use')?.getAttribute('href')
        return { label: button.getAttribute('aria-label'), icon: Boolean(href?.startsWith('#') && document.getElementById(href.slice(1))?.childElementCount) }
      }),
      activeTrigger: document.activeElement === document.querySelector('.md-diagram-image'),
      text: documentRoot?.textContent }
  },
  async source() { return fetch(document.querySelector<HTMLImageElement>('.md-diagram-image__thumb')!.src).then(value => value.text()) }
}
