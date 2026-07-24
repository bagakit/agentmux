import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef } from 'react'
import type { RuntimeEvent, SessionSnapshot } from '../../../shared/contracts'
import type { TerminalThemeId } from '../../../shared/contracts'
import { api } from '../lib/api'
import { terminalOptions, terminalTheme } from '../lib/terminal-theme'
import { TerminalViewportSynchronizer } from '../lib/terminal-viewport-sync'

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
    core.run.runId !== session.control.run.runId
  ) return null
  const byteRange = core.evidence.outputByteRange
  return byteRange ? { ...core, ...byteRange } : null
}

export function TerminalView({ session, themeId }: { session: SessionSnapshot; themeId: TerminalThemeId }) {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!rootRef.current) return
    const terminal = new Terminal({
      ...terminalOptions(themeId),
      allowProposedApi: false,
      scrollback: 5_000
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(rootRef.current)
    let disposed = false
    let attachmentId: string | null = null
    let readyForLiveOutput = false
    let cursor = 0
    let outputTail = Promise.resolve()
    let acknowledgeTail = Promise.resolve()
    const pending: RuntimeEvent[] = []
    let pendingBytes = 0
    let droppedPendingThrough = 0
    let renderReady: { dispose(): void } | null = null
    const viewport = new TerminalViewportSynchronizer({
      fit: () => {
        if (!fit.proposeDimensions()) return false
        fit.fit()
        renderReady?.dispose()
        renderReady = null
        return true
      },
      readGrid: () => ({ cols: terminal.cols, rows: terminal.rows }),
      resize: async ({ cols, rows }) => await api.sessions.resize(session.control, cols, rows),
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (frameId) => cancelAnimationFrame(frameId),
      onResizeError: (error) => console.warn('[terminal] failed to synchronize PTY viewport', error)
    })
    renderReady = terminal.onRender(() => viewport.observeViewport())

    const queueAcknowledge = (control: SessionSnapshot['control'], sequence: number): void => {
      acknowledgeTail = acknowledgeTail
        .catch(() => {})
        .then(async () => await api.sessions.acknowledge(control, sequence))
        .catch(() => {})
    }

    const accept = (event: RuntimeEvent): void => {
      const output = outputForSession(event, session)
      if (!output) return
      if (!readyForLiveOutput) {
        pending.push(event)
        pendingBytes += output.endByte - output.startByte
        while (
          pending.length > MAX_PENDING_OUTPUT_EVENTS ||
          pendingBytes > MAX_PENDING_OUTPUT_BYTES
        ) {
          const dropped = pending.shift()
          if (!dropped) break
          const droppedOutput = outputForSession(dropped, session)
          if (!droppedOutput) continue
          pendingBytes -= droppedOutput.endByte - droppedOutput.startByte
          droppedPendingThrough = Math.max(droppedPendingThrough, droppedOutput.endByte)
        }
        return
      }
      outputTail = outputTail.then(async () => {
        if (disposed || output.endByte <= cursor) return
        if (output.startByte !== cursor) {
          await terminalWrite(terminal, '\r\n\u001b[33m[Output sequence gap; earlier bytes are unavailable]\u001b[0m\r\n')
        }
        await terminalWrite(terminal, output.data)
        cursor = output.endByte
        queueAcknowledge(session.control, cursor)
      })
    }
    const disposeEvents = api.sessions.onEvent(accept)
    const resize = new ResizeObserver(() => viewport.observeViewport())
    resize.observe(rootRef.current)
    const input = terminal.onData((data) => {
      if (readyForLiveOutput) void api.sessions.write(session.control, data)
    })

    void (async () => {
      try {
        const result = await api.sessions.attach(session.control, 0)
        if (disposed) {
          await api.sessions.detach(result.attachmentId)
          return
        }
        attachmentId = result.attachmentId
        if (result.gap) {
          await terminalWrite(
            terminal,
            '\u001b[33m[Earlier terminal output fell outside the bounded replay window]\u001b[0m\r\n'
          )
          cursor = result.gap.firstAvailableByte
        }
        for (const event of result.replay) {
          await terminalWrite(terminal, event.data)
          cursor = event.endByte
        }
        if (droppedPendingThrough > cursor) {
          await terminalWrite(
            terminal,
            '\r\n\u001b[33m[Live output exceeded the pane startup buffer; omitted bytes were acknowledged]\u001b[0m\r\n'
          )
          cursor = droppedPendingThrough
        }
        await viewport.startLiveSynchronization()
        readyForLiveOutput = true
        if (cursor > 0) queueAcknowledge(result.session.control, cursor)
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

    viewport.observeViewport()
    return () => {
      disposed = true
      viewport.dispose()
      renderReady?.dispose()
      disposeEvents()
      input.dispose()
      resize.disconnect()
      if (attachmentId !== null) void api.sessions.detach(attachmentId)
      terminal.dispose()
    }
  }, [session.control.run.runId, session.id, themeId])

  return (
    <div
      className="terminal-view"
      ref={rootRef}
      style={{ backgroundColor: terminalTheme(themeId).background }}
    />
  )
}
