import { runPendingEditRestart } from './pending-edit-restart-proof.mjs'

// This worker uses the existing complete private build and original product owners.
process.exit(await runPendingEditRestart(['--agent-close-chain', ...process.argv.slice(2)], 'agent-close-chain'))
