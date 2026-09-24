import { runDispatchProof } from '../test/fixtures/dispatch-private-runtime.mjs'

// Root-reviewed private side effects only. The fixture starts and records its own Runtime,
// Agents and CLI PIDs; every consumer and journal is under a fresh private task directory.
const proof = await runDispatchProof('restart')
process.stdout.write(`${JSON.stringify(proof)}\n`)
