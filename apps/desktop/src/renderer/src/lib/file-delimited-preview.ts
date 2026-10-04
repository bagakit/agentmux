import Papa from 'papaparse'
import { DATA_PREVIEW_MAX_COLUMNS, DATA_PREVIEW_MAX_ROWS, dataPreviewBudget, type DataPreviewFailure } from './file-data-preview'

export type DelimitedDialect = 'auto' | ',' | ';' | '\t' | '|'
export type DelimitedPreview = { status: 'ready'; rows: string[][]; columns: number; delimiter: string; truncated: boolean } | DataPreviewFailure

/** CSV and TSV share Papa's quoted-field grammar, including embedded line breaks. */
export function readDelimitedPreview(content: string, dialect: DelimitedDialect): DelimitedPreview {
  const budget = dataPreviewBudget(content)
  if (budget) return budget
  const result = Papa.parse<string[]>(content, { delimiter: dialect === 'auto' ? '' : dialect, delimitersToGuess: [',', ';', '\t', '|'], preview: DATA_PREVIEW_MAX_ROWS + 1,
    dynamicTyping: false, skipEmptyLines: true })
  const error = result.errors.find(error => error.type !== 'Delimiter')
  if (error) return { status: 'invalid', message: `${error.message} The source is unchanged.` }
  const columns = result.data.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  if (columns > DATA_PREVIEW_MAX_COLUMNS) return { status: 'too-large', message: `This file has ${columns} columns. Use Source to read all columns; table preview supports ${DATA_PREVIEW_MAX_COLUMNS}.` }
  return { status: 'ready', rows: result.data.slice(0, DATA_PREVIEW_MAX_ROWS), columns, delimiter: result.meta.delimiter,
    truncated: result.meta.truncated || result.data.length > DATA_PREVIEW_MAX_ROWS }
}
