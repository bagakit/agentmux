import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const owner = 'apps/desktop/src/renderer/src/lib/agent-focus.ts'
const mutation = process.env.AGENTMUX_FOCUS_RETENTION_MUTATION
if (mutation && mutation !== 'drop-unobserved-focus') throw Error('Unknown original Focus retention mutation')
export default defineConfig({ ...source, plugins: [...source.plugins ?? [], { name: 'original-focus-cold-start-owner', enforce: 'pre', transform(input, id) {
  const path = relative(root, id.split('?')[0]!)
  if (path !== owner && path !== 'apps/desktop/src/renderer/src/store.ts') return
  let output = input
  if (mutation && path === owner) {
    const anchor = ': context.execution.sessionId'
    if (input.split(anchor).length !== 2) throw Error('Original Focus mutation must load one exact branch')
    output = input.replace(anchor, ': null')
  }
  if (process.env.AGENTMUX_FOCUS_RETENTION_LOADED) {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = JSON.stringify({ path, originalSHA256: sha(input), loadedSHA256: sha(output), ...(input !== output ? { mutation } : {}) }) + '\n'
    output = "import {appendFileSync as __focusOwnerLoaded} from 'node:fs';\n__focusOwnerLoaded(" + JSON.stringify(process.env.AGENTMUX_FOCUS_RETENTION_LOADED) + ', ' + JSON.stringify(row) + ');\n' + output
  }
  if (output !== input) return { code: output, map: null }
} }], test: { ...source.test, include: ['apps/desktop/test/focus-cold-start-retention.test.ts'], passWithNoTests: false } })
