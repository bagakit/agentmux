import { provePerformanceOwner } from './performance-owner-proof.mjs'
import { benchmarkHostedCarrier } from './hosted-carrier-benchmark.mjs'
const proof = provePerformanceOwner({ name: 'hosted-carrier', owners: ['packages/core/src/hosted-value.ts','packages/core/src/performance-diagnostics.ts'],
  tests: ['packages/core/test/hosted-carrier-cost.test.ts','packages/core/test/hosted-value-roundtrip.test.ts'], minimumTests: 5,
  mutantTests: ['packages/core/test/hosted-carrier-cost.test.ts'], mutants: [
    ['offset-lost','packages/core/src/hosted-value.ts','bytes.buffer, bytes.byteOffset, bytes.byteLength','bytes.buffer, 0, bytes.byteLength'],
    ['buffer-leaks','packages/core/src/hosted-value.ts',"return new Uint8Array(Buffer.from(data, 'base64'))","return Buffer.from(data, 'base64')"],
    ['early-budget-removed','packages/core/src/hosted-value.ts','if (budget.minimumBytes > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES)','if (false)'],
    ['final-utf8-budget-removed','packages/core/src/hosted-value.ts','if (bytes.length > AGENTMUX_HOSTED_TRANSFER_MAX_BYTES)','if (false)'],
    ['frame-preallocation-budget-removed','packages/core/src/hosted-value.ts','p.dataBase64.length > 4 * Math.ceil(AGENTMUX_HOSTED_TRANSFER_CHUNK_BYTES / 3)','false'],
    ['sequence-removed','packages/core/src/hosted-value.ts','chunk.index !== this.index++','false'],
    ['value-cost-removed','packages/core/src/hosted-value.ts','hostedCarrierPerformance.value(performance.now() - valueStart)','void valueStart']
  ], callers: [['packages/core/src/hosted-runtime-service.ts','hostedTransfer({ kind:'],['packages/core/src/hosted-client.ts','new AgentMuxHostedTransferReader()'],['packages/core/src/client.ts','hostedCarrierPerformance.snapshot()']] })
const benchmark = benchmarkHostedCarrier(proof.receipt.root, proof.directory)
process.stdout.write(JSON.stringify({ benchmarkPassed: benchmark.passed, receipt: proof.directory + '/benchmark.json' })+'\n')
