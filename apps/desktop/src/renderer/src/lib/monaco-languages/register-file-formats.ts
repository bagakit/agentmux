import type * as Monaco from 'monaco-editor'

export const FILE_FORMAT_LANGUAGE_IDS = ['toml', 'mermaid', 'dot', 'plantuml', 'latex', 'typst', 'csv', 'tsv'] as const
const columns = ['type.identifier', 'string', 'number', 'keyword', 'tag', 'annotation']

export class DelimitedState {
  constructor(readonly delimiter: string | null, readonly column = 0, readonly quoted = false) {}
  clone() { return new DelimitedState(this.delimiter, this.column, this.quoted) }
  equals(other: Monaco.languages.IState): boolean { return other instanceof DelimitedState && other.delimiter === this.delimiter && other.column === this.column && other.quoted === this.quoted }
}

function guessDelimiter(line: string): string {
  const counts = new Map([',', ';', '\t', '|'].map(value => [value, 0]))
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === '"') { if (quoted && line[index + 1] === '"') index++; else quoted = !quoted }
    else if (!quoted && counts.has(char)) counts.set(char, counts.get(char)! + 1)
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]![0]
}

/** Quoted multiline fields keep their column; escaped quotes do not create a new field. */
export function delimitedTokens(delimiter: string | null): Monaco.languages.TokensProvider {
  return {
    getInitialState: () => new DelimitedState(delimiter),
    tokenize(line, input) {
      const state = input as DelimitedState, separator = state.delimiter ?? guessDelimiter(line)
      let column = state.column, quoted = state.quoted, fieldStart = !quoted
      const tokens: Monaco.languages.IToken[] = [{ startIndex: 0, scopes: columns[column % columns.length]! }]
      for (let index = 0; index < line.length; index++) {
        const char = line[index]!
        if (char === '"') {
          if (quoted && line[index + 1] === '"') { index++; continue }
          if (quoted || fieldStart) quoted = !quoted
        } else if (char === separator && !quoted) {
          tokens.push({ startIndex: index, scopes: 'delimiter' })
          column++; fieldStart = true
          if (index + 1 < line.length) tokens.push({ startIndex: index + 1, scopes: columns[column % columns.length]! })
          continue
        }
        fieldStart = false
      }
      return { tokens, endState: new DelimitedState(separator, quoted ? column : 0, quoted) }
    }
  }
}

const common: Monaco.languages.IMonarchLanguage['tokenizer'] = {
  root: [[/\s+/, 'white'], [/"(?:[^"\\]|\\.)*"|'[^']*'/, 'string'], [/\b(?:true|false|null)\b/, 'keyword'], [/-?\b\d+(?:\.\d+)?\b/, 'number'], [/[{}()[\]]/, '@brackets'], [/[=,:;<>|+*-]/, 'delimiter'], [/[\w.-]+/, 'identifier']]
}

export function registerFileFormatLanguages(monaco: typeof Monaco): void {
  const definitions: Record<string, Monaco.languages.IMonarchLanguage> = {
    toml: { tokenizer: { root: [[/#.*$/, 'comment'], [/"""/, 'string', '@multiline'], [/'''/, 'string', '@literal'], [/\b\d{4}-\d\d-\d\d(?:[Tt ][\d:.+-]+[Zz]?)?/, 'number.date'], ...common.root!], multiline: [[/"""/, 'string', '@pop'], [/[^"\\]+/, 'string'], [/\\./, 'string.escape'], [/"/, 'string']], literal: [[/'''/, 'string', '@pop'], [/[^']+/, 'string'], [/'/, 'string']] } },
    mermaid: { tokenizer: { root: [[/%%.*$/, 'comment'], [/\b(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|mindmap|timeline|subgraph|end|participant|actor|note|rect|loop|alt|else)\b/, 'keyword'], [/[-=.]+[<>|o]*|[<>|o]*[-=.]+/, 'delimiter'], ...common.root!] } },
    dot: { tokenizer: { root: [[/\/\/.*$|#.*$/, 'comment'], [/\/\*/, 'comment', '@comment'], [/\b(?:strict|graph|digraph|subgraph|node|edge)\b/, 'keyword'], [/--|->/, 'delimiter'], ...common.root!], comment: [[/\*\//, 'comment', '@pop'], [/./, 'comment']] } },
    plantuml: { tokenizer: { root: [[/'.*$/, 'comment'], [/@(?:start|end)\w+|!\w+/, 'keyword'], [/\b(?:class|interface|actor|participant|entity|database|package|component|note|end|alt|else|loop)\b/, 'keyword'], ...common.root!] } },
    latex: { tokenizer: { root: [[/%.*$/, 'comment'], [/\\(?:[a-zA-Z]+|.)/, 'keyword'], [/\$\$?|[{}]/, 'delimiter'], [/[^\\%${}]+/, 'string']] } },
    typst: { tokenizer: { root: [[/\/\/.*$/, 'comment'], [/\/\*/, 'comment', '@comment'], [/#(?:let|set|show|import|include|if|else|for|while|return|break|continue)\b/, 'keyword'], [/#\w[\w.-]*/, 'type.identifier'], [/\$|[=*]/, 'delimiter'], ...common.root!], comment: [[/\*\//, 'comment', '@pop'], [/./, 'comment']] } }
  }
  for (const id of FILE_FORMAT_LANGUAGE_IDS) {
    if (monaco.languages.getLanguages().some(value => value.id === id)) continue
    monaco.languages.register({ id })
    if (id === 'csv' || id === 'tsv') monaco.languages.setTokensProvider(id, delimitedTokens(id === 'tsv' ? '\t' : null))
    else monaco.languages.setMonarchTokensProvider(id, definitions[id]!)
  }
}
