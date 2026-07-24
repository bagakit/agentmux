import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DETECTABLE_LANGUAGE_IDS,
  getUnregisteredDetectedLanguageIds
} from '../src/renderer/src/lib/language-detect.js'
import { ASTRO_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-astro.js'
import { JSONL_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-jsonl.js'
import { SVELTE_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-svelte.js'
import { VUE_LANGUAGE_ID } from '../src/renderer/src/lib/monaco-languages/register-vue.js'

const require = createRequire(import.meta.url)

function installedMonacoLanguageIds(): Set<string> {
  const monacoRoot = resolve(dirname(require.resolve('monaco-editor')), '../..')
  const editorMainPath = join(monacoRoot, 'esm/vs/editor/editor.main.js')
  const editorMain = readFileSync(editorMainPath, 'utf8')
  const registerFiles = [...editorMain.matchAll(
    /['"](\.\.\/languages\/(?:definitions|features)\/[^'"]+\/register\.js)['"]/g
  )].map((match) => resolve(dirname(editorMainPath), match[1]!))
  const ids = new Set<string>()
  for (const registerFile of registerFiles) {
    const source = readFileSync(registerFile, 'utf8')
    for (const match of source.matchAll(/\bid:\s*["']([^"']+)["']/g)) ids.add(match[1]!)
  }
  const modesRegistry = readFileSync(
    join(monacoRoot, 'esm/vs/editor/common/languages/modesRegistry.js'),
    'utf8'
  )
  const plaintext = modesRegistry.match(/PLAINTEXT_LANGUAGE_ID\s*=\s*["']([^"']+)["']/)?.[1]
  if (!plaintext) throw new Error('Installed Monaco does not declare a plaintext language id')
  ids.add(plaintext)
  return ids
}

describe('Monaco language registration truth', () => {
  it('keeps every detector output inside the installed or AgentMux-registered language set', () => {
    const registered = installedMonacoLanguageIds()
    for (const customId of [
      VUE_LANGUAGE_ID,
      SVELTE_LANGUAGE_ID,
      ASTRO_LANGUAGE_ID,
      JSONL_LANGUAGE_ID
    ]) registered.add(customId)

    expect(DETECTABLE_LANGUAGE_IDS.length).toBeGreaterThan(1)
    expect(getUnregisteredDetectedLanguageIds(registered)).toEqual([])
  })

  it('reports the exact detector capability missing from a registry', () => {
    const registered = new Set(DETECTABLE_LANGUAGE_IDS)
    registered.delete('jsonl')
    expect(getUnregisteredDetectedLanguageIds(registered)).toEqual(['jsonl'])
  })
})
