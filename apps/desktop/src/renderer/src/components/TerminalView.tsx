import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import type { RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'
import { api } from '../lib/api'

function terminalWrite(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

const MAX_PENDING_OUTPUT_EVENTS = 256
const MAX_PENDING_OUTPUT_BYTES = 512 * 1024

function outputForSession(event: RuntimeEvent, session: SessionSnapshot) {
  const core = event.event
  if (
    event.hostId !== session.hostId ||
    core.type !== 'terminal-output' ||
    core.daemonSession.sessionId !== session.control.daemonSession.sessionId ||
    core.daemonSession.incarnationId !== session.control.daemonSession.incarnationId
  ) return null
  const sequence = core.evidence.outputSequence
  return sequence ? { ...core, startSequence: sequence.start, endSequence: sequence.end } : null
}

export function TerminalView({ session }: { session: SessionSnapshot }) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!rootRef.current) return
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "Cascadia Code", "JetBrains Mono", monospace',
      fontSize: 15,
      lineHeight: 1.4,
      scrollback: 5_000,
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
    let disposed = false
    let attached = false
    let cursor = 0
    let outputTail = Promise.resolve()
    let acknowledgeTail = Promise.resolve()
    const pending: RuntimeEvent[] = []
    let pendingBytes = 0
    let droppedPendingThrough = 0

    const queueAcknowledge = (control: SessionSnapshot['control'], sequence: number): void => {
      acknowledgeTail = acknowledgeTail
        .catch(() => {})
        .then(async () => await api.sessions.acknowledge(control, sequence))
        .catch(() => {})
    }

    const accept = (event: RuntimeEvent): void => {
      const output = outputForSession(event, session)
      if (!output) return
      if (!attached) {
        pending.push(event)
        pendingBytes += output.endSequence - output.startSequence
        while (
          pending.length > MAX_PENDING_OUTPUT_EVENTS ||
          pendingBytes > MAX_PENDING_OUTPUT_BYTES
        ) {
          const dropped = pending.shift()
          if (!dropped) break
          const droppedOutput = outputForSession(dropped, session)
          if (!droppedOutput) continue
          pendingBytes -= droppedOutput.endSequence - droppedOutput.startSequence
          droppedPendingThrough = Math.max(droppedPendingThrough, droppedOutput.endSequence)
        }
        return
      }
      outputTail = outputTail.then(async () => {
        if (disposed || output.endSequence <= cursor) return
        if (output.startSequence !== cursor) {
          await terminalWrite(terminal, '\r\n\u001b[33m[Output sequence gap; earlier bytes are unavailable]\u001b[0m\r\n')
        }
        await terminalWrite(terminal, output.data)
        cursor = output.endSequence
        queueAcknowledge(session.control, cursor)
      })
    }
    const disposeEvents = api.sessions.onEvent(accept)
    const resize = new ResizeObserver(() => {
      fit.fit()
      if (attached) void api.sessions.resize(session.control, terminal.cols, terminal.rows)
    })
    resize.observe(rootRef.current)
    const input = terminal.onData((data) => {
      if (attached) void api.sessions.write(session.control, data)
    })

    void (async () => {
      try {
        const result = await api.sessions.attach(session.control, 0)
        if (disposed) {
          await api.sessions.detach(result.session.control)
          return
        }
        if (result.gap) {
          await terminalWrite(
            terminal,
            '\u001b[33m[Earlier terminal output fell outside the bounded replay window]\u001b[0m\r\n'
          )
          cursor = result.gap.firstAvailableSequence
        }
        for (const event of result.replay) {
          await terminalWrite(terminal, event.data)
          cursor = event.endSequence
        }
        if (droppedPendingThrough > cursor) {
          await terminalWrite(
            terminal,
            '\r\n\u001b[33m[Live output exceeded the pane startup buffer; omitted bytes were acknowledged]\u001b[0m\r\n'
          )
          cursor = droppedPendingThrough
        }
        attached = true
        if (cursor > 0) queueAcknowledge(result.session.control, cursor)
        fit.fit()
        await api.sessions.resize(result.session.control, terminal.cols, terminal.rows)
        for (const event of pending.splice(0)) accept(event)
      } catch (error) {
        if (!disposed) {
          const detail = (error instanceof Error ? error.message : String(error))
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
          await terminalWrite(
            terminal,
            `\r\n\u001b[31m[Attach failed: ${detail}]\u001b[0m\r\n`
          )
        }
      }
    })()

    requestAnimationFrame(() => fit.fit())
    return () => {
      disposed = true
      disposeEvents()
      input.dispose()
      resize.disconnect()
      if (attached) void api.sessions.detach(session.control)
      terminal.dispose()
    }
  }, [session.control.daemonSession.incarnationId, session.control.daemonSession.sessionId, session.id])

  return <div className="terminal-view" ref={rootRef} />
}
