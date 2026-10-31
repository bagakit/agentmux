import { verifyTopicsLayoutRestart } from './verify-topics-layout-restart.mjs'
await verifyTopicsLayoutRestart({ scope: true, evidencePath: process.argv[2] })
