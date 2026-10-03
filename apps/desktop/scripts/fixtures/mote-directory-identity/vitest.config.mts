import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
const repository = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...owning, plugins: [{ name: 'directory-identity-loaded-source', transform(_code, id) {
  if (!process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF) return
  const file = relative(repository, id.split('?')[0]!)
  if (!/^(packages\/core\/src\/|apps\/desktop\/src\/(main|shared)\/)/.test(file)) return
  appendFileSync(process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF, JSON.stringify({ consumer: 'actual-vite-module', file, sha256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex') }) + '\n')
} }], test: { ...owning.test, include: ['test/mote-directory-identity.test.ts', 'test/scratch-topic-directories.test.ts', 'test/rpc-client-observations.test.ts', 'test/mote-avatar-assets.test.ts', 'test/mote-archive-service.test.ts', 'test/mote-primary-directory.test.ts'], passWithNoTests: false, maxWorkers: 1 } })
