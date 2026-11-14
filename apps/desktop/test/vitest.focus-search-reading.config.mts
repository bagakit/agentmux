import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'
import { relative, resolve } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const components = 'apps/desktop/src/renderer/src/components/'
const targets = ['FocusSearchLocations.tsx', 'LocalRetainedInputs.tsx', 'GlobalFocusSurface.tsx'].map(name => components + name)
const mutants = {
 'first-location': [targets[0]!, 'onSelect(location)', 'onSelect(result.locations[0]!)'],
 'missing-native-fact': [targets[0]!, '{source.history?.previousNativeHandle ?', '{false ?'],
 'drop-orphan': [targets[1]!, 'inputs.slice(0, limit).map', 'inputs.filter(input => input.target).slice(0, limit).map'],
 'copy-preview': [targets[1]!, 'copyTextToClipboard(body,', 'copyTextToClipboard(input.text.trim(),'],
 'drop-images': [targets[1]!, 'restoreComposerInput(input.text, input.entry?.inputImages)', 'restoreComposerInput(input.text, undefined)'],
 'wrong-source-host': [targets[2]!, 'JSON.stringify([entry.identity.hostId, entry.sessionId])', "JSON.stringify(['local', entry.sessionId])"]
} as const
const selected = process.env.AGENTMUX_FOCUS_SEARCH_READING_MUTANT as keyof typeof mutants | undefined
if (selected && !mutants[selected]) throw Error('Unknown search reading mutation')
let applied = false
export default defineConfig({ ...source, cacheDir: '.tmp/focus-search-reading-cache',
 plugins: [{ name: 'actual-focus-search-reading-source', enforce: 'pre', transform(original, id) {
  const path = relative(source.root!, id.split('?')[0]!)
  if (!targets.includes(path)) return
  let code = original
  if (selected && path === mutants[selected][0]) {
   const [, before, after] = mutants[selected]
   if (code.split(before).length !== 2) throw Error('Unique actual search reading anchor required')
   code = code.replace(before, after); applied = true; process.stderr.write('MUTATION_APPLIED=' + selected + '\n')
  }
  if (process.env.AGENTMUX_FOCUS_SEARCH_READING_LOADED) appendFileSync(process.env.AGENTMUX_FOCUS_SEARCH_READING_LOADED, JSON.stringify({ path, sourceSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutant: code === original ? null : selected }) + '\n')
  if (code !== original) return { code, map: null }
 }, buildEnd() { if (selected && !applied) throw Error('The search reading inverse did not load its actual owner') } }],
 resolve: { ...source.resolve, alias: [
  { find: /^@agentmux\/browser\/(.*)$/, replacement: resolve(source.root!, 'packages/browser/src/$1.ts') },
  ...['index', 'node', 'runtime'].map(entry => ({ find: new RegExp('^@agentmux/capsule' + (entry === 'index' ? '' : '/' + entry) + '$'), replacement: resolve(source.root!, 'packages/capsule/src/' + entry + '.ts') })),
  ...source.resolve!.alias as []
 ] },
 test: { ...source.test, include: ['apps/desktop/test/focus-search-reading.test.tsx', 'apps/desktop/test/focus-search.test.tsx'], setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
