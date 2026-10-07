import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vitest/config'
import { aliases, installedDependency, root } from '../settings-resource-library/environment.mjs'

const mutant = process.env.AMUX_LAUNCH_MUTANT
const edits: Record<string, [string, string, string]> = {
  guidance: ['AgentExecutorPicker.tsx', 'Configured executables are unavailable on this host. Check their configuration and unavailable details, then refresh.', 'Configured Agent commands were not found on this host. Recheck after installation.'],
  preview: ['ExecutorLaunchPreview.tsx', '[command.trim(), ...argv]', '[command.trim()]'],
  adjacent: ['AgentSettingsPane.tsx', '<ComposerTextarea aria-label="Executor arguments"', '<ComposerTextarea hidden aria-label="Executor arguments"'],
  literal: ['ExecutorLaunchPreview.tsx', '[command.trim(), ...argv]', '[...command.trim().split(" "), ...argv]'],
  diagnostic: ['executable-diagnostics.ts', 'Configured executable ${JSON.stringify(command)} was not found on this host.', '${JSON.stringify(command)} is not installed on this host.'],
  label: ['executor-detection.ts', ": 'Not found'", ": 'Not installed'"]
}
const files = mutant ? mutant === 'guidance' ? ['apps/desktop/test/agent-executor-picker.test.tsx'] : mutant === 'diagnostic' ? ['packages/core/test/client-executor-availability.test.ts', 'packages/core/test/executor-diagnostics-public.test.ts'] : ['apps/desktop/test/executor-launch.test.tsx'] : [
  'apps/desktop/test/executor-launch.test.tsx', 'apps/desktop/test/agent-executor-picker.test.tsx', 'apps/desktop/test/remote-executor-consumer.test.ts',
  'packages/core/test/client-executor-availability.test.ts', 'packages/core/test/executor-owner.test.ts',
  'packages/core/test/executor-diagnostics-public.test.ts'
]
export default defineConfig({
  root, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, resolve: { alias: aliases },
  plugins: [{ name: 'source-executor-launch', enforce: 'pre', resolveId: installedDependency,
    transform(code, id) {
      const path = relative(root, id)
      if (process.env.AMUX_LAUNCH_SOURCE_LOG && !path.startsWith('..') && !id.includes('/node_modules/') && !id.includes('?')) {
        try { appendFileSync(process.env.AMUX_LAUNCH_SOURCE_LOG, JSON.stringify({ path, sha256: createHash('sha256').update(readFileSync(id)).digest('hex') }) + '\n') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      if (!mutant || !id.endsWith('/' + edits[mutant]![0])) return
      const [, before, after] = edits[mutant]!
      assert.equal(code.split(before).length, 2, 'One consumed production mutation')
      appendFileSync(process.env.AMUX_LAUNCH_MUTATION_LOG!, JSON.stringify({ mutant, id }) + '\n')
      return code.replace(before, after)
    } }],
  test: { include: files, setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, passWithNoTests: false, testTimeout: 15000 }
})
