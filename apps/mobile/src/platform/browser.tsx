import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'

/** Plain LAN browsers use their synchronous, explicitly invoked copy action. */
function copyWithBrowserCommand(text: string): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const input = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null
  const inputSelection = input?.selectionStart == null ? null : {
    start: input.selectionStart, end: input.selectionEnd!, direction: input.selectionDirection
  }
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : []
  const target = document.createElement('textarea')
  target.value = text
  target.readOnly = true
  target.inputMode = 'none'
  target.tabIndex = -1
  target.setAttribute('aria-hidden', 'true')
  target.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none'
  let handled = false, failure: unknown
  const copy = (event: ClipboardEvent) => {
    event.preventDefault()
    try {
      if (!event.clipboardData) throw new Error('浏览器未提供复制数据通道；文字尚未复制。')
      // The original text, rather than textarea's normalized line endings, is authoritative.
      event.clipboardData.setData('text/plain', text)
      handled = true
    } catch (error) { failure = error }
  }
  try {
    document.body.append(target)
    target.addEventListener('copy', copy)
    target.focus({ preventScroll: true })
    target.select()
    const confirmed = typeof document.execCommand === 'function' && document.execCommand('copy') === true
    if (failure) throw failure
    if (!confirmed || !handled) throw new Error('浏览器未确认复制；文字仍保留。')
  } finally {
    target.removeEventListener('copy', copy)
    target.remove()
    if (active?.isConnected) {
      active.focus({ preventScroll: true })
      if (input && inputSelection) input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined)
    }
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}

export function createBrowserPlatform(options: {
  overlayContainer?: () => HTMLElement | Element | DocumentFragment
  clipboard?: Pick<Clipboard, 'writeText'>
} = {}): ClientUiPlatform {
  return {
    async copyText(text, reportError) {
      try {
        const clipboard = options.clipboard ?? navigator.clipboard
        if (clipboard) await clipboard.writeText(text)
        else copyWithBrowserCommand(text)
        return true
      } catch (error) { reportError(error); return false }
    },
    overlayContainer: options.overlayContainer ?? (() => document.body),
    // Browser editing uses the editor's native pointer/keyboard focus. It has no global
    // Desktop focus owner and never brings up the keyboard on reconnect or foreground.
    bindComposerFocus: () => () => {},
    renderMessageAvatar({ speaker, name }) {
      const icon = speaker.role === 'agent' ? 'object.agent' : speaker.role === 'system' ? 'object.system' : 'object.user'
      return <span className={`conversation-avatar conversation-avatar--${speaker.role}`} title={name}
        data-speaker-id={speaker.id}><SemanticIcon name={icon} size={15} aria-hidden="true" /></span>
    },
    renderProjectIcon: project => <SemanticIcon name="object.system" size={12} aria-label={project.name} />,
    renderProjectLabel: project => <small>{project.name}</small>,
    renderIcon(name, size) {
      const icon = name === 'working' ? 'status.working' : name === 'failed' ? 'status.failed' : 'status.queued'
      return <SemanticIcon name={icon} size={size} aria-hidden="true" />
    }
  }
}

/** Only the explicitly clicked public web destination is handed to the browser. */
export function openBrowserHttpLink(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('该链接不是网页地址。')
  window.open(url.href, '_blank', 'noopener,noreferrer')
}
