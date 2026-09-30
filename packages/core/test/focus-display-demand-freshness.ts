import { resolve } from 'node:path'
import { staleDistComplaint } from '../../../vitest.dist-freshness.js'

// This fixture imports the public Core source entry, not Core dist. Its actual
// compiled dependency is Demand; keep the original freshness check on that package.
export default async function setup(): Promise<void> {
  const complaint = await staleDistComplaint(resolve(import.meta.dirname, '../../demand'), 'dist/src/index.js')
  if (complaint) throw new Error(complaint)
}
