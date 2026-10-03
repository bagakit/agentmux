import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
const repository = resolve(import.meta.dirname, '../../../../..')
const loaded = { name: 'mote-work-loaded-source', transform(_source: string, id: string) {
  if (!process.env.AGENTMUX_WORK_SOURCE_RECEIPT) return
  const file = id.split('?')[0]!, path = relative(repository, file)
  if (!path.startsWith('../') && /^(apps\/desktop\/(src|test)|packages\/)/.test(path) && !path.includes('/node_modules/'))
    appendFileSync(process.env.AGENTMUX_WORK_SOURCE_RECEIPT, JSON.stringify({ path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }) + '\n')
} }
export default defineConfig({ ...owning, plugins: [loaded], test: { ...owning.test,
  include: ['test/mote-daily-work.test.tsx'], passWithNoTests: false } })
