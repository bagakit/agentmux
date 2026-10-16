import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { mailboxMutations } from './mutations.mjs'
import type { Reporter } from 'vitest/reporters'
import type { Task } from '@vitest/runner'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sourceConfig from '../settings-overview/vitest.config.mts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const clientUiExports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
const clientUiAliases = Object.entries(clientUiExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser: string }).browser
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
  const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
  return { find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages/client-ui', target).replace('*', '$1') }
})
const mutation = process.env.AGENTMUX_TEST_MAILBOX_MUTATION
const selectedMutation = mutation ? mailboxMutations.find(item => item.label === mutation) : undefined
assert.ok(!mutation || selectedMutation, 'The requested message reading mutation exists')
const applied = new Map<string, unknown>()
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const requested = process.argv.filter(argument => /^(apps\/desktop\/test|packages\/client-ui\/test)\/.+\.test\.tsx$/.test(argument))
function countTests(task: Task): number { return task.type === 'test' ? task.result?.state === 'pass' || task.result?.state === 'fail' ? 1 : 0 : task.tasks.reduce((sum, child) => sum + countTests(child), 0) }
const discovery: Reporter = { onFinished(files = []) {
  const discovered = files.map(file => ({ path: relative(root, file.filepath), tests: countTests(file) }))
  const receipt = { requested, discovered, mutation: mutation ?? null, applied: [...applied.values()], passed: discovered.every(file => file.tests > 0) &&
    JSON.stringify(discovered.map(file => file.path).sort()) === JSON.stringify([...requested].sort()) }
  const directory = process.env.AGENTMUX_TEST_MAILBOX_ARTIFACT ?? resolve(root, '.tmp/mailbox-reading-flow/mounted')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'discovery.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (mutation) assert.equal(applied.size, 1, 'The actual imported product module was mutated exactly once')
  assert.ok(requested.length > 0, 'Requested owning suites are nonempty')
  assert.deepEqual(discovered.map(file => file.path).sort(), [...requested].sort(), 'Every requested owning suite is actually discovered')
  for (const file of discovered) assert.ok(file.tests > 0, 'Every discovered suite executes nonempty tests: ' + file.path)
} }
export default defineConfig({ ...sourceConfig, cacheDir: resolve(root, '.tmp/mailbox-reading-flow/vite-cache', mutation ?? 'candidate'),
  plugins: [...(sourceConfig.plugins ?? []), ...(selectedMutation ? [{
    name: 'a2a-mailbox-private-behavior-mutation', enforce: 'pre' as const,
    transform(code: string, id: string) {
      const path = resolve(root, selectedMutation.file)
      if (id.split('?')[0] !== path) return
      assert.equal(code.split(selectedMutation.before).length, 2, 'A unique actual product anchor: ' + mutation)
      const changed = code.replace(selectedMutation.before, selectedMutation.after)
      applied.set(path, { file: selectedMutation.file, sourceSha256: hash(readFileSync(path)), inputSha256: hash(code), changedInputSha256: hash(changed) })
      return changed
    }
  }] : [])], resolve: { ...sourceConfig.resolve, alias: [
  ...clientUiAliases,
  ...sourceConfig.resolve!.alias
] }, test: { ...sourceConfig.test, reporters: ['default', 'json', discovery], outputFile: { json: resolve(root, '.tmp/mailbox-reading-flow/mounted/results.json') }, environmentMatchGlobs: [['packages/client-ui/test/**', 'happy-dom']], include: [
  'apps/desktop/test/mailbox-a2a.test.tsx', 'apps/desktop/test/session-mailbox-a2a.test.tsx', 'apps/desktop/test/session-messages-read.test.tsx',
  'apps/desktop/test/session-mailbox.test.tsx', 'apps/desktop/test/session-mailbox-receipts.test.tsx',
  'apps/desktop/test/session-mailbox-native-messages.integration.test.tsx',
  'apps/desktop/test/provider-user-message-mailbox-spine.integration.test.tsx',
  'apps/desktop/test/session-mailbox-reading-flow.test.tsx',
  'apps/desktop/test/agent-steer-queue-deliverability.test.tsx', 'apps/desktop/test/prompt-uncertain-turn-continuation.test.tsx',
  'apps/desktop/test/provider-ingress-consumers.test.tsx',
  'apps/desktop/test/conversation-message.test.tsx', 'apps/desktop/test/conversation-message-copy.test.tsx',
  'apps/desktop/test/conversation-message-actions.test.tsx', 'apps/desktop/test/conversation-message-wrapper.integration.test.tsx',
  'packages/client-ui/test/shared-conversation.test.tsx'
] } })
