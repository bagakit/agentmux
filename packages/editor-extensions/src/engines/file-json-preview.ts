import { parseTree, ParseErrorCode, type Node, type ParseError } from 'jsonc-parser'
import { dataPreviewBudget, type DataPreviewFailure } from './file-data-preview'

export type JsonPreview = { status: 'ready'; node: Node } | DataPreviewFailure
const ERROR_TEXT: Partial<Record<ParseErrorCode, string>> = {
  [ParseErrorCode.PropertyNameExpected]: 'A quoted property name is required',
  [ParseErrorCode.ValueExpected]: 'A JSON value is required',
  [ParseErrorCode.ColonExpected]: 'A colon is required after the property name',
  [ParseErrorCode.CommaExpected]: 'A comma is required between entries',
  [ParseErrorCode.CloseBraceExpected]: 'A closing brace is required',
  [ParseErrorCode.CloseBracketExpected]: 'A closing bracket is required',
  [ParseErrorCode.EndOfFileExpected]: 'Unexpected content after the JSON value',
  [ParseErrorCode.InvalidCommentToken]: 'Comments are supported in JSONC files',
  [ParseErrorCode.UnexpectedEndOfString]: 'The string needs a closing quote',
  [ParseErrorCode.InvalidNumberFormat]: 'The number has an invalid format',
  [ParseErrorCode.InvalidEscapeCharacter]: 'The string contains an invalid escape'
}

/** Microsoft's JSON/JSONC parser; no key sorting, coercion, or write-back. */
export function readJsonPreview(content: string, comments = false): JsonPreview {
  const budget = dataPreviewBudget(content)
  if (budget) return budget
  const errors: ParseError[] = []
  let node: Node | undefined
  try { node = parseTree(content, errors, { disallowComments: !comments, allowTrailingComma: comments }) }
  catch { return { status: 'invalid', message: 'This document is too deeply nested to read. The complete source remains editable.' } }
  const error = errors[0]
  if (error || !node) {
    const offset = error?.offset ?? 0
    const before = content.slice(0, offset), line = before.split('\n').length
    const column = offset - before.lastIndexOf('\n')
    return { status: 'invalid', message: `${error ? ERROR_TEXT[error.error] ?? 'Invalid JSON syntax' : 'A JSON value is required'} at line ${line}, column ${column}. The source is unchanged.` }
  }
  return { status: 'ready', node }
}
