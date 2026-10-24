import { createRoot } from 'react-dom/client'
import { ClientUiProvider, type ClientUiPlatform } from '../../../../../packages/client-ui/src/platform'
import { ConversationMessage } from '../../../../../packages/client-ui/src/components/ConversationMessage'
import { AgentMarkdown } from '../../../../../packages/client-ui/src/components/AgentMarkdown'
import { AgentProviderIcon } from '../../../../../packages/client-ui/src/components/AgentProviderIcon'
import { mountThemeRuntime, updateThemeSelection } from '../../../../../packages/client-ui/src/theme/runtime'
import { useSessionLinkOpening } from '../../../src/renderer/src/lib/session-link-opening'
import { opened, inputs, issues } from './host'
import '../../../src/renderer/src/styles/index.css'

const uri = 'https://docs.example.test/architecture/%E5%8E%9F%E5%A7%8B%E8%BA%AB%E4%BB%BD?view=conversation&language=zh-CN&source=original-message#durable-reading'
const longUri = 'https://reference.example.test/' + 'very-long-original-path/'.repeat(9) + '?filter=' + 'kept-original-'.repeat(16) + '#reading'
const label = '让每一份结果都有来处：从原始链接回到完整的阅读现场'
const copied: string[] = [], forbidden: unknown[] = []
// Any accidental metadata lookup fails the probe. The local card has no network permission to use.
window.fetch = (async (...args: unknown[]) => { forbidden.push({ kind: 'fetch', args: String(args[0]) }); throw new Error('A local link card must not fetch metadata') }) as typeof fetch
window.open = ((...args: unknown[]) => { forbidden.push({ kind: 'window.open', args }); return null }) as typeof window.open
const platform: ClientUiPlatform = {
  copyText: async text => { copied.push(text); return true }, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ speaker, name, providerId }) => <span className={`conversation-avatar conversation-avatar--${speaker.role === 'human' ? 'human' : 'agent'}`} aria-label={name}>
    {speaker.role === 'human' ? 'Y' : <AgentProviderIcon providerId={providerId ?? 'codex'} size={14} />}</span>,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null
}
const root = createRoot(document.getElementById('root')!)
mountThemeRuntime(window, { appAppearance: 'light' })
document.body.style.cssText = 'margin:0;padding:28px;background:var(--surface-0);color:var(--text);font-size:var(--fs-body);font-family:var(--font-sans);box-sizing:border-box'
let scenario = 'showcase', revision = 0
function Reader() {
  const links = useSessionLinkOpening({ workspaceId: 'original-workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }, message => issues.push(message))
  const open = (url: string, modifiers: any) => { inputs.push({ url, modifiers }); links.activateHttp(url, modifiers) }
  const message = (id: string, content: string, role: 'human' | 'agent' = 'agent') => <ConversationMessage key={id} messageId={id} conversationSessionId="original-agent"
    speaker={{ role, id: role === 'agent' ? 'original-agent' : 'original-human' }} name={role === 'agent' ? 'Research' : 'You'} providerId="codex" content={content} openHttpLink={open} />
  const content = scenario === 'nested' ? message('nested', `# [标题](${uri})\n\n- [列表里的原始参考](${uri})\n\n> [引用中的原始参考](${uri})\n\n正文里的 [链接](${uri}) 保持行内。\n\n| 参考 |\n| --- |\n| [表格](${uri}) |`)
    : scenario === 'bare' ? message('bare', uri)
    : scenario === 'no-adapter' ? <AgentMarkdown content={`[${label}](${uri})`} />
    : <>{message('authored', `把完整上下文留在原处，阅读时只需要一个清楚的入口。\n\n[${label}](${uri})`)}
      {message('human', `# 接下来想读\n\n[一条很长的原始地址，也应在窄窗口中从容阅读](${longUri})`, 'human')}
      {message('inline', `这份 [正文中的参考](${uri}) 保持行内，句子可以连续读下去。`)}</>
  return <main style={{ maxWidth: 780, margin: '0 auto' }} data-proof-revision={revision}>
    <p style={{ margin: '0 0 20px', color: 'var(--text-dim)', fontSize: 'var(--fs-caption)' }}>阅读参考 · 原始链接</p>{content}
  </main>
}
function show(theme = 'light', next = scenario) {
  scenario = next; updateThemeSelection({ appAppearance: theme })
  root.render(<ClientUiProvider platform={platform}><Reader /></ClientUiProvider>)
}
const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
;(window as any).conversationLinksProbe = {
  uri, longUri, label,
  configure(theme = 'light', next = scenario) { revision++; show(theme, next) },
  facts() {
    return { scenario, theme: document.documentElement.dataset.appearance, revision, opened: [...opened], inputs: [...inputs], issues: [...issues], copied: [...copied], forbidden: [...forbidden],
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll<HTMLElement>('.md-link-card')].map(card => {
        const button = card.querySelector<HTMLElement>('.md-link-card__open')!, css = getComputedStyle(card), openCSS = getComputedStyle(button)
        return { ...rect(card), text: card.innerText, scrollWidth: card.scrollWidth, clientWidth: card.clientWidth,
          button: { ...rect(button), active: document.activeElement === button, display: openCSS.display },
          display: css.display, borderStyle: css.borderTopStyle, borderWidth: parseFloat(css.borderTopWidth), radius: parseFloat(css.borderTopLeftRadius), background: css.backgroundColor,
          details: card.querySelector('details')?.open ?? false, copyState: card.querySelector('.content-copy')?.getAttribute('data-copy-state') }
      }),
      remoteMedia: [...document.querySelectorAll('img,iframe,video,source')].map(node => node.getAttribute('src')).filter(src => src && /^https?:/u.test(src)),
      focused: document.activeElement?.className,
      text: document.body.innerText }
  }
}
show()
