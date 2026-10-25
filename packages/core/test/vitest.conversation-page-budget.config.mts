import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from './vitest.conversation-resilience.config.mts'

const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, cacheDir: '.cache/conversation-page-budget', plugins: [...original.plugins ?? [], {
  name: 'original-reader-page-budget-work', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (path !== 'packages/core/src/conversation-reader.ts') return
    let code = source
    const mutation = process.env.AGENTMUX_PAGE_BUDGET_MUTATION
    if (mutation) {
      if (mutation !== 'repeat-prefix') throw Error('Unknown page budget mutation')
      const target = 'Buffer.byteLength(JSON.stringify(result(index, offset, []))) + itemsBytes + entryBytes(entry)'
      if (code.split(target).length !== 2) throw Error('Missing unique actual page budget owner')
      code = code.replace(target, 'Buffer.byteLength(JSON.stringify(result(index, offset, [...items, entry])))')
    }
    const trial = 'JSON.stringify(result(index, offset,', final = 'JSON.stringify(page)'
    if (code.split(trial).length !== 2 || code.split(final).length !== 2) throw Error('Missing unique original Reader budget checks')
    code = code.replace(trial, 'observedBudgetStringify(false, result(index, offset,').replace(final, 'observedBudgetStringify(true, page)')
    code = `function observedBudgetStringify(final: boolean, value: any) {
      const probe = Reflect.get(globalThis, '__amuxPageBudgetCost')
      if (probe) {
        if (final) { probe.finalEntries += value.items.length; probe.finalChecks++ }
        else { probe.trialEntries += value.items.length; probe.trials++ }
      }
      return JSON.stringify(value)
    }\n` + code
    if (process.env.AGENTMUX_PAGE_BUDGET_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_PAGE_BUDGET_LOADED, JSON.stringify({ path,
        originalSHA256: hash(source), loadedSHA256: hash(code), mutation: mutation ?? null }) + '\n')
    }
    return { code, map: null }
  }
}], test: { ...original.test, include: ['packages/core/test/conversation-page-budget.test.ts'], passWithNoTests: false, fileParallelism: false } })
