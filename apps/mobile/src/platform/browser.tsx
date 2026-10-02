import { Bot, Boxes, Circle, LoaderCircle, TriangleAlert, UserRound } from 'lucide-react'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'

export function createBrowserPlatform(options: {
  overlayContainer?: () => HTMLElement | Element | DocumentFragment
  clipboard?: Pick<Clipboard, 'writeText'>
} = {}): ClientUiPlatform {
  return {
    async copyText(text, reportError) {
      try {
        const clipboard = options.clipboard ?? navigator.clipboard
        if (!clipboard) throw new Error('浏览器未提供剪贴板权限；文字尚未复制。')
        await clipboard.writeText(text)
        return true
      } catch (error) { reportError(error); return false }
    },
    overlayContainer: options.overlayContainer ?? (() => document.body),
    // Browser editing uses the editor's native pointer/keyboard focus. It has no global
    // Desktop focus owner and never brings up the keyboard on reconnect or foreground.
    bindComposerFocus: () => () => {},
    renderMessageAvatar({ speaker, name }) {
      const Icon = speaker.role === 'agent' ? Bot : speaker.role === 'system' ? Boxes : UserRound
      return <span className={`conversation-avatar conversation-avatar--${speaker.role}`} title={name}
        data-speaker-id={speaker.id}><Icon size={15} aria-hidden="true" /></span>
    },
    renderProjectIcon: project => <Boxes size={12} aria-label={project.name} />,
    renderProjectLabel: project => <small>{project.name}</small>,
    renderIcon(name, size) {
      const Icon = name === 'working' ? LoaderCircle : name === 'failed' ? TriangleAlert : Circle
      return <Icon size={size} aria-hidden="true" />
    }
  }
}

/** Only the explicitly clicked public web destination is handed to the browser. */
export function openBrowserHttpLink(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('该链接不是网页地址。')
  window.open(url.href, '_blank', 'noopener,noreferrer')
}
