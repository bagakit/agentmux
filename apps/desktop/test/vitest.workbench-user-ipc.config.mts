import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_USER_IPC_MUTATION
const store = 'apps/desktop/src/main/workbench-user-state.ts'
const ipc = 'apps/desktop/src/main/ipc.ts'
const validation = 'document = decodeWorkbenchUserState(request.value)'
const edits: Record<string, { path: string; before: string; after: string }> = {
  'repeat-request-decode': { path: store, before: validation, after: validation + '\n      decodeWorkbenchUserState(request.value)' },
  'disconnect-archive': { path: ipc, before: 'workbenchUserState.readInputArchive(parseWorkbenchInputArchiveQuery(query))',
    after: '({ entries: [], nextCursor: null })' },
}
if (mutation && !Object.hasOwn(edits, mutation)) throw Error('Unknown native save mutation')

export default defineConfig({ ...base, cacheDir: '.tmp/workbench-user-ipc-cache', plugins: [...base.plugins ?? [], {
  name: 'native-user-ipc-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), output = process.env.AGENTMUX_RELIABILITY_LOADED
    let code = source
    const edit = mutation ? edits[mutation] : undefined
    if (edit && path === edit.path) {
      if (source.split(edit.before).length !== 2) throw Error('Missing native save mutation anchor')
      code = source.replace(edit.before, edit.after)
    }
    if (output && [ipc, store, 'apps/desktop/src/preload/index.ts'].includes(path))
      appendFileSync(output, JSON.stringify({ path, absolutePath: id.split('?')[0], diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: {
  ...base.test, include: ['apps/desktop/test/first-execution-ipc.test.ts'], passWithNoTests: false,
  testNamePattern: /actual native save bridge|a readable native document|registered native storage handlers|private save revisions|registered Main source export/
} })
