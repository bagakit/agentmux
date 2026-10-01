import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const repoRoot = resolve(import.meta.dirname, '../../../../..')
const mutation = process.env.T041_TEST_MUTATION
const loadedSource = process.env.T041_LOADED_SOURCE
const variants = {
  'submit-unknown': { file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: "send(sessionId, value, feedback.report, 'manual')", to: 'send(sessionId, value, feedback.report)' },
  'queue-unknown': { file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: "enqueueAgentSteer(sessionId, value, feedback.report, undefined, 'manual')",
    to: 'enqueueAgentSteer(sessionId, value, feedback.report)' },
  'sender-trust-skipped': { file: 'apps/desktop/src/main/ipc.ts',
    from: 'assertManualPromptSenderTrusted(event.sender, args.window.webContents)', to: 'void event.sender' },
  'human-speaker-unknown': { file: 'packages/client-ui/src/lib/conversation-speaker.ts',
    from: "if (message.author.kind === 'human') {\n    return { role: 'human', id: HUMAN_SPEAKER_ID }",
    to: "if (message.author.kind === 'human') {\n    return { role: 'unknown', id: UNKNOWN_SPEAKER_ID }" },
  'pause-before-trust': { file: 'apps/desktop/src/main/ipc.ts',
    from: "    let effectiveAuthorHuman = false\n    if (authorHuman === true)",
    to: "    pauseUserProgress(session, 'Mutated premature pause.')\n    let effectiveAuthorHuman = false\n    if (authorHuman === true)" }
} as const
if (mutation && !(mutation in variants)) throw new Error(`Unknown T041 mutation: ${mutation}`)
const selected = mutation ? variants[mutation as keyof typeof variants] : undefined

export default defineConfig({
  resolve: { conditions: ['browser', 'import', 'default'] },
  ssr: { noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  ...original,
  root: repoRoot,
  cacheDir: resolve(repoRoot, '.tmp/message-human-author-cache/owning'),
  plugins: [{
    name: 't041-loaded-desktop-mutation',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0]!
      if (!file.startsWith(`${repoRoot}/apps/desktop/src/`) && !file.startsWith(`${repoRoot}/packages/client-ui/src/`)) return
      const original = code
      if (selected && file === resolve(repoRoot, selected.file)) {
        if (code.split(selected.from).length !== 2) throw new Error(`T041 mutation anchor must occur once: ${id}`)
        process.stdout.write(`T041_LOADED_MUTATION ${mutation} ${id}\n`)
        code = code.replace(selected.from, selected.to)
      }
      if (loadedSource) appendFileSync(loadedSource, JSON.stringify({ path: relative(repoRoot, file), originalSHA256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex'), bytes: Buffer.byteLength(code), ...(code !== original ? { mutation } : {}) }) + '\n')
      if (code !== original) return code
    }
  }],
  test: {
    ...original.test,
    server: { deps: { inline: ['@agentmux/client-ui'] } },
    globalSetup: [],
    include: ['apps/desktop/test/message-human-author.integration.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1
  }
})
