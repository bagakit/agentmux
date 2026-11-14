import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({ ...base, cacheDir: '.tmp/workbench-user-ipc-cache', plugins: [...base.plugins ?? [], {
  name: 'native-user-ipc-source-proof', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!), output = process.env.AGENTMUX_RELIABILITY_LOADED
    if (output && ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/workbench-user-state.ts', 'apps/desktop/src/preload/index.ts'].includes(path))
      appendFileSync(output, JSON.stringify({ path, absolutePath: id.split('?')[0], diskSHA256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex'), sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
  }
}], test: {
  ...base.test, include: ['apps/desktop/test/first-execution-ipc.test.ts'], passWithNoTests: false,
  testNamePattern: /actual native save bridge|a readable native document|registered native storage handlers|private save revisions/
} })
