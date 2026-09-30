// Observation only. Native parser, cell widths, Linkifier and renderer remain unchanged.
import { Terminal as PublishedTerminal } from '@xterm/xterm/lib/xterm.mjs'
import type { ILinkProvider, ITerminalOptions } from '@xterm/xterm'
export const Terminal = function (options?: ITerminalOptions) {
  const terminal = new PublishedTerminal(options)
  const w = window as unknown as { terminals: PublishedTerminal[]; pathQueries: unknown[]; pathHovers: unknown[] }
  w.terminals.push(terminal)
  const register = terminal.registerLinkProvider.bind(terminal)
  terminal.registerLinkProvider = (provider: ILinkProvider) => register({
    provideLinks(row, callback) {
      provider.provideLinks(row, links => {
        w.pathQueries.push({ row, links: links?.map(link => ({ text: link.text, range: link.range })) ?? [] })
        for (const link of links ?? []) {
          const hover = link.hover
          if (hover) link.hover = (event, text) => {
            w.pathHovers.push({ text: link.text, range: link.range, trusted: event.isTrusted })
            hover.call(link, event, text)
          }
        }
        callback(links)
      })
    }
  })
  return terminal
} as unknown as typeof PublishedTerminal
