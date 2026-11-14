import { MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { Terminal, type ITheme } from '@xterm/xterm'
import { activateTerminalUnicodeWidth, UNICODE_WIDTH_VERSION } from '@agentmux/client-ui/terminal/unicode'
import type { MobileTerminalClient } from '../conversation/mobile-conversation-client'
import type { ClientUiPlatform } from '@agentmux/client-ui/platform'
import type { MobileConnection } from '../conversation/MobileConversationSurface'
import { createMobileTerminalReader, type MobileTerminalReading } from './reader'
import { createMobileTerminalControl, type MobileTerminalControlState } from './control'
import { subscribeTerminalInput } from '@agentmux/client-ui/terminal/input'
import { bindMobileTerminalGestures, MOBILE_TERMINAL_FONT_DEFAULT } from './gestures'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { MobileSheetHeader } from '../navigation/MobileSheetHeader'

const noticeSummary = (message: string) => message.split(/[；。]/u, 1)[0]

/** Fixed 7-column keypad: movement on the first row, control on the second, so Esc, the arrows,
 * Ctrl-C and Enter keep their positions on every width. Bytes are the original terminal encodings. */
const MOBILE_TERMINAL_KEYS = [
  ['Esc', '\x1b', null, false], ['←', '\x1b[D', 'control.key-left', false], ['↑', '\x1b[A', 'control.key-up', false], ['↓', '\x1b[B', 'control.key-down', false],
  ['→', '\x1b[C', 'control.key-right', false], ['Tab', '\t', null, false], ['Enter', '\r', null, false],
  ['Ctrl-C', '\x03', null, true]
] as const

export function MobileTerminalViewer({ client, agentSessionId, connection, platform, visible, inputActive = visible, terminalPalette }: {
  client: MobileTerminalClient | null; agentSessionId: string | null; connection: MobileConnection
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
    message: '观看不发送输入，终端大小跟随远端。', storageIssue: null, notice: null })
  const [sizeOpen, setSizeOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(true)
  const [cols, setCols] = useState('80'), [rows, setRows] = useState('24')
  const released = useRef<Promise<void>>(Promise.resolve())
  const visibleRef = useRef(visible); visibleRef.current = visible
  const [reading, setReading] = useState<MobileTerminalReading>({ phase: 'unavailable', message: '还没有终端输出。请选择一个对话并连接 Mac。', historyBoundary: null, notice: null })
  const [copyFeedback, setCopyFeedback] = useState<{ message: string; issue: boolean } | null>(null)
  const gestures = useRef<ReturnType<typeof bindMobileTerminalGestures> | null>(null)
  const [fontSize, setFontSize] = useState(MOBILE_TERMINAL_FONT_DEFAULT)
  const [renderIssue, setRenderIssue] = useState<string | null>(null)
  const [readingOpen, setReadingOpen] = useState(false)
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
    setRenderIssue(unicode === UNICODE_WIDTH_VERSION ? null : '终端字宽设置没有生效，部分符号可能错位。输出和输入仍可使用。')
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
      canvas.textarea.setAttribute('aria-label', enabled ? '终端输入' : '只读终端输出')
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
  const copyText = async (text: string, successMessage: string) => {
    const failure = { message: '复制未完成；原文字仍保留，可重新复制。', issue: true }
    try {
      const copied = await platform.copyText(text, () => setCopyFeedback(failure))
      setCopyFeedback(copied ? { message: successMessage, issue: false } : failure)
    } catch { setCopyFeedback(failure) }
  }
  const copy = async () => {
    const selection = terminal.current?.getSelection()
    if (!selection) { setCopyFeedback({ message: '请先选中需要复制的终端文字。', issue: false }); return }
    await copyText(selection, '选中文字已复制。')
  }
  const serviceMessage = renderIssue ?? (connection.state !== 'connected' ? connection.message : null) ?? inputState.notice ?? reading.notice ?? inputState.storageIssue ?? (inputState.queuedBytes > 0 ? `${inputState.queuedBytes} 字节未发送` : copyFeedback?.issue ? copyFeedback.message : null)
  const originalPending = control.current === controls.current.get(agentSessionId ?? '') ? control.current?.facts().pending : null
  return <MobileNoticeScope owner={client} identity={[agentSessionId]}><section className="mobile-terminal" data-control={inputState.mode} data-agent-session-id={agentSessionId ?? undefined} data-reading={client && agentSessionId ? reading.phase : 'unavailable'}>
    <div className="mobile-terminal-toolbar" role="toolbar" aria-label="终端工具">
      <span className="mobile-terminal-mode-state" data-mode={inputState.mode}>{inputState.mode === 'control'
        ? <><span className="mobile-terminal-mode-state__dot" aria-hidden="true" />正在控制</>
        : <><SemanticIcon name="action.reveal" size={16} />只读查看<span className="mobile-terminal-mode-state__detail"> · 大小跟随远端</span></>}</span>
      {agentSessionId && (inputState.mode === 'watch' ? <button className="mobile-terminal-mode" disabled={!client || connection.state !== 'connected' || inputState.phase === 'unknown'} onClick={enableControl}>控制终端</button>
        : <button className="mobile-terminal-mode" onClick={() => control.current?.watch()}>回到观看</button>)}
      {inputState.mode === 'control' && <button className="mobile-terminal-keys-toggle" aria-label="终端按键" aria-expanded={keysOpen} onPointerDown={event => event.preventDefault()}
        onClick={() => { setKeysOpen(value => !value); setSizeOpen(false) }}><SemanticIcon name="object.keyboard" size={18} /></button>}
      <button aria-label="最新输出" onClick={() => { terminal.current?.scrollToBottom(); if (container.current) container.current.scrollTop = container.current.scrollHeight }}><SemanticIcon name="navigation.down" size={18} /></button>
      <button className="mobile-terminal-reading-trigger" aria-label="终端阅读与状态" aria-haspopup="dialog" data-notice={Boolean(serviceMessage)} title={serviceMessage ? noticeSummary(serviceMessage) : '阅读设置与输出详情'} onClick={() => { if (control.current?.facts().mode === 'control') control.current.watch(); setReadingOpen(true) }}><SemanticIcon name="action.read-terminal" size={18} />{serviceMessage && <span className="mobile-terminal-reading-notice" aria-label="有待核实事项"><SemanticIcon name="status.terminal-notice" size={6} /></span>}</button>
    </div>
    {inputState.mode === 'control' && keysOpen && <div className="mobile-terminal-keys" aria-label="终端常用按键">
      {MOBILE_TERMINAL_KEYS.map(([label, data, icon, wide]) =>
        <button key={label} type="button" className="mobile-terminal-key" data-wide={wide || undefined} disabled={inputState.phase === 'unknown' || connection.state !== 'connected'} aria-label={`终端 ${label}`}
          onPointerDown={event => event.preventDefault()} onClick={() => terminal.current?.input(data, true)}>{icon ? <SemanticIcon name={icon} size={18} /> : label}</button>)}
      <button type="button" className="mobile-terminal-key mobile-terminal-key--quiet" aria-expanded={sizeOpen} onClick={() => { setCols(String(terminal.current?.cols ?? 80)); setRows(String(terminal.current?.rows ?? 24)); setSizeOpen(value => !value) }}>终端大小</button>
    </div>}
    {inputState.mode === 'control' && keysOpen && sizeOpen && <form className="mobile-terminal-size" onSubmit={event => {
      event.preventDefault(); if (control.current?.resize(Number(cols), Number(rows))) setSizeOpen(false)
    }}><label>列<TextInput aria-label="终端列数" inputMode="numeric" value={cols} onChange={event => setCols(event.target.value)} /></label><label>行<TextInput aria-label="终端行数" inputMode="numeric" value={rows} onChange={event => setRows(event.target.value)} /></label><button disabled={inputState.mode !== 'control' || inputState.phase === 'unknown'} type="submit">应用到 Mac</button><p>只按这次选择改变 Mac 上的终端大小，手机旋转不会再改它。</p></form>}
    {!agentSessionId && <div className="mobile-terminal-empty"><h2>查看对话的终端</h2><p>先从会话列表选择一个已授权会话。这里只显示 Mac 持有的输出。</p></div>}
    <div className="mobile-terminal-canvas" style={{ background: terminalPalette?.background ?? '#151b1b' }} ref={container} aria-label="终端输出" />
    {serviceMessage && <aside className="mobile-terminal-notice" role="status">{serviceMessage}</aside>}
    <Dialog.Root open={readingOpen} onOpenChange={setReadingOpen}>
      <Dialog.Portal container={platform.overlayContainer()}><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-terminal-reading-sheet">
        <MobileSheetHeader onClose={() => setReadingOpen(false)} title="终端阅读" closeLabel="关闭终端阅读" />
        <Dialog.Description>缩放调整本机的显示大小。终端尺寸由运行它的设备决定。</Dialog.Description>
        <div className="mobile-terminal-reading-tools" aria-label="本机终端阅读">
          <button aria-label="缩小终端文字" onClick={() => gestures.current?.zoom(fontSize - 1)}><SemanticIcon name="action.decrease-font-size" size={18} /></button>
          <button aria-label="恢复终端文字大小" onClick={() => gestures.current?.zoom(MOBILE_TERMINAL_FONT_DEFAULT)}>{fontSize}px</button>
          <button aria-label="放大终端文字" onClick={() => gestures.current?.zoom(fontSize + 1)}><SemanticIcon name="action.increase-font-size" size={18} /></button>
        </div>
        <div className="mobile-terminal-reading-actions"><button onClick={() => { void copy() }}><SemanticIcon name="action.copy" size={16} />复制选中文字</button><button onClick={() => { void reader.current?.retry() }}><SemanticIcon name="action.refresh" size={16} />重新读取输出</button></div>
        <div className="mobile-terminal-details">
          {renderIssue && <p>{renderIssue}</p>}
          <p>{!client || !agentSessionId ? connection.message : reading.message}</p>
          {reading.notice && reading.notice !== reading.message && <p>{reading.notice}</p>}
          {agentSessionId && <p>{inputState.message}</p>}
          {inputState.notice && inputState.notice !== inputState.message && <p>{inputState.notice}</p>}
          {reading.historyBoundary && <p>{reading.historyBoundary}</p>}
          {inputState.storageIssue && <p>{inputState.storageIssue}</p>}
          {inputState.phase === 'unknown' && <button onClick={() => { control.current?.continueAfterReview() }}>已核对，继续输入</button>}
          {inputState.queuedBytes > 0 && <div className="mobile-terminal-unsent"><p>{inputState.queuedBytes} 字节尚未提交，仅在当前页面保留。</p><div className="mobile-terminal-unsent__actions"><button onClick={() => {
            const text = control.current?.queuedText(); if (text) void copyText(text, '未发送输入已复制。')
          }}>复制未发送输入</button><button onClick={() => control.current?.discardUnsent()}>放弃未发送输入</button></div></div>}
          {copyFeedback && <MobileNotice kind="feedback" identity={[copyFeedback?.message,copyFeedback?.issue]} role="status">{copyFeedback.message}</MobileNotice>}
          {originalPending && <dl><dt>运行</dt><dd>{originalPending.runId}</dd><dt>本机操作记录</dt><dd>{originalPending.intentId}</dd></dl>}
        </div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </section></MobileNoticeScope>
}
