import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import { api } from '../lib/api'

export function TerminalView({ sessionId, snapshot }: { sessionId: string; snapshot: string }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!rootRef.current) return
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 15,
      lineHeight: 1.4,
      scrollback: 10_000,
      theme: {
        background: '#0c0f11',
        foreground: '#d8ddd8',
        cursor: '#a8f0c6',
        selectionBackground: '#31574688',
        black: '#171b1e',
        red: '#ff7676',
        green: '#88d7a6',
        yellow: '#e4c875',
        blue: '#80aeea',
        magenta: '#c69be8',
        cyan: '#73cbd0',
        white: '#d8ddd8'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(rootRef.current)
    terminalRef.current = terminal
    fitRef.current = fit
    const resize = new ResizeObserver(() => {
      fit.fit()
      void api.sessions.resize(sessionId, terminal.cols, terminal.rows)
    })
    resize.observe(rootRef.current)
    const input = terminal.onData((data) => void api.sessions.send(sessionId, data, false))
    requestAnimationFrame(() => fit.fit())
    return () => {
      input.dispose()
      resize.disconnect()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.clear()
    terminal.write('\u001b[H\u001b[2J')
    terminal.write(snapshot.replaceAll('\n', '\r\n'))
  }, [snapshot])

  return <div className="terminal-view" ref={rootRef} />
}
