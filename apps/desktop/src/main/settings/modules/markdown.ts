import { MARKDOWN_READING_FONT_SIZE_DEFAULT, MARKDOWN_READING_FONT_SIZE_MAX, MARKDOWN_READING_FONT_SIZE_MIN, MARKDOWN_READING_TYPEFACES,
  MARKDOWN_READING_WIDTHS, resolveMarkdownPreferences } from '../../../shared/markdown-preferences.js'
import { enumSetting, integerSetting, type ScalarSetting } from '../scalar-setting.js'

/** The Markdown file preview reading layout; the original ConfigOwner performs every write. */
export const markdownSettings = [
  enumSetting('markdown.readingWidth', MARKDOWN_READING_WIDTHS, resolveMarkdownPreferences(undefined).readingWidth,
    config => resolveMarkdownPreferences(config.markdown).readingWidth,
    (config, readingWidth) => ({ ...config, markdown: { ...config.markdown, readingWidth } })),
  enumSetting('markdown.readingTypeface', MARKDOWN_READING_TYPEFACES, resolveMarkdownPreferences(undefined).readingTypeface,
    config => resolveMarkdownPreferences(config.markdown).readingTypeface,
    (config, readingTypeface) => ({ ...config, markdown: { ...config.markdown, readingTypeface } })),
  integerSetting('markdown.readingFontSize', { min: MARKDOWN_READING_FONT_SIZE_MIN, max: MARKDOWN_READING_FONT_SIZE_MAX }, MARKDOWN_READING_FONT_SIZE_DEFAULT,
    config => resolveMarkdownPreferences(config.markdown).readingFontSize,
    (config, readingFontSize) => ({ ...config, markdown: { ...config.markdown, readingFontSize } }))
] satisfies readonly ScalarSetting[]
