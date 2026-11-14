import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const sha = value => createHash('sha256').update(value).digest('hex')
const owner = 'scripts/package-dependencies.mjs', app = 'apps/desktop/scripts/runtime-application-payload.mjs'
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (!url.startsWith('file:')) return result
  const path = relative(process.env.AGENTMUX_CLOSURE_REPOSITORY, fileURLToPath(url))
  if (![owner, app].includes(path)) return result
  const original = Buffer.from(result.source).toString(), mutation = process.env.AGENTMUX_CLOSURE_MUTATION
  let source = original
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw Error('Mutation does not bind one original owner block: ' + mutation)
    source = source.replace(before, after)
  }
  if (path === owner) {
    if (mutation === 'omit-optionals') replace('...Object.keys(optional), ', '')
    if (mutation === 'omit-peers') replace(', ...Object.keys(peers)', '')
    if (mutation === 'omit-required') replace('...Object.keys(required), ', '')
    if (mutation === 'flatten-peer-context') replace('resolvePackageRoot(sourceDirectory, name)',
      'resolvePackageRoot(Object.hasOwn(peers, name) ? process.env.AGENTMUX_CLOSURE_PUBLICATION_ROOT : sourceDirectory, name)')
    if (mutation === 'portable-skips-dependencies') replace('if (target !== destination) for (const file', 'if (false) for (const file')
    if (mutation === 'no-back-edge') {
      replace('if (lookup(destination, dependency.name) === dependency.packageId) continue',
        'if (lookup(destination, dependency.name) === dependency.packageId && !original.includes(dependency.packageId)) continue')
    }
    if (mutation === 'allow-unrepresentable-peer') {
      replace('if (original.includes(dependency.packageId))', 'if (false)')
      replace('if (instances.length > 1)', 'if (false)')
    }
    if (mutation === 'unplanned-slots') replace('children.push({ id: dependency.packageId, destination: child })',
      'children.push({ id: dependency.packageId, destination: child }); plan(dependency.packageId, child, original)')
  }
  if (path === app && mutation === 'isolated-roots') replace('await copyDependencies(roots)',
    'for (const root of roots) await copyDependencies([root])')
  if (path === app && mutation === 'merge-distribution-scopes') replace('await copyDependencies(coreRoots, {', 'roots.push(...coreRoots); void ({')
  if (path === app && mutation === 'omit-portable-target') replace("additionalTarget: { os: 'linux', cpu: 'x64' }, ", '')
  const binding = { path, originalSHA256: sha(original), transformedSHA256: sha(source) }
  const instrumented = `import{appendFileSync as __closureEvidence}from'node:fs';\n__closureEvidence(process.env.AGENTMUX_CLOSURE_LOADED,${JSON.stringify(JSON.stringify({ stage: 'evaluated', ...binding }) + '\n')});\n` + source
  appendFileSync(process.env.AGENTMUX_CLOSURE_LOADED, JSON.stringify({ stage: 'returned', ...binding, evaluatedCodeSHA256: sha(instrumented) }) + '\n')
  return { ...result, source: instrumented }
}
