import { fileFormatExtension } from './format-support'

/** Only the explicit formatting Worker imports parsers; this never executes project configuration. */
export async function formatFileContent(path: string, content: string): Promise<string> {
  const extension = fileFormatExtension(path)
  if (extension === 'jsonl' || extension === 'ndjson') {
    const jsonc = await import('jsonc-parser')
    const lines = content.split(/\r?\n/), newline = content.includes('\r\n') ? '\r\n' : '\n'
    return lines.map((line, index) => {
      if (index === lines.length - 1 && line === '') return ''
      const errors: import('jsonc-parser').ParseError[] = []
      jsonc.parseTree(line, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false })
      if (errors.length) throw new Error(`JSONL line ${index + 1} is invalid. The draft is unchanged.`)
      return jsonc.applyEdits(line, jsonc.format(line, undefined, { insertSpaces: true, tabSize: 2, eol: newline, keepLines: true }))
    }).join(newline)
  }
  if (extension === 'csv' || extension === 'tsv') {
    const { default: Papa } = await import('papaparse')
    const delimiter = extension === 'tsv' ? '\t' : Papa.parse(content, { delimitersToGuess: [',', ';', '\t', '|'], dynamicTyping: false, skipEmptyLines: true }).meta.delimiter
    const parsed = Papa.parse<string[]>(content, { delimiter, dynamicTyping: false, skipEmptyLines: false })
    const error = parsed.errors.find(item => item.type !== 'Delimiter')
    if (error) throw new Error(`${error.message} The draft is unchanged.`)
    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const formatted = Papa.unparse(parsed.data, { delimiter, newline, skipEmptyLines: false })
    const checked = Papa.parse<string[]>(formatted, { delimiter, dynamicTyping: false, skipEmptyLines: false })
    if (checked.errors.length || JSON.stringify(checked.data) !== JSON.stringify(parsed.data)) throw new Error('CSV normalization could not preserve all fields and records. The draft is unchanged.')
    return formatted
  }
  const prettier = await import('prettier/standalone')
  let parser: string, plugins: import('prettier').Plugin[]
  switch (extension) {
    case 'js': case 'jsx': case 'mjs': case 'cjs': case 'json': case 'jsonc':
      parser = extension === 'json' || extension === 'jsonc' ? 'json' : 'babel'
      plugins = [await import('prettier/plugins/babel'), await import('prettier/plugins/estree')]
      break
    case 'ts': case 'tsx': case 'mts': case 'cts':
      parser = 'typescript'; plugins = [await import('prettier/plugins/typescript'), await import('prettier/plugins/estree')]; break
    case 'html': case 'htm':
      parser = 'html'; plugins = [await import('prettier/plugins/html')]; break
    case 'css': case 'scss': case 'less':
      parser = extension; plugins = [await import('prettier/plugins/postcss')]; break
    case 'md': case 'markdown': case 'mdown':
      parser = 'markdown'; plugins = [await import('prettier/plugins/markdown')]; break
    case 'yaml': case 'yml':
      parser = 'yaml'; plugins = [await import('prettier/plugins/yaml')]; break
    default: throw new Error('This file has no source-preserving formatter.')
  }
  return await prettier.format(content, { filepath: path, parser, plugins, embeddedLanguageFormatting: 'off', endOfLine: content.includes('\r\n') ? 'crlf' : 'lf' })
}
