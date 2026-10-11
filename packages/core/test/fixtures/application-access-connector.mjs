// Real isolated command connector for protocol integration. No external account is contacted.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
const path = process.argv[2], r = JSON.parse(readFileSync(0,'utf8')), state = JSON.parse(readFileSync(path,'utf8'))
const persist = () => { writeFileSync(path+'.next',JSON.stringify(state),{mode:0o600}); renameSync(path+'.next',path) }
state.calls ??= []; state.calls.push(r.action); persist()
const result = body => process.stdout.write(JSON.stringify({schema:'agentmux.application-access.v1',action:r.action,applicationId:state.applicationId,...body}))
const observation = () => ({status:state.accountId ? 'ready' : 'login-required',accountId:state.accountId,scopes:state.scopes,revision:String(state.revision),transferable:state.mode !== 'native-login'})
if (r.schema !== 'agentmux.application-access.v1' || r.applicationId !== state.applicationId) process.exit(2)
if (r.action === 'inspect') result(observation())
else if (r.action === 'verify') result({...observation(),...(state.mode==='wrong-verify' ? {accountId:'another-application-account'} : {}),...(state.mode==='missing-scope' ? {scopes:[]} : {})})
else if (r.action === 'export') {
  if (state.mode==='export-failure') { process.stderr.write('PRIVATE-MATERIAL-SENTINEL'); process.exit(3) }
  if (r.expectedRevision !== String(state.revision) || r.accountId !== state.accountId || !r.scopes.every(scope=>state.scopes.includes(scope))) process.exit(4)
  result({accountId:state.accountId,scopes:r.scopes,revision:String(state.revision),materialBase64:Buffer.from(JSON.stringify({accountId:state.accountId,scopes:r.scopes,token:state.token})).toString('base64')})
} else if (r.action === 'import') {
  state.importAttempts=(state.importAttempts??0)+1; persist()
  const reject = () => result({operationId:r.operationId,intentDigest:r.intentDigest,status:'rejected'})
  if (state.mode==='native-login' || r.expectedRevision !== String(state.revision) || state.accountId && state.accountId !== r.accountId) reject()
  else {
    const material=JSON.parse(Buffer.from(r.materialBase64,'base64').toString())
    if (material.accountId !== r.accountId || JSON.stringify(material.scopes)!==JSON.stringify(r.scopes)) process.exit(5)
    state.accountId=material.accountId; state.scopes=material.scopes; state.token=material.token; state.revision++
    state.operations ??= {}; state.operations[r.operationId]={intentDigest:r.intentDigest,status:'imported'}; persist()
    if (state.mode==='lose-import') { process.stderr.write('PRIVATE-MATERIAL-SENTINEL'); process.stdout.write('not a receipt'); process.exit(6) }
    result({operationId:r.operationId,intentDigest:r.intentDigest,status:'imported'})
  }
} else if (r.action === 'operation') {
  const op=state.operations?.[r.operationId]
  result({operationId:r.operationId,intentDigest:r.intentDigest,status:op?.intentDigest===r.intentDigest ? op.status : 'unknown'})
} else process.exit(7)
