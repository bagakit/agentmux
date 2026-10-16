import { readFileSync } from 'node:fs'
import { exactReplace, verifyWorkfaceMutations } from './lib/workface-mutation-proof.mjs'

const owner = 'apps/desktop/src/renderer/src/lib/workspace-agent-order.ts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const read = path => readFileSync(path, 'utf8')
verifyWorkfaceMutations({ operation: 'workspace-agent-order', testPath: 'apps/desktop/test/workspace-agent-order-control.test.tsx',
  sourcePaths: [owner, store, 'packages/core/src/space-control.ts', 'packages/core/src/space-control-parser.ts',
    'packages/core/src/public-rpc.ts', 'packages/core/src/rpc-business-codec.ts', 'packages/core/src/agentmux-cli-commands.ts'],
  callers: [{ symbol: 'executeWorkspaceAgentOrder', definition: owner }, { symbol: 'orderedWorkspaceAgents', definition: owner }],
  variants: [
    { name: 'creation-order-reversed', changes: { [owner]: exactReplace(read(owner), 'return a.createdAt - b.createdAt ||', 'return b.createdAt - a.createdAt ||') } },
    { name: 'original-preference-owner-withdrawn', changes: { [owner]: exactReplace(read(owner), '  ports.set(displayWorkspaceId, next)', '  void next') } },
    { name: 'public-owner-routing-withdrawn', changes: { [store]: exactReplace(read(store),
      "    }, request) }\n    if (request.operation === 'agent.view')", "    }, { ...request, order: undefined }) }\n    if (request.operation === 'agent.view')") } },
    { name: 'durable-preference-whitelist-withdrawn', changes: { [store]: exactReplace(read(store), '    workspaceAgentOrder: state.workspaceAgentOrder,', '') } },
    { name: 'optimistic-order-conflict-withdrawn', changes: { [owner]: exactReplace(read(owner),
      'if (request.expectedOrder && JSON.stringify(request.expectedOrder.map(memberKey)) !== JSON.stringify(before))', 'if (false)') } },
    { name: 'absent-original-preference-withdrawn', changes: { [owner]: exactReplace(read(owner),
      '...before.filter(key => !available.has(key) && !requested.includes(key))', '...[]') } }
  ] })
