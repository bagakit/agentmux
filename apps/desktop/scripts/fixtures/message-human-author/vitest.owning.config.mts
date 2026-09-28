import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../../../vitest.config'

const repoRoot = resolve(import.meta.dirname, '../../../../..')
const mutation = process.env.T041_TEST_MUTATION
const variants = {
  'submit-unknown': { file: 'renderer/src/components/AgentSessionComposer.tsx',
    from: "send(sessionId, value, feedback.report, 'manual')", to: 'send(sessionId, value, feedback.report)' },
  'queue-unknown': { file: 'renderer/src/components/AgentSessionComposer.tsx',
    from: "enqueueAgentSteer(sessionId, value, feedback.report, undefined, 'manual')",
    to: 'enqueueAgentSteer(sessionId, value, feedback.report)' },
  'sender-trust-skipped': { file: 'main/ipc.ts',
    from: 'assertManualPromptSenderTrusted(event.sender, args.window.webContents)', to: 'void event.sender' },
  'human-speaker-unknown': { file: 'renderer/src/lib/conversation-speaker.ts',
    from: "if (message.author.kind === 'human') {\n    return { role: 'human', id: HUMAN_SPEAKER_ID }",
    to: "if (message.author.kind === 'human') {\n    return { role: 'unknown', id: UNKNOWN_SPEAKER_ID }" },
  'pause-before-trust': { file: 'main/ipc.ts',
    from: "    let effectiveAuthorHuman = false\n    if (authorHuman === true)",
    to: "    pauseUserProgress(session, 'Mutated premature pause.')\n    let effectiveAuthorHuman = false\n    if (authorHuman === true)" }
} as const
if (mutation && !(mutation in variants)) throw new Error(`Unknown T041 mutation: ${mutation}`)
const selected = mutation ? variants[mutation as keyof typeof variants] : undefined

export default defineConfig({
  ...original,
  root: repoRoot,
  cacheDir: resolve(repoRoot, '.tmp/message-human-author-cache/owning'),
  plugins: selected ? [{
    name: 't041-loaded-desktop-mutation',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== resolve(repoRoot, 'apps/desktop/src', selected.file)) return
      if (code.split(selected.from).length !== 2) throw new Error(`T041 mutation anchor must occur once: ${id}`)
      process.stdout.write(`T041_LOADED_MUTATION ${mutation} ${id}\n`)
      return code.replace(selected.from, selected.to)
    }
  }] : [],
  test: {
    ...original.test,
    globalSetup: [],
    include: ['apps/desktop/test/message-human-author.integration.test.tsx'],
    passWithNoTests: false,
    fileParallelism: false,
    maxWorkers: 1
  }
})
