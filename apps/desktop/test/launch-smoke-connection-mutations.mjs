import { createHash } from 'node:crypto'
export const launchSmokeMutations = {
  'first-observation-fatal': { before: "console.warn('Launch smoke is waiting for the original Host connection; its current observation failed.', error)",
    after: "reject(error)", target: 'launch smoke waits for the original Hosted background reconnect without replacing metadata or Native' },
  'restored-without-bootstrap': { before: "if (event.state === 'restored') confirm()", after: "if (event.state === 'restored') resolve()",
    target: 'launch smoke requires complete bootstrap after restored and owner-only observations' },
  'native-failure-as-consumer': { before: "event.observationOrigin.boundary === 'consumer-core') reject(new AgentMuxError(",
    after: "true) reject(new AgentMuxError(", target: 'launch smoke retains its consumer when only Native is unrecoverable' }
}
export const launchSmokeOwners = ['apps/desktop/src/main/desktop-host.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/public-rpc-client.ts']
export function instrumentLaunchSmoke(source, path) {
  if (!launchSmokeOwners.includes(path)) return source
  const original = source, mutant = process.env.LAUNCH_SMOKE_MUTANT
  if (mutant && !Object.hasOwn(launchSmokeMutations, mutant)) throw Error('Unknown launch smoke connection mutation')
  if (mutant && path === launchSmokeOwners[0]) {
    const mutation = launchSmokeMutations[mutant]
    if (source.split(mutation.before).length !== 2) throw Error('Launch smoke mutation must select one exact owning expression')
    source = source.replace(mutation.before, mutation.after)
  }
  if (process.env.LAUNCH_SMOKE_LOADED) {
    const sha = value => createHash('sha256').update(value).digest('hex')
    const row = { path, surface: 'evaluated-source', originalSHA256: sha(original), loadedSHA256: sha(source), ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __launchSmokeEvaluated } from 'node:fs'; __launchSmokeEvaluated(" + JSON.stringify(process.env.LAUNCH_SMOKE_LOADED) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + source
  }
  return source
}
