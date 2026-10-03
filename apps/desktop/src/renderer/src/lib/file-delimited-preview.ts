import Papa from 'papaparse'
import { DATA_PREVIEW_MAX_COLUMNS, DATA_PREVIEW_MAX_ROWS, dataPreviewBudget, type DataPreviewFailure } from './file-data-preview'

export type DelimitedPreview = { status: 'ready'; rows: string[][]; columns: number; truncated: boolean } | DataPreviewFailure

/** CSV and TSV share Papa's quoted-field grammar, including embedded line breaks. */
export function readDelimitedPreview(content: string, delimiter: ',' | '\t'): DelimitedPreview {
  const budget = dataPreviewBudget(content)
  if (budget) return budget
  const result = Papa.parse<string[]>(content, { delimiter, preview: DATA_PREVIEW_MAX_ROWS + 1,
    dynamicTyping: false, skipEmptyLines: true })
  if (result.errors.length) return { status: 'invalid', message: `${result.errors[0]!.message} The source is unchanged.` }
  const columns = result.data.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  if (columns > DATA_PREVIEW_MAX_COLUMNS) return { status: 'too-large', message: `This file has ${columns} columns. Use Source to read all columns; table preview supports ${DATA_PREVIEW_MAX_COLUMNS}.` }
  return { status: 'ready', rows: result.data.slice(0, DATA_PREVIEW_MAX_ROWS), columns,
    truncated: result.meta.truncated || result.data.length > DATA_PREVIEW_MAX_ROWS }
}
