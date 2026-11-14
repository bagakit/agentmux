import base from './vitest.mote-context.config.mts'
import { defineConfig } from 'vitest/config'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { readStyleSheet } from './helpers/styles'
import { listFeedbackSources } from '../scripts/verify-focus-list-feedback-mutations.mjs'

const mutation = process.env.AGENTMUX_LIST_MUTATION ? JSON.parse(process.env.AGENTMUX_LIST_MUTATION) : null
const digest = (source: string) => createHash('sha256').update(source).digest('hex')
const cssOwner = 'apps/desktop/src/renderer/src/styles/agent-operation-feedback.css'
function record(file: string, source: string, loaded: string) {
  const proof = { file, originalSHA256: digest(source), loadedSHA256: digest(loaded), mutation: loaded === source ? null : mutation?.label }
  if (process.env.AGENTMUX_LIST_LOADED) appendFileSync(process.env.AGENTMUX_LIST_LOADED, JSON.stringify(proof) + '\n')
  return process.env.AGENTMUX_LIST_EXECUTED
    ? `\nimport { appendFileSync as __listExecuted } from 'node:fs'; __listExecuted(${JSON.stringify(process.env.AGENTMUX_LIST_EXECUTED)}, ${JSON.stringify(JSON.stringify(proof) + '\n')});\n` : ''
}
function change(source: string, file: string) {
  if (mutation?.file !== file) return source
  if (source.split(mutation.before).length !== 2) throw new Error('Missing unique List mutation: ' + mutation.label)
  return source.replace(mutation.before, mutation.after)
}

export default defineConfig({ ...base, cacheDir: process.env.AGENTMUX_LIST_CACHE ?? '.tmp/focus-list-feedback-vitest',
  plugins: [...base.plugins ?? [], {
    name: 'focus-list-actual-source', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:focus-list-feedback-styles') return '\0focus-list-feedback-styles' },
    load(id) {
      if (id !== '\0focus-list-feedback-styles') return
      const source = readFileSync(new URL('../src/renderer/src/styles/agent-operation-feedback.css', import.meta.url), 'utf8')
      const loaded = change(source, cssOwner)
      const stylesheet = readStyleSheet('./index.css')
      if (!stylesheet.includes(source)) throw new Error('The actual CSS owner must be reachable through the Desktop import graph')
      return `export default ${JSON.stringify(stylesheet.replace(source, loaded))};` + record(cssOwner, source, loaded)
    },
    transform(source, id) {
      const file = relative(base.root!, id.split('?')[0]!)
      if (!listFeedbackSources.includes(file) || file.endsWith('.css')) return
      const loaded = change(source, file)
      let code = loaded
      if (file.endsWith('/FocusContextRow.tsx')) {
        const marker = '  const [menuOpen, setMenuOpen]'
        if (code.split(marker).length !== 2) throw new Error('The actual List row must be observed')
        code = code.replace(marker, '  ;(globalThis as any).__focusListRender?.("row", context.id)\n' + marker)
      }
      if (file.endsWith('/GlobalFocusSurface.tsx')) code = code.replace("  const surfaceVisible =", '  ;(globalThis as any).__focusListRender?.("surface")\n  const surfaceVisible =')
      if (file.endsWith('/use-collaboration-reading.ts')) code = code.replace('  const latestScope = useRef(scope)', '  ;(globalThis as any).__focusListRender?.("activity")\n  const latestScope = useRef(scope)')
      return { code: code + record(file, source, loaded), map: null }
    }
  }],
  test: { ...base.test, environment: 'happy-dom', setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false,
    passWithNoTests: false, testTimeout: 25000,
    include: ['apps/desktop/test/focus-list-feedback.test.tsx', 'apps/desktop/test/agent-operation-feedback.test.tsx'] }
})
