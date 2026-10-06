import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { Terminal, type ITheme } from '@xterm/xterm'
import { activateTerminalUnicodeWidth, UNICODE_WIDTH_VERSION } from '@agentmux/client-ui/terminal/unicode'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { MobileConnection } from '../conversation/MobileConversationSurface'
import { createMobileTerminalReader, type MobileTerminalReading } from './reader'
import { createMobileTerminalControl, type MobileTerminalControlState } from './control'
import { subscribeTerminalInput } from '@agentmux/client-ui/terminal/input'
import { bindMobileTerminalGestures, MOBILE_TERMINAL_FONT_DEFAULT } from './gestures'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

const noticeSummary = (message: string) => message.split(/[；。]/u, 1)[0]

export function MobileTerminalViewer({ client, agentSessionId, connection, platform, visible, inputActive = visible, terminalPalette }: {
  client: AgentMuxHostedClient | null; agentSessionId: string | null; connection: MobileConnection
  platform: ClientUiPlatform; visible: boolean; inputActive?: boolean; terminalPalette?: ITheme | undefined
}) {
  const paletteRef = useRef(terminalPalette); paletteRef.current = terminalPalette
  const container = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const canvasSession = useRef<string | null>(null)
  const [currentCanvas, setCurrentCanvas] = useState<Terminal | null>(null)
  const reader = useRef<ReturnType<typeof createMobileTerminalReader> | null>(null)
  const control = useRef<ReturnType<typeof createMobileTerminalControl> | null>(null)
  const controls = useRef(new Map<string, ReturnType<typeof createMobileTerminalControl>>())
  const selectedSession = useRef(agentSessionId); selectedSession.current = agentSessionId
  const [inputState, setInputState] = useState<MobileTerminalControlState>({ mode: 'watch', phase: 'idle', queuedBytes: 0,
    message: '观看不发送输入；PTY 尺寸沿用 Mac。', storageIssue: null })
  const [sizeOpen, setSizeOpen] = useState(false)
  const [cols, setCols] = useState('80'), [rows, setRows] = useState('24')
  const released = useRef<Promise<void>>(Promise.resolve())
  const visibleRef = useRef(visible); visibleRef.current = visible
  const [reading, setReading] = useState<MobileTerminalReading>({ phase: 'unavailable', message: '终端输出尚未核实。请选择原会话并恢复 Mac 连接。', historyBoundary: null })
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  const gestures = useRef<ReturnType<typeof bindMobileTerminalGestures> | null>(null)
  const [fontSize, setFontSize] = useState(MOBILE_TERMINAL_FONT_DEFAULT)
  const [renderIssue, setRenderIssue] = useState<string | null>(null)
  useEffect(() => {
    gestures.current?.reset()
    if (canvasSession.current !== agentSessionId) {
      if (reader.current) { released.current = reader.current.dispose(); reader.current = null }
      terminal.current?.dispose(); terminal.current = null; setCurrentCanvas(null); canvasSession.current = agentSessionId
    }
    if (!container.current || !agentSessionId || !visible || terminal.current) return
    const canvas = new Terminal({ cols: 80, rows: 24, scrollback: 10_000, fontSize, lineHeight: 1.15, allowProposedApi: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', disableStdin: true,
      altClickMovesCursor: false, mouseEventsRequireAlt: true, cursorBlink: false, cursorInactiveStyle: 'none', scrollOnUserInput: false,
      windowOptions: {}, theme: paletteRef.current ?? { background: '#151b1b', foreground: '#dce4e0', selectionBackground: '#bedbba40' } })
    canvas.open(container.current)
    const unicode = activateTerminalUnicodeWidth(canvas)
    setRenderIssue(unicode === UNICODE_WIDTH_VERSION ? null : '终端字宽配置尚未生效，部分符号可能错位；原输出与输入继续可用。重新打开终端可复查。')
    if (canvas.textarea) { canvas.textarea.readOnly = true; canvas.textarea.tabIndex = -1; canvas.textarea.inputMode = 'none' }
    // Terminal output cannot read/write the OS clipboard. Copy requires the explicit button below.
    canvas.parser.registerOscHandler(52, () => true)
    terminal.current = canvas
    setCurrentCanvas(canvas)
  }, [agentSessionId, visible])
  useEffect(() => { if (terminal.current && terminalPalette) terminal.current.options.theme = terminalPalette }, [terminalPalette])
  useEffect(() => {
    const canvas = currentCanvas, element = container.current
    if (!canvas || !element || !visible) return
    const binding = bindMobileTerminalGestures({ element, canvas,
      isVisible: () => visibleRef.current,
      isControl: () => {
        const facts = control.current?.facts()
        return canvas.options.disableStdin === false && facts?.mode === 'control' && facts.phase !== 'unknown'
      },
      reportFont: setFontSize })
    gestures.current = binding
    return () => { binding.dispose(); if (gestures.current === binding) gestures.current = null }
  }, [currentCanvas, visible])
  useEffect(() => () => {
    if (reader.current) { released.current = reader.current.dispose(); reader.current = null }
    terminal.current?.dispose(); terminal.current = null
    for (const binding of controls.current.values()) binding.dispose()
    controls.current.clear(); control.current = null
  }, [])
  useEffect(() => {
    const canvas = currentCanvas
    if (!canvas || canvas !== terminal.current || !client || !agentSessionId) return
    let disposed = false
    let binding: ReturnType<typeof createMobileTerminalReader> | null = null
    void released.current.then(() => {
      if (disposed) return
      binding = createMobileTerminalReader({ client, agentSessionId, canvas, report: setReading })
      reader.current = binding
      binding.setVisible(visibleRef.current)
    })
    // This reader remains passive; the independent explicit user control below owns Input.
    return () => {
      disposed = true
      if (reader.current === binding) reader.current = null
      released.current = binding?.dispose() ?? released.current
    }
  }, [client, agentSessionId, currentCanvas])
  useEffect(() => {
    const canvas = currentCanvas
    if (!canvas || canvas !== terminal.current || !agentSessionId) { control.current = null; return }
    let binding = controls.current.get(agentSessionId)
    if (!binding && client) {
      binding = createMobileTerminalControl({ client, agentSessionId, report: state => {
        // A late ACK for another selected Session must not change this Session's controls.
        if (selectedSession.current === agentSessionId) setInputState(state)
      } })
      controls.current.set(agentSessionId, binding)
    } else if (binding) binding.rebind(client)
    if (!binding) { control.current = null; return }
    control.current = binding
    const input = subscribeTerminalInput(canvas, (data, source) => {
      if (selectedSession.current === agentSessionId) binding.send(data, source)
    })
    return () => { input.dispose(); binding.watch(); if (control.current === binding) control.current = null }
  }, [client, agentSessionId, currentCanvas])
  // A covering dialog pauses only UI input. The retained workface still owns its passive read lease.
  useEffect(() => {
    reader.current?.setVisible(visible)
    if (!visible || !inputActive || connection.state !== 'connected') control.current?.watch()
  }, [visible, inputActive, connection.state])
  useEffect(() => {
    const canvas = currentCanvas
    if (!canvas) return
    // React may still render the previous Session's mode while the new canvas is
    // mounted. Only this selected Session's actual intent owner can admit input.
    const enabled = visible && inputActive && connection.state === 'connected' && inputState.mode === 'control' && inputState.phase !== 'unknown'
      && control.current === controls.current.get(agentSessionId ?? '') && control.current?.facts().mode === 'control' && control.current.facts().phase !== 'unknown'
    canvas.options.disableStdin = !enabled
    canvas.options.mouseEventsRequireAlt = !enabled
    if (canvas.textarea) {
      canvas.textarea.readOnly = !enabled; canvas.textarea.tabIndex = enabled ? 0 : -1; canvas.textarea.inputMode = enabled ? 'text' : 'none'
      canvas.textarea.setAttribute('aria-label', enabled ? '原会话终端输入' : '只读终端输出')
    }
  }, [currentCanvas, agentSessionId, visible, inputActive, connection.state, inputState.mode, inputState.phase])
  const enableControl = () => {
    if (connection.state !== 'connected' || !visible || !inputActive || control.current !== controls.current.get(agentSessionId ?? '') || !control.current?.enable()) return
    // Focus belongs to this explicit gesture, never foreground/reconnect or output restoration.
    const canvas = terminal.current
    if (!canvas) return
    canvas.options.disableStdin = false
    canvas.options.mouseEventsRequireAlt = false
    if (canvas.textarea) { canvas.textarea.readOnly = false; canvas.textarea.inputMode = 'text'; canvas.textarea.tabIndex = 0 }
    canvas.focus()
  }
  const copy = async () => {
    const selection = terminal.current?.getSelection()
    if (!selection) { setCopyNotice('请先选中需要复制的终端文字。'); return }
    try { setCopyNotice(await platform.copyText(selection, () => setCopyNotice('复制未完成；选中文字仍保留，可重新复制。')) ? '选中文字已复制。' : '复制未完成；选中文字仍保留，可重新复制。') }
    catch { setCopyNotice('复制未完成；选中文字仍保留，可重新复制。') }
  }
  const originalPending = control.current === controls.current.get(agentSessionId ?? '') ? control.current?.facts().pending : null
  return <section className="mobile-terminal" data-control={inputState.mode} data-agent-session-id={agentSessionId ?? undefined} data-reading={client && agentSessionId ? reading.phase : 'unavailable'}>
    <div className="mobile-terminal-toolbar"><span><SemanticIcon name="object.terminal" size={16} />{inputState.mode === 'control' ? '控制终端' : '观看终端'}</span>
      {agentSessionId && (inputState.mode === 'watch' ? <button className="mobile-terminal-mode" disabled={!client || connection.state !== 'connected' || inputState.phase === 'unknown'} onClick={enableControl}><SemanticIcon name="object.keyboard" size={16} />控制终端</button>
        : <button className="mobile-terminal-mode" onClick={() => control.current?.watch()}><SemanticIcon name="action.reveal" size={16} />回到观看</button>)}
      <button aria-label="复制选中文字" onClick={() => { void copy() }}><SemanticIcon name="action.copy" size={17} /></button><button aria-label="重新核实终端输出" onClick={() => { void reader.current?.retry() }}><SemanticIcon name="action.refresh" size={17} /></button></div>
    <div className="mobile-terminal-reading-tools" aria-label="本机终端阅读">
      <button aria-label="缩小终端文字" onClick={() => gestures.current?.zoom(fontSize - 1)}>A−</button>
      <button aria-label="恢复终端文字大小" onClick={() => gestures.current?.zoom(MOBILE_TERMINAL_FONT_DEFAULT)}>{fontSize}px</button>
      <button aria-label="放大终端文字" onClick={() => gestures.current?.zoom(fontSize + 1)}>A+</button>
      <button onClick={() => { terminal.current?.scrollToBottom(); if (container.current) container.current.scrollTop = container.current.scrollHeight }}>最新输出</button>
    </div>
    {inputState.mode === 'control' && <div className="mobile-terminal-keys" aria-label="终端常用按键">
      <button aria-expanded={sizeOpen} onClick={() => { setCols(String(terminal.current?.cols ?? 80)); setRows(String(terminal.current?.rows ?? 24)); setSizeOpen(value => !value) }}>PTY 尺寸</button>
      {([['Esc', '\x1b', null], ['Tab', '\t', null], ['Ctrl-C', '\x03', null], ['↑', '\x1b[A', 'control.key-up'], ['↓', '\x1b[B', 'control.key-down'], ['←', '\x1b[D', 'control.key-left'], ['→', '\x1b[C', 'control.key-right'], ['Enter', '\r', null]] as const).map(([label, data, icon]) =>
        <button key={label} disabled={inputState.phase === 'unknown' || connection.state !== 'connected'} aria-label={`终端 ${label}`} onClick={() => terminal.current?.input(data, true)}>{icon ? <SemanticIcon name={icon} size={16} /> : label}</button>)}
    </div>}
    {inputState.mode === 'control' && sizeOpen && <form className="mobile-terminal-size" onSubmit={event => {
      event.preventDefault(); if (control.current?.resize(Number(cols), Number(rows))) setSizeOpen(false)
    }}><label>列<TextInput aria-label="PTY 列数" inputMode="numeric" value={cols} onChange={event => setCols(event.target.value)} /></label><label>行<TextInput aria-label="PTY 行数" inputMode="numeric" value={rows} onChange={event => setRows(event.target.value)} /></label><button disabled={inputState.mode !== 'control' || inputState.phase === 'unknown'} type="submit">应用到原 Run</button><p>只按这次选择改变 Mac 的 PTY；手机旋转不会再改尺寸。</p></form>}
    {!agentSessionId && <div className="mobile-terminal-empty"><h2>查看原会话的终端</h2><p>先从会话列表选择一个已授权会话。这里只显示 Mac 持有的输出。</p></div>}
    <div className="mobile-terminal-canvas" ref={container} aria-label="原会话终端输出" />
    <aside className="mobile-terminal-notice" role="status">
      {renderIssue && <p>{renderIssue}</p>}
      <p>{noticeSummary(!client || !agentSessionId ? connection.message : reading.message)}</p>
      {agentSessionId && <p>{inputState.phase === 'unknown' ? '终端操作回执未确认；原操作不会重发。' : noticeSummary(inputState.message)}</p>}
      {inputState.phase === 'unknown' && <button onClick={() => { control.current?.continueAfterReview() }}>已在原会话核对，继续新输入</button>}
      {inputState.queuedBytes > 0 && <div className="mobile-terminal-unsent"><p>{inputState.queuedBytes} 字节尚未提交，仅在当前页面保留。</p><div className="mobile-terminal-unsent__actions"><button onClick={() => {
        const text = control.current?.queuedText(); if (text) void platform.copyText(text, () => setCopyNotice('复制未完成，未发送输入仍保留。'))
      }}>复制未发送输入</button><button onClick={() => control.current?.discardUnsent()}>放弃未发送输入</button></div></div>}
      {copyNotice && <p>{copyNotice}</p>}
      {inputState.storageIssue && <p>本机回执记录未确认；原字节保留。<span className="mobile-terminal-detail-hint">详情见下方</span></p>}
      {reading.historyBoundary && <p>{reading.historyBoundary}</p>}
      <details className="mobile-terminal-details"><summary>输出与操作详情</summary>
        <p>{!client || !agentSessionId ? connection.message : reading.message}</p>
        {agentSessionId && <p>{inputState.message}</p>}{inputState.storageIssue && <p>{inputState.storageIssue}</p>}
        {originalPending && <dl><dt>原 Run</dt><dd>{originalPending.runId}</dd>
          <dt>本机操作记录</dt><dd>{originalPending.intentId}</dd></dl>}
      </details>
    </aside>
  </section>
}
