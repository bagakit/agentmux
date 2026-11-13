/** One reading layout for every Markdown file preview; files and other readers are unaffected. */
export const MARKDOWN_READING_WIDTHS = ['standard', 'wide', 'full'] as const
export const MARKDOWN_READING_TYPEFACES = ['sans', 'serif'] as const
export const MARKDOWN_READING_FONT_SIZE_MIN = 12
export const MARKDOWN_READING_FONT_SIZE_MAX = 20
export const MARKDOWN_READING_FONT_SIZE_DEFAULT = 13
export type MarkdownReadingWidth = typeof MARKDOWN_READING_WIDTHS[number]
export type MarkdownReadingTypeface = typeof MARKDOWN_READING_TYPEFACES[number]

export type MarkdownPreferences = { readingWidth?: MarkdownReadingWidth; readingTypeface?: MarkdownReadingTypeface; readingFontSize?: number }

export function validMarkdownReadingFontSize(value: number): boolean {
  return Number.isInteger(value) && value >= MARKDOWN_READING_FONT_SIZE_MIN && value <= MARKDOWN_READING_FONT_SIZE_MAX
}

export function resolveMarkdownPreferences(value: MarkdownPreferences | undefined): Required<MarkdownPreferences> {
  return {
    readingWidth: value?.readingWidth ?? 'standard',
    readingTypeface: value?.readingTypeface ?? 'sans',
    readingFontSize: value?.readingFontSize !== undefined && validMarkdownReadingFontSize(value.readingFontSize) ? value.readingFontSize : MARKDOWN_READING_FONT_SIZE_DEFAULT
  }
}
