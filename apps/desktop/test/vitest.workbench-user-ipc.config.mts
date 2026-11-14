import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_USER_IPC_MUTATION
const store = 'apps/desktop/src/main/workbench-user-state.ts'
const validation = 'if (!confirmed || confirmed.contentDigest !== contentDigest || confirmed.sizeBytes !== sizeBytes) validate(value)'
const edits: Record<string, string> = {
  'force-revalidation': 'validate(value)',
  'trust-same-size': 'if (!confirmed || confirmed.sizeBytes !== sizeBytes) validate(value)'
}
if (mutation && !Object.hasOwn(edits, mutation)) throw Error('Unknown native save mutation')

export default defineConfig({ ...base, cacheDir: '.tmp/workbench-user-ipc-cache', plugins: [...base.plugins ?? [], {
  name: 'native-user-ipc-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), output = process.env.AGENTMUX_RELIABILITY_LOADED
    let code = source
    if (mutation && path === store) {
      if (source.split(validation).length !== 2) throw Error('Missing native save validation mutation anchor')
      code = source.replace(validation, edits[mutation]!)
    }
    if (output && ['apps/desktop/src/main/ipc.ts', store, 'apps/desktop/src/preload/index.ts'].includes(path))
      appendFileSync(output, JSON.stringify({ path, absolutePath: id.split('?')[0], diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: {
  ...base.test, include: ['apps/desktop/test/first-execution-ipc.test.ts'], passWithNoTests: false,
  testNamePattern: /actual native save bridge|a readable native document|registered native storage handlers|private save revisions/
} })
