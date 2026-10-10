import { createRequire } from 'node:module'

// The parser's named-entity dependency exports both DOM and pure lookup variants.
// Dev prebundling shares dependencies with workers, so all Note clients select
// that package's default pure algorithm instead of its document-based shortcut.
export const noteParsingAliases: Record<string, string> = {
  'decode-named-character-reference': createRequire(import.meta.url).resolve('decode-named-character-reference')
}
