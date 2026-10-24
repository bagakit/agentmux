import { createHash } from 'node:crypto'
export const diagnosticsMutations = {
  'diagnostic-owner': ['packages/core/src/public-rpc-service.ts', 'const result = this.ports.mobileWebReports?.report(input, context.principal.id)', 'const result = undefined'],
  'diagnostic-authority': ['apps/host/src/mobile-incidents.ts', 'if (original && target.authority.kind === original.kind && target.authority.id === original.id)', 'if (original)'],
  'diagnostic-device': ['apps/host/src/mobile-web-report-owner.ts', 'devicePrincipalId, documentId: input.documentId, buildId:', "devicePrincipalId: 'wrong-original-device', documentId: input.documentId, buildId:"]
}
const observed = new Set(['packages/core/src/public-rpc-service.ts', 'apps/host/src/host.ts', 'apps/host/src/mobile-incidents.ts', 'apps/host/src/client-incident-archive.ts', 'apps/host/src/mobile-web-report-owner.ts', 'apps/mobile/src/mobile-web/reporter.ts'])
export function instrumentDiagnosticsSource(source, path) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.HEADLESS_MOBILE_DIAGNOSTICS_MUTANT
  if (mutant && !Object.hasOwn(diagnosticsMutations, mutant)) throw Error('Unknown original diagnostics mutation')
  if (mutant && diagnosticsMutations[mutant][0] === path) {
    const [, anchor, replacement] = diagnosticsMutations[mutant]
    if (source.split(anchor).length !== 2) throw Error('Diagnostics mutation requires one evaluated original owner: ' + mutant)
    source = source.replace(anchor, replacement)
  }
  const file = process.env.HEADLESS_MOBILE_DIAGNOSTICS_LOADED
  if (file) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { path, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    source = "import { appendFileSync as __diagnosticsEvaluated } from 'node:fs'; __diagnosticsEvaluated(" + JSON.stringify(file) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
  }
  return source
}
