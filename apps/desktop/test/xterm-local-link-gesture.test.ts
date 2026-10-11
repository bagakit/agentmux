// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { subscribeTerminalInput } from '../../../packages/client-ui/src/terminal/input'

const releases: Array<() => void> = []
beforeEach(() => {
  // Match the existing dependency-owner fixture: only font/layout are supplied.
  // Parser, providers, Linkifier, selection and input subscriptions remain real.
  vi.stubGlobal('OffscreenCanvas', undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    font: '', measureText: (text: string) => ({ width: text.length * 8,
      actualBoundingBoxDescent: 2, actualBoundingBoxAscent: 10 })
  }) as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('xterm-char-measure-element') ? 256 : 640
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(16)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 384, width: 640, height: 384, toJSON() {}
  })
})
afterEach(() => {
  releases.splice(0).reverse().forEach(release => release())
  document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function open(provider: 'bare' | 'osc8', encoding: 'sgr' | 'legacy') {
  const activate = vi.fn(), hover = vi.fn(), url = 'https://example.test/local'
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true,
    linkHandler: { activate, hover } })
  releases.push(() => terminal.dispose())
  if (provider === 'bare') terminal.loadAddon(new WebLinksAddon(activate, { hover }))
  const host = document.createElement('div'); document.body.append(host); terminal.open(host)
  const link = provider === 'bare' ? url : `\x1b]8;;${url}\x07declared link\x1b]8;;\x07`
  await new Promise<void>(resolve => terminal.write(`\x1b[?1000h${encoding === 'sgr' ? '\x1b[?1006h' : ''}${link}\r\nplain control`, resolve))
  expect(terminal.modes.mouseTrackingMode).toBe('vt200')
  const reports: Array<{ bytes: number[]; source: string }> = []
  const input = subscribeTerminalInput(terminal, (data, source) => reports.push({
    bytes: [...(typeof data === 'string' ? new TextEncoder().encode(data) : data)], source
  }))
  releases.push(() => input.dispose())
  const screen = host.querySelector<HTMLElement>('.xterm-screen')!
  // Browsers compute the default as 0px; happy-dom without a stylesheet returns an empty string.
  screen.style.padding = '0px'
  const cell = terminal.dimensions!.css.cell
  function mouse(type: string, col: number, row: number, buttons = 0) {
    screen.dispatchEvent(new MouseEvent(type, { button: 0, buttons, detail: 1,
      clientX: (col + .5) * cell.width, clientY: (row + .5) * cell.height,
      bubbles: true, cancelable: true }))
  }
  async function overLink() {
    mouse('mousemove', 0, 0)
    await vi.waitFor(() => expect(hover).toHaveBeenCalled())
  }
  return { terminal, activate, reports, mouse, overLink, url }
}

it.each([
  ['bare', 'sgr'], ['osc8', 'sgr'], ['bare', 'legacy'], ['osc8', 'legacy']
] as const)('%s/%s owns only the confirmed local link gesture while original input and link-start drag remain', async (provider, encoding) => {
  const { terminal, activate, reports, mouse, overLink, url } = await open(provider, encoding)
  await overLink(); mouse('mousedown', 0, 0, 1); mouse('mouseup', 0, 0)
  expect(activate).toHaveBeenCalledOnce(); expect(activate.mock.calls[0]![1]).toBe(url)
  expect(reports).toEqual([])

  mouse('mousemove', 0, 1); mouse('mousedown', 0, 1, 1); mouse('mouseup', 0, 1)
  expect(activate).toHaveBeenCalledOnce()
  const expected = encoding === 'sgr'
    ? ['\x1b[<0;1;2M', '\x1b[<0;1;2m'].map(text => [...new TextEncoder().encode(text)])
    : [[27, 91, 77, 32, 33, 34], [27, 91, 77, 35, 33, 34]]
  expect(reports).toEqual(expected.map(bytes => ({ bytes, source: 'user' })))

  reports.length = 0; terminal.clearSelection()
  await overLink(); mouse('mousedown', 0, 0, 1); mouse('mousemove', 7, 0, 1); mouse('mouseup', 7, 0)
  expect(terminal.hasSelection()).toBe(true)
  expect(terminal.getSelection()).toContain(provider === 'bare' ? 'https' : 'declar')
  expect(reports).toEqual([])
  terminal.input('Retained input', true)
  expect(reports).toEqual([{ bytes: [...new TextEncoder().encode('Retained input')], source: 'user' }])
})

it('a cached link outside the actual press cell neither claims that input nor arms a later link release', async () => {
  const { activate, reports, mouse, overLink } = await open('bare', 'sgr')
  await overLink()
  // Deliberately leave the original provider descriptor cached, then press elsewhere.
  mouse('mousedown', 0, 1, 1); mouse('mouseup', 0, 0)
  expect(activate).not.toHaveBeenCalled()
  expect(reports).toEqual(['\x1b[<0;1;2M', '\x1b[<0;1;1m'].map(text => ({
    bytes: [...new TextEncoder().encode(text)], source: 'user'
  })))
})
