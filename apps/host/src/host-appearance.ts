import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { AgentMuxError, type AgentMuxAppearanceObservationPort } from '@agentmux/core'
import { APP_APPEARANCE_IDS, TERMINAL_THEME_IDS } from '@agentmux/client-ui/theme'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { themeObservation, type ThemeConfiguration, type ThemeConfigurationReader } from './theme-observation.js'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
async function readTheme(path: string): Promise<ThemeConfiguration> {
  const configuration = await readOriginalMoteConfiguration(path), value = record(configuration) && configuration.appearance
  if (!record(value) || !TERMINAL_THEME_IDS.includes(value.terminalTheme as never)
    || value.themeId !== undefined && typeof value.themeId !== 'string'
    || value.appAppearance !== undefined && !APP_APPEARANCE_IDS.includes(value.appAppearance as never)
    || value.customThemes !== undefined && !record(value.customThemes)) throw new AgentMuxError(
      'The original appearance metadata is unreadable. The last confirmed theme and healthy Agents remain available.', 'CONTROL_UNAVAILABLE')
  return { appearance: value as ThemeConfiguration['appearance'] }
}
/** One exact-file read lease per real consumer; no writable or application-wide config mirror. */
export function createHostAppearanceObservation(configurationPath: string): AgentMuxAppearanceObservationPort {
  return { subscribe: async (onSnapshot, onEnd, signal) => {
    let closed = false, dirty = false, initializing = true, pending: Promise<void> | undefined, retry: NodeJS.Timeout | undefined
    let watcher: FSWatcher | undefined, confirmed: ThemeConfiguration | undefined
    let listener: ((saved: ThemeConfiguration, previous: ThemeConfiguration) => void) | undefined, failure: ((error: Error) => void) | undefined
    const issue = (cause: unknown) => new AgentMuxError(`Original appearance observation is unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}. The last confirmed theme and healthy Agents remain available; this reader will retry.`, 'CONTROL_UNAVAILABLE')
    const retryRead = () => {
      if (closed || retry) return
      retry = setTimeout(() => { retry = undefined; void refresh() }, 1000).unref()
    }
    const observe = () => {
      if (closed || watcher) return
      const current = watch(dirname(configurationPath), { persistent: false }, (_event, name) => {
        if (name === null || String(name) === basename(configurationPath)) void refresh()
      })
      watcher = current
      current.on('error', error => {
        if (watcher === current) watcher = undefined
        current.close(); failure?.(issue(error)); retryRead()
      })
    }
    const refresh = (): Promise<void> => {
      if (closed) return Promise.resolve()
      dirty = true
      if (pending || initializing) return pending ?? Promise.resolve()
      pending = (async () => {
        while (!closed && dirty) {
          dirty = false
          try {
            observe()
            const next = await readTheme(configurationPath)
            if (closed) return
            const previous = confirmed; confirmed = next
            if (previous) listener?.(next, previous)
          } catch (error) { if (!closed) { failure?.(issue(error)); retryRead() } }
        }
      })().finally(() => { pending = undefined })
      return pending
    }
    const dispose = () => { if (closed) return; closed = true; watcher?.close(); watcher = undefined; if (retry) clearTimeout(retry); listener = undefined; failure = undefined; signal.removeEventListener('abort', dispose) }
    signal.addEventListener('abort', dispose, { once: true })
    const reader: ThemeConfigurationReader = {
      async inspect(capture) {
        signal.throwIfAborted(); observe()
        const initial = await readTheme(configurationPath)
        signal.throwIfAborted(); confirmed = initial
        const result = capture(initial)
        // Observation was installed before the read. Re-read only an event that
        // arrived during that read, after the original listener is registered.
        initializing = false
        if (dirty) void refresh()
        return result
      },
      subscribe(next, onFailure) { listener = next; failure = onFailure; return () => { listener = undefined; failure = undefined } }
    }
    try {
      const subscription = await themeObservation(reader).subscribe(onSnapshot, onEnd, signal)
      return { ...subscription, dispose: () => { subscription.dispose(); dispose() } }
    } catch (error) { dispose(); throw error }
  } }
}
