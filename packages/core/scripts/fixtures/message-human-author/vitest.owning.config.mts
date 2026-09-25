import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const mutation = process.env.T041_TEST_MUTATION
const mutations = {
  'unknown-is-human': {
    file: 'session-user-messages.js',
    from: ": { kind: 'unknown' };",
    to: ": { kind: 'human' };"
  },
  'empty-projection': {
    file: 'session-user-messages.js',
    from: 'return result;',
    to: 'return [];'
  },
  'conflict-keeps-human': {
    file: 'session-timeline.js',
    from: 'authorAgent.authorAgentSessionId === undefined && source.authorHuman === true',
    to: 'source.authorHuman === true'
  }
} as const
if (mutation && !(mutation in mutations)) throw new Error(`Unknown T041 mutation: ${mutation}`)
const selected = mutation ? mutations[mutation as keyof typeof mutations] : undefined

export default defineConfig({
  ...base,
  root,
  plugins: selected ? [{
    name: 't041-loaded-public-core-mutation',
    enforce: 'pre',
    transform(code, id) {
      if (id.split('?')[0] !== resolve(root, 'packages/core/dist', selected.file)) return
      if (code.split(selected.from).length !== 2) throw new Error(`T041 mutation anchor must occur once: ${id}`)
      process.stdout.write(`T041_LOADED_MUTATION ${mutation} ${id}\n`)
      return code.replace(selected.from, selected.to)
    }
  }] : [],
  test: {
    ...base.test,
    include: ['packages/core/test/message-human-author.integration.test.ts'],
    globalSetup: [],
    setupFiles: [],
    server: { deps: { inline: ['@agentmux/core'] } },
    passWithNoTests: false,
    maxWorkers: 1,
    fileParallelism: false
  }
})
