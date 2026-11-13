import { useMemo, useRef } from 'react'
import type { MarkdownReadingLayout } from '@agentmux/client-ui/components/MarkdownReadingLayout'
import { useAppStore } from '../store'
import { api } from './api'
import { MARKDOWN_READING_FONT_SIZE_DEFAULT, MARKDOWN_READING_FONT_SIZE_MAX, MARKDOWN_READING_FONT_SIZE_MIN, resolveMarkdownPreferences,
  type MarkdownPreferences } from '../../../shared/markdown-preferences'

const FONT_SIZES = { min: MARKDOWN_READING_FONT_SIZE_MIN, max: MARKDOWN_READING_FONT_SIZE_MAX, default: MARKDOWN_READING_FONT_SIZE_DEFAULT }

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
      onChange(next) {
        const value: Required<MarkdownPreferences> = { readingWidth: next.width, readingTypeface: next.typeface, readingFontSize: next.fontSize }
        // Saves run in order; each compares against the configuration it read, so a newer choice is never overwritten.
        pending.current = pending.current.then(async () => {
          const config = useAppStore.getState().config
          if (!config) throw new Error('Configuration is unavailable. The reading layout was not saved; reload configuration and retry.')
          await api.config.save({ ...config, markdown: { ...config.markdown, ...value } }, config)
        }).catch(error => { useAppStore.getState().reportError(error instanceof Error ? error.message : String(error)) })
      }
    }
  }, [available, saved])
}
