import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import original from '../../../packages/connectors/test/vitest.mote-host.config.mts'
const variants = {
  'continuity-disconnect': ['apps/host/src/mote-chat-agents.ts', 'const result = await client.ensureAgentContinuity', "const result = await (async (_input: unknown) => ({ kind: 'reattachable' as const, session }))"],
  'original-executor-disconnect': ['apps/host/src/mote-resources.ts', 'const value = (executors as Record<string, unknown>)[executorId]', 'const value = undefined'],
  'wiki-disconnect': ['apps/host/src/mote-chat.ts', 'AGENTMUX_WIKI_DIR: workspacePath', "AGENTMUX_WIKI_DIR: '/wrong-Mote-home'"],
  'guide-substitution': ['apps/host/src/mote-chat.ts', 'injectAgentMuxGuide: config.injectAgentMuxGuide', 'injectAgentMuxGuide: true'],
  'frozen-dispatch-disconnect': ['apps/host/src/mote-chat.ts', '.client.createAgentWithDelivery(prepared.input)', '.client.createAgentWithDelivery({ ...prepared.input, injectAgentMuxGuide: !prepared.input.injectAgentMuxGuide })']
} as const
const mutation = process.env.MOTE_DEFAULT_MUTANT as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown default Mote owning mutation')
export default defineConfig({ ...original, plugins: [{ name: 'actual-default-mote-join', enforce: 'pre', transform(source, id) {
  const path = relative(original.root!, id.split('?')[0]!)
  if (!path.startsWith('apps/host/src/') && path !== 'packages/core/src/headless-runtime.ts') return
  const selected = mutation && variants[mutation]
  let loaded = source
  if (selected && selected[0] === path) {
    if (source.split(selected[1]).length !== 2) throw Error('The exact default Mote owning expression must load once')
    loaded = source.replace(selected[1], selected[2])
  }
  if (process.env.MOTE_DEFAULT_LOADED) {
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    appendFileSync(process.env.MOTE_DEFAULT_LOADED, JSON.stringify({ path, originalSHA256: hash(source), loadedSHA256: hash(loaded), ...(source !== loaded ? { mutation } : {}) }) + '\n')
  }
  if (source !== loaded) return loaded
} }, ...original.plugins!], test: { ...original.test, include: ['apps/host/test/mote-default-join-consumer.test.ts', 'apps/host/test/mote-chat-recovery.test.ts'], testTimeout: 25_000 } })
