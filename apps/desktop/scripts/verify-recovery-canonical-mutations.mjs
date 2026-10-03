import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const root=resolve(import.meta.dirname, '../../..')
const store='apps/desktop/src/renderer/src/store.ts', pane='apps/desktop/src/renderer/src/components/SessionPane.tsx'
const tests=['apps/desktop/test/session-restore-owner-warning.test.tsx']
const sources=[store,pane,'apps/desktop/src/renderer/src/lib/idle-agent-restore-policy.ts',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx','apps/desktop/test/helpers/client-ui-render.tsx']
const mutations=[
  {label:'resync-projection-cleanup-gate',file:store,
    before:"runState: 'missing',\n              ...(candidate.semanticStatus ? { semanticStatus: candidate.semanticStatus } : {}),\n              canonical: !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId),",
    after:"runState: 'missing',\n              ...(candidate.semanticStatus ? { semanticStatus: candidate.semanticStatus } : {}),\n              canonical: !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId) && !(snapshot.runtimeOwnershipWarnings ?? []).includes(candidate.hostId),"},
  {label:'resync-execution-cleanup-gate',file:store,
    before:'runState: current.processState,\n            ...(candidate.semanticStatus ? { semanticStatus: candidate.semanticStatus } : {}),\n            canonical: !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId),',
    after:'runState: current.processState,\n            ...(candidate.semanticStatus ? { semanticStatus: candidate.semanticStatus } : {}),\n            canonical: !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId) && !(snapshot.runtimeOwnershipWarnings ?? []).includes(candidate.hostId),'},
  {label:'startup-cleanup-gate',file:store,
    before:'canonical: snapshotVerified && !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId),',
    after:'canonical: snapshotVerified && !runtimeSnapshotHostUnavailable(snapshot, candidate.hostId) && !(snapshot.runtimeOwnershipWarnings ?? []).includes(candidate.hostId),'},
  {label:'pane-cleanup-gate',file:pane,before:'canonical: !runtimeHostUnavailable,',
    after:'canonical: !(useAppStore.getState().runtimeOwnershipWarnings ?? []).includes(session.hostId),'}
]
const callers=[]
for(const [file,expected] of [[store,3],[pane,1]]){
 const source=await readFile(join(root,file),'utf8'), ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS), lines=[]
 function visit(node){if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='agentStartupRecoveryDecision')lines.push(ast.getLineAndCharacterOfPosition(node.getStart()).line+1);ts.forEachChild(node,visit)}
 visit(ast);assert.equal(lines.length,expected,`Actual nondefinition canonical callers: ${file}`)
 callers.push({file,symbol:'agentStartupRecoveryDecision',lines,sha256:createHash('sha256').update(source).digest('hex')})
}
const evidence=join(root,'.tmp/canonical-restore-cleanup-warning');await mkdir(evidence,{recursive:true})
await writeFile(join(evidence,'production-callers.json'),JSON.stringify({nonempty:true,callerCount:4,callers},null,2)+'\n')
await verifyRendererSourceMutations({name:'loaded-mutations',tests,sources,mutations,evidenceRoot:evidence})
