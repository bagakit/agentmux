import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import base from '../vitest.config'
import { mobileAgentLocationMutations, mobileAgentLocationOwners } from './mobile-agent-locations-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), name = process.env.MOBILE_AGENT_LOCATIONS_MUTATION, trace = process.env.MOBILE_AGENT_LOCATIONS_LOADED
if (name && !Object.hasOwn(mobileAgentLocationMutations, name)) throw Error('Unknown mobile location mutation: ' + name)
const variant = name ? mobileAgentLocationMutations[name as keyof typeof mobileAgentLocationMutations] : undefined
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, cacheDir: resolve(root, '.tmp/agent-locations/vitest', name ?? 'baseline'),
  plugins: [...base.plugins!, { name: 'evaluated-mobile-agent-locations', enforce: 'pre' as const, transform(original: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!mobileAgentLocationOwners.includes(path)) return
    let code = original
    if (variant?.file === path) for (const edit of ('edits' in variant ? variant.edits : [variant])) {
      if (code.split(edit.before).length !== 2) throw Error('Mutation must match one original owner: ' + name)
      code = code.replace(edit.before, edit.after)
    }
    const receipt = { path, mutation: variant?.file === path ? name : null, originalSHA256: hash(original), loadedSHA256: hash(code) }
    if (trace) {
      appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...receipt }) + '\n')
      code += `\nimport { appendFileSync as __locationProof } from 'node:fs'; __locationProof(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...receipt }) + '\n')});\n`
    }
    return code === original ? undefined : { code, map: null }
  } }], test: { ...base.test, include: ['test/mobile-agent-locations.test.tsx'], ...(variant ? { testNamePattern: variant.target } : {}), passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
}
