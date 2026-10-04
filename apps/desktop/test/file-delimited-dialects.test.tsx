// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientUiProvider } from '@agentmux/client-ui/platform'
import { FileDataPreview } from '../src/renderer/src/components/FileDataPreview'
import { readDelimitedPreview } from '../src/renderer/src/lib/file-delimited-preview'
import { delimitedTokens, DelimitedState } from '../src/renderer/src/lib/monaco-languages/register-file-formats'
afterEach(() => vi.unstubAllGlobals())
describe('File CSV dialect and source columns', () => {
  it('preserves quoted separators, multiline strings, leading zeroes and formula-looking text across dialects', () => {
    for (const separator of [',', ';', '\t', '|'] as const) {
      const source = `Name${separator}Value${separator}Notes\nAda${separator}001${separator}"quoted${separator} field\nsecond ""line"""\nBo${separator}=1+1${separator}`
      expect(readDelimitedPreview(source, 'auto')).toMatchObject({ status: 'ready', delimiter: separator,
        rows: [['Name', 'Value', 'Notes'], ['Ada', '001', `quoted${separator} field\nsecond "line"`], ['Bo', '=1+1', '']] })
    }
    expect(readDelimitedPreview('one\n002', 'auto')).toMatchObject({ status: 'ready', rows: [['one'], ['002']] })
    expect(readDelimitedPreview('a;"unterminated', ';').status).toBe('invalid')
  })
  it('keeps a multiline quoted field in its original column and starts the next record at column one', () => {
    const provider = delimitedTokens(null)
    const header = provider.tokenize('Name;Value;Notes', provider.getInitialState())
    const line = provider.tokenize('Ada;001;"first;line', header.endState)
    expect(line.endState).toEqual(new DelimitedState(';', 2, true))
    const continued = provider.tokenize('second ""quoted"" line";last', line.endState)
    expect(continued.tokens[0]!.scopes).toBe(line.tokens.at(-1)!.scopes)
    expect(continued.tokens.filter(token => token.scopes === 'delimiter')).toHaveLength(1)
    const next = provider.tokenize('Bo;002;', continued.endState)
    expect(next.tokens[0]!.scopes).toBe(header.tokens[0]!.scopes)
    expect(new Set(header.tokens.filter(token => token.scopes !== 'delimiter').map(token => token.scopes)).size).toBe(3)
  })
  it('the actual table control reparses a selected delimiter without changing its source', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div'), root = createRoot(container)
    const content = 'Name;Value\nAda;001'
    const platform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
    try {
      await act(async () => root.render(<ClientUiProvider platform={platform}><FileDataPreview content={content} kind="csv" /></ClientUiProvider>))
      expect(container.querySelectorAll('thead th')).toHaveLength(3)
      const select = container.querySelector<HTMLSelectElement>('select[aria-label="Table separator"]')!
      await act(async () => { select.value = ','; select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(container.querySelectorAll('thead th')).toHaveLength(2)
      expect(container.textContent).toContain('Ada;001')
      await act(async () => { select.value = ';'; select.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(container.querySelectorAll('thead th')).toHaveLength(3)
      expect(container.textContent).toContain('001')
      expect(content).toBe('Name;Value\nAda;001')
    } finally { await act(async () => root.unmount()) }
  })
})
