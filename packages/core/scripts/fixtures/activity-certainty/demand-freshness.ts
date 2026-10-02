import { resolve } from 'node:path'
import { staleDistComplaint } from '../../../../../vitest.dist-freshness'

export default async function setup() {
  // This owning family loads public Client Source, not Core dist. Demand remains
  // a compiled production dependency, so retain its original freshness contract.
  const root = resolve(import.meta.dirname, '../../../../..')
  const complaint = await staleDistComplaint(resolve(root, 'packages/demand'), 'dist/src/index.js')
  if (complaint) throw new Error(complaint)
}
