import { useMemo, useRef } from 'react'
import type { MarkdownReadingLayout, MarkdownReadingLayoutChange } from '@agentmux/client-ui/components/MarkdownReadingLayout'
import { useAppStore } from '../store'
import { api } from './api'
import { MARKDOWN_READING_FONT_SIZE_DEFAULT, MARKDOWN_READING_FONT_SIZE_MAX, MARKDOWN_READING_FONT_SIZE_MIN, resolveMarkdownPreferences,
  type MarkdownPreferences } from '../../../shared/markdown-preferences'

const FONT_SIZES = { min: MARKDOWN_READING_FONT_SIZE_MIN, max: MARKDOWN_READING_FONT_SIZE_MAX, default: MARKDOWN_READING_FONT_SIZE_DEFAULT }

/** Apply one reader choice to the layout saved at the time of this save, so quick successive choices compose. */
export function applyMarkdownReadingChange(saved: MarkdownPreferences | undefined, change: MarkdownReadingLayoutChange): Required<MarkdownPreferences> {
  const current = resolveMarkdownPreferences(saved)
  if (change.kind === 'width') return { ...current, readingWidth: change.width }
  if (change.kind === 'typeface') return { ...current, readingTypeface: change.typeface }
  if (change.kind === 'font-size-reset') return { ...current, readingFontSize: MARKDOWN_READING_FONT_SIZE_DEFAULT }
  return { ...current, readingFontSize: Math.min(MARKDOWN_READING_FONT_SIZE_MAX, Math.max(MARKDOWN_READING_FONT_SIZE_MIN, current.readingFontSize + change.step)) }
}

/** One global layout owned by the Desktop ConfigOwner; every open Markdown preview reads the same saved value. */
export function useMarkdownReadingLayout(): MarkdownReadingLayout | undefined {
  const saved = useAppStore(state => state.config?.markdown)
  const available = useAppStore(state => Boolean(state.config))
  const pending = useRef(Promise.resolve())
  return useMemo(() => {
    if (!available) return undefined
    const current = resolveMarkdownPreferences(saved)
    return {
      value: { width: current.readingWidth, typeface: current.readingTypeface, fontSize: current.readingFontSize },
      fontSizes: FONT_SIZES,
      onChange(change) {
        // Saves run in order; each applies only its own choice to the configuration current when it runs.
        pending.current = pending.current.then(async () => {
          const config = useAppStore.getState().config
          if (!config) throw new Error('Configuration is unavailable. The reading layout was not saved; reload configuration and retry.')
          const saved = await api.config.save({ ...config, markdown: { ...config.markdown, ...applyMarkdownReadingChange(config.markdown, change) } }, config)
          // The committed receipt is the base for the next queued choice; a newer pushed config wins.
          if (useAppStore.getState().config === config) useAppStore.getState().setConfig(saved)
        }).catch(error => { useAppStore.getState().reportError(error instanceof Error ? error.message : String(error)) })
      }
    }
  }, [available, saved])
}
