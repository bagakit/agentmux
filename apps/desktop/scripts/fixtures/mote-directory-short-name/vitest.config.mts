import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import owning from '../mote-directory-identity/vitest.config.mts'
const repository=resolve(import.meta.dirname,'../../../../..')
export default defineConfig({ ...owning, plugins:[...(owning.plugins??[]),{name:'short-mote-loaded-renderer',transform(_code,id){const proof=process.env.AGENTMUX_DIRECTORY_IDENTITY_PROOF,file=relative(repository,id.split('?')[0]!);if(proof&&file.startsWith('apps/desktop/src/renderer/'))appendFileSync(proof,JSON.stringify({consumer:'actual-vite-module',file,sha256:createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex')})+'\n')}}], test: { ...owning.test, include: [
  'test/mote-directory-short-name.test.ts', 'test/mote-directory-short-birth.test.tsx',
  'test/mote-directory-identity.test.ts', 'test/scratch-topic-directories.test.ts',
  'test/rpc-client-observations.test.ts', 'test/mote-avatar-assets.test.ts',
  'test/mote-archive-service.test.ts', 'test/mote-primary-directory.test.ts'
], passWithNoTests: false, maxWorkers: 1 } })
