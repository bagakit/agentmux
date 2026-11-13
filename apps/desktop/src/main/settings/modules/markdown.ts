import type { AgentMuxControlSettingEntry } from '@agentmux/core'
import type { AppConfig } from '../../../shared/contracts.js'
import { MARKDOWN_READING_FONT_SIZE_DEFAULT, MARKDOWN_READING_FONT_SIZE_MAX, MARKDOWN_READING_FONT_SIZE_MIN, MARKDOWN_READING_TYPEFACES,
  MARKDOWN_READING_WIDTHS, resolveMarkdownPreferences, validMarkdownReadingFontSize } from '../../../shared/markdown-preferences.js'
import { enumSetting, invalid, type ScalarSetting } from '../scalar-setting.js'

/** The Markdown file preview reading layout; the original ConfigOwner performs every write. */
export const markdownSettings = [
  enumSetting('markdown.readingWidth', MARKDOWN_READING_WIDTHS, resolveMarkdownPreferences(undefined).readingWidth,
    config => resolveMarkdownPreferences(config.markdown).readingWidth,
    (config, readingWidth) => ({ ...config, markdown: { ...config.markdown, readingWidth } })),
  enumSetting('markdown.readingTypeface', MARKDOWN_READING_TYPEFACES, resolveMarkdownPreferences(undefined).readingTypeface,
    config => resolveMarkdownPreferences(config.markdown).readingTypeface,
    (config, readingTypeface) => ({ ...config, markdown: { ...config.markdown, readingTypeface } })),
  {
    key: 'markdown.readingFontSize',
    entry(config: AppConfig): AgentMuxControlSettingEntry { return {
      key: this.key, kind: 'number', value: resolveMarkdownPreferences(config.markdown).readingFontSize, default: MARKDOWN_READING_FONT_SIZE_DEFAULT,
      enum: Array.from({ length: MARKDOWN_READING_FONT_SIZE_MAX - MARKDOWN_READING_FONT_SIZE_MIN + 1 }, (_, index) => MARKDOWN_READING_FONT_SIZE_MIN + index)
    } },
    apply(config: AppConfig, value: string): AppConfig {
      const readingFontSize = Number(value)
      if (!/^\d+$/.test(value) || !validMarkdownReadingFontSize(readingFontSize)) throw invalid(this.key, value)
      return this.entry(config).value === readingFontSize ? config : { ...config, markdown: { ...config.markdown, readingFontSize } }
    }
  }
] satisfies readonly ScalarSetting[]
