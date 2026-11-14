import owning from '../note-restore/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
export default defineConfig({ ...owning, plugins: [{ name: 'original-composition-source', enforce: 'pre', transform(source, id) {
  const file = relative(process.cwd(), id.split('?')[0]!)
  const mutant = process.env.SURVEY_COMPOSITION_MUTANT ? JSON.parse(process.env.SURVEY_COMPOSITION_MUTANT) : null
  let code = source
  if (process.env.SURVEY_COMPOSITION_COST && file.endsWith('/WorkbenchRegionOwners.tsx')) {
    code = code.replace('entries.current.set(regionId, entry);', '(((globalThis as any).__regionCost ??= { copies: 0, visited: 0 }).registrations ??= []).push(regionId); entries.current.set(regionId, entry);')
      .replace('entry.content = content;', '(((globalThis as any).__regionCost ??= { copies: 0, visited: 0 }).updates ??= []).push(regionId); entry.content = content;')
    code = code.replaceAll('new Map(current)', 'new Map(((globalThis as any).__regionCost ??= { copies: 0, visited: 0 }, (globalThis as any).__regionCost.copies++, (globalThis as any).__regionCost.visited += current.size, current))')
  }
  if (mutant?.file === file) {
    if (source.split(mutant.before).length !== 2) throw new Error('A composition mutation requires one exact owner anchor')
    code = source.replace(mutant.before, mutant.after)
  }
  if (process.env.SURVEY_COMPOSITION_LOADED && /^(apps\/desktop\/src|packages\/core\/src)\//.test(file))
    appendFileSync(process.env.SURVEY_COMPOSITION_LOADED, JSON.stringify({ file, original: createHash('sha256').update(source).digest('hex'), loaded: createHash('sha256').update(code).digest('hex') }) + '\n')
  return code === source ? null : { code, map: null }
} }, ...(owning.plugins ?? [])], test: { ...owning.test, setupFiles: [...(owning.test!.setupFiles as string[]), fileURLToPath(new URL('./native-listener.setup.ts', import.meta.url))], include: ['apps/desktop/test/survey-tab-composition.test.tsx', 'apps/desktop/test/survey-composition-mote-context.test.tsx'], hookTimeout: 30_000, testTimeout: 30_000 } })
