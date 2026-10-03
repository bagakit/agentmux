import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../../../..')
const loadedSource = { name: 'mote-cooperation-loaded-source', transform(_source: string, id: string) {
  if (!process.env.AGENTMUX_COOPERATION_SOURCE_RECEIPT) return
  const path = relative(repository, id.split('?')[0]!)
  if (!path.startsWith('../') && /^(apps\/desktop\/(src|test)|packages\/)/.test(path) && !path.includes('/node_modules/'))
    appendFileSync(process.env.AGENTMUX_COOPERATION_SOURCE_RECEIPT, JSON.stringify({ path,
      sha256: createHash('sha256').update(readFileSync(id.split('?')[0]!)).digest('hex') }) + '\n')
} }

export default defineConfig({ ...owning, plugins: [...(owning.plugins ?? []), loadedSource], test: { ...owning.test,
  include: ['test/mote-daily-cooperation.test.tsx'], passWithNoTests: false } })
