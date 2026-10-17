import assert from 'node:assert/strict'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'

const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, [string, string]> = {
  webgl: ['try { releaseWebgl() } catch (error) { disposalFailure = { error } }', 'releaseWebgl()'],
  reader: ['        releasePerformance()', '        /* mutant: retained reader */'],
  counts: ['        resourceOwners.release()', '        /* mutant: retained resource owner */'],
  first: ['} catch (error) { disposalFailure ??= { error } }\n      try {\n        releasePerformance()',
    '} catch (error) { disposalFailure = { error } }\n      try {\n        releasePerformance()'],
  owner: ['releasePerformance()\n      } catch (error) { disposalFailure ??= { error } }',
    'releasePerformance()\n      } catch (error) { disposalFailure = { error } }'],
  undefined: ['if (disposalFailure) throw disposalFailure.error', 'if (disposalFailure?.error !== undefined) throw disposalFailure.error']
}

export default defineConfig({ ...base, root, plugins: [{
  name: 'terminal-effect-cleanup-mutation', enforce: 'pre',
  transform(code, id) {
    const name = process.env.AGENTMUX_TERMINAL_CLEANUP_MUTANT
    if (!name || relative(root, id.split('?')[0]!) !== 'apps/desktop/src/renderer/src/components/TerminalView.tsx') return
    const change = mutations[name]
    assert.ok(change, 'Unknown Terminal cleanup mutation')
    assert.equal(code.split(change[0]).length - 1, 1, 'Mutation must hit exactly one production anchor')
    process.stderr.write(`MUTATION_APPLIED=${name}\n`)
    return { code: code.replace(change[0], change[1]), map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/terminal-webgl-visibility.test.tsx'], passWithNoTests: false,
  testTimeout: 12_000, fileParallelism: false, maxWorkers: 1 } })
