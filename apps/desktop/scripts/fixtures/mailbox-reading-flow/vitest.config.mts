import { defineConfig } from 'vitest/config'
import type { Reporter } from 'vitest/reporters'
import type { Task } from '@vitest/runner'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sourceConfig from '../settings-overview/vitest.config.mts'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const requested = process.argv.filter(argument => /^(apps\/desktop\/test|packages\/client-ui\/test)\/.+\.test\.tsx$/.test(argument))
function countTests(task: Task): number { return task.type === 'test' ? task.result?.state === 'pass' || task.result?.state === 'fail' ? 1 : 0 : task.tasks.reduce((sum, child) => sum + countTests(child), 0) }
const discovery: Reporter = { onFinished(files = []) {
  const discovered = files.map(file => ({ path: relative(root, file.filepath), tests: countTests(file) }))
  const receipt = { requested, discovered, passed: discovered.every(file => file.tests > 0) &&
    JSON.stringify(discovered.map(file => file.path).sort()) === JSON.stringify([...requested].sort()) }
  const directory = resolve(root, '.tmp/mailbox-reading-flow/mounted')
  mkdirSync(directory, { recursive: true })
  writeFileSync(resolve(directory, 'discovery.json'), JSON.stringify(receipt, null, 2) + '\n')
  assert.ok(requested.length > 0, 'Requested owning suites are nonempty')
  assert.deepEqual(discovered.map(file => file.path).sort(), [...requested].sort(), 'Every requested owning suite is actually discovered')
  for (const file of discovered) assert.ok(file.tests > 0, 'Every discovered suite executes nonempty tests: ' + file.path)
} }
export default defineConfig({ ...sourceConfig, cacheDir: resolve(root, '.tmp/mailbox-reading-flow/vite-cache'), resolve: { ...sourceConfig.resolve, alias: [
  { find: /^@agentmux\/client-ui\/components\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/components/$1.tsx') },
  { find: /^@agentmux\/client-ui\/platform$/, replacement: resolve(root, 'packages/client-ui/src/platform.tsx') },
  { find: /^@agentmux\/client-ui\/(.+)$/, replacement: resolve(root, 'packages/client-ui/src/lib/$1.ts') },
  { find: /^@agentmux\/client-ui$/, replacement: resolve(root, 'packages/client-ui/src/index.ts') },
  ...sourceConfig.resolve!.alias
] }, test: { ...sourceConfig.test, reporters: ['default', 'json', discovery], outputFile: { json: resolve(root, '.tmp/mailbox-reading-flow/mounted/results.json') }, environmentMatchGlobs: [['packages/client-ui/test/**', 'happy-dom']], include: [
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
