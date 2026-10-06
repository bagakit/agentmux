import { useEffect, useRef, useState } from 'react'
import { observeResolvedTheme, readResolvedTheme, workspaceTerminalPalette, mountThemeRuntime, updateObservedTheme, type AppAppearanceId, type ThemeDocument } from '@agentmux/client-ui/theme'
import { parseAppearanceObservation, type AgentMuxAppearanceObservation, type AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ITheme } from '@xterm/xterm'

const retained = '保留最后确认的主题和原工作面；重新连接 Mac 后继续同步。'
/** Colors are data, never CSS or xterm options. Core carries them as opaque JSON. */
export function observedTerminalPalette(value: unknown): ITheme {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('终端配色不是有效记录。')
  const entries = Object.entries(value)
  if (!entries.length || entries.length > 32) throw new Error('终端配色字段不受支持。')
  for (const [key, color] of entries) {
    if (key === 'extendedAnsi') {
      if (!Array.isArray(color) || color.length !== 240 || !color.every(item => typeof item === 'string' && /^#[0-9a-f]{6}$/iu.test(item))) throw new Error('终端 ANSI 配色不受支持。')
    } else if (!/^(?:background|foreground|cursor|cursorAccent|selectionBackground|selectionForeground|(?:bright)?(?:Black|Red|Green|Yellow|Blue|Magenta|Cyan|White)|black|red|green|yellow|blue|magenta|cyan|white)$/u.test(key)
      || typeof color !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color)) throw new Error('终端配色字段不受支持。')
  }
  return value as ITheme
}

/** One read lease on the existing Host transport; no local theme storage or Runtime event owner. */
export function useHostAppearance(client: AgentMuxHostedClient | null, connectionState: string) {
  const [issue, setIssue] = useState<string | null>(null)
  const [terminalPalette, setTerminalPalette] = useState<ITheme | undefined>()
  const terminalChoice = useRef<ITheme | 'workspace' | undefined>(undefined)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    try { const release = mountThemeRuntime(window); setMounted(true); return release }
    catch (cause) { setIssue(`主题呈现暂时不可用。${retained} ${cause instanceof Error ? cause.message : ''}`) }
  }, [])
  useEffect(() => {
    if (!mounted) return
    return observeResolvedTheme(theme => {
      if (terminalChoice.current === 'workspace') setTerminalPalette(workspaceTerminalPalette(theme))
    })
  }, [mounted])
  useEffect(() => {
    if (!mounted || !client || connectionState !== 'connected') return
    if (!client.subscribeRpc) { setIssue(`这个 Mac 尚未提供主题同步。${retained}`); return }
    const controller = new AbortController()
    let subscription: Awaited<ReturnType<NonNullable<AgentMuxHostedClient['subscribeRpc']>>> | undefined
    let previous: AgentMuxAppearanceObservation | undefined
    const accept = (raw: AgentMuxAppearanceObservation) => {
      if (controller.signal.aborted) return
      try {
        const snapshot = parseAppearanceObservation(raw, previous)
        // Advance the protocol cursor even for an unsupported client document. Never reapply stale data.
        previous = snapshot
        const values = snapshot.values
        const choice = values.terminalTheme === 'workspace' ? 'workspace' : observedTerminalPalette(values.terminalPalette)
        const result = updateObservedTheme({ ...(values.theme as object), id: values.themeId } as ThemeDocument,
          values.appAppearance as AppAppearanceId, window)
        if (!result.applied) throw new Error(result.reason ?? 'Host 主题格式不受支持。')
        terminalChoice.current = choice
        const palette = choice === 'workspace' ? workspaceTerminalPalette(readResolvedTheme()) : choice
        setTerminalPalette(previous => JSON.stringify(previous) === JSON.stringify(palette) ? previous : palette)
        setIssue(snapshot.issues.length ? `${snapshot.issues.map(item => item.message).join(' ')} 原工作面仍可使用。` : null)
      } catch (cause) {
        setIssue(`主题同步未完成。${retained} ${cause instanceof Error ? cause.message : ''}`)
      }
    }
    void client.subscribeRpc('settings.appearance.watch', {}, {
      signal: controller.signal, onInitial: initial => accept(initial.observation), onEvent: event => { if (event.type === 'snapshot') accept(event.data) },
      onEnd: error => { if (!controller.signal.aborted) setIssue(`主题同步连接已结束。${retained} ${error?.message ?? ''}`) }
    }).then(reader => { if (controller.signal.aborted) void reader.dispose(); else subscription = reader }, cause => {
      if (!controller.signal.aborted) setIssue(`主题同步暂时不可用。${retained} ${cause instanceof Error ? cause.message : ''}`)
    })
    return () => { controller.abort(); void subscription?.dispose() }
  }, [client, connectionState, mounted])
  return { issue, terminalPalette }
}
