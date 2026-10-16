import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './vitest.mote-context.config.mts'

const owners = ['apps/desktop/src/renderer/src/components/FocusStopAgent.tsx', 'apps/desktop/src/renderer/src/components/SessionRestart.tsx']
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const snapshots: Record<string, string> = process.env.AGENTMUX_FOCUS_DIALOG_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_FOCUS_DIALOG_SOURCES, 'utf8')) : {}
export default defineConfig({
  ...source, cacheDir: resolve(source.root!, '.tmp/focus-dialog-cost-vitest-cache'),
  plugins: [{ name: 'actual-focus-dialog-owner-cost', enforce: 'pre', transform(original, id) {
    const path = relative(source.root!, id.split('?')[0]!)
    let code = snapshots[path] ?? original
    const effective = code, mutant = process.env.AGENTMUX_FOCUS_DIALOG_MUTANT
    if (owners.includes(path) && mutant === (path.endsWith('/FocusStopAgent.tsx') ? 'stop-eager' : 'restart-eager')) {
      const anchor = 'dialog: request !== null ? <ConfirmationDialog'
      assert.equal(code.split(anchor).length - 1, 1, 'Unique loaded request presentation gate')
      assert.equal(code.split(' /> : null').length - 1, 1, 'Unique loaded request dialog end')
      code = code.replace(anchor, 'dialog: <ConfirmationDialog').replace(' /> : null', ' />')
      process.stderr.write(`MUTATION_APPLIED=${mutant}\n`)
    }
    if (path === 'apps/desktop/src/renderer/src/components/ConfirmationDialog.tsx') {
      const anchor = '  const document = useWorkbenchDocument()'
      assert.equal(code.split(anchor).length - 1, 1, 'Actual mounted ConfirmationDialog function')
      code = code.replace(anchor, `${anchor}\n  globalThis.__focusDialogCalls?.push({ open, title, subject })`)
      code += '\nglobalThis.__focusDialogProbeLoaded = true\n'
    }
    if (process.env.AGENTMUX_FOCUS_DIALOG_LOADED && (owners.includes(path) || path.endsWith('/ConfirmationDialog.tsx'))) appendFileSync(process.env.AGENTMUX_FOCUS_DIALOG_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), effectiveSHA256: hash(effective), loadedSHA256: hash(code), mutant: mutant ?? null }) + '\n')
    if (code !== original) return { code, map: null }
  } }],
  test: { ...source.test, include: ['apps/desktop/test/focus-dialog-cost.test.tsx',
    'apps/desktop/test/focus-stop-agent.test.tsx', 'apps/desktop/test/session-restart.test.tsx'],
    setupFiles: [], globalSetup: [], maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
