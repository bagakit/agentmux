import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

export const farmTarget = { hostId: 'dafarm-cn4-flowlens-6dad', hostname: 'cn4',
  remoteCommand: _hygiene_fixturePath("tmp/amx-flowlens-261006-6dad/bin/amux"),
  remoteSocketPath: _hygiene_fixturePath("tmp/amx-flowlens-261006-6dad/runtime/control.sock") }
export const farmRuntimeId = '9eb04a3b-e469-4137-a7ae-170885dbb715'
export const clonePath = _hygiene_fixturePath("home/zhouliqihan/proj/larkvc/flowlens-agentmux-261006-6dad")
export const originalSessionId = 'flowlens-geminicc-261006-6dad'
export const originalRunId = 'd77161ab-f946-48f9-9fce-053fccbd058c'

export async function farmPython(script) {
  return await new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', farmTarget.hostname, 'python3 -'],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    const output = [], errors = []
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.on('data', bytes => output.push(bytes)); child.stderr.on('data', bytes => errors.push(bytes))
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`Owned Farm evidence helper failed (${code}): ${Buffer.concat(errors).toString().slice(0, 1200)}`))
      else { try { resolve(JSON.parse(Buffer.concat(output).toString())) } catch (error) { reject(error) } }
    })
    child.stdin.end(script)
  })
}

const pythonInput = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`

export async function prepareFarmWorkspace(workspacePath, token) {
  assert.ok(workspacePath.startsWith(clonePath + '/.agentmux-host-ui-qa/'))
  return await farmPython(`import pathlib,json,os,hashlib
data=${pythonInput({ workspacePath, token })}
clone=pathlib.Path(${JSON.stringify(clonePath)}); owned=pathlib.Path(data['workspacePath'])
assert owned.parent == clone/'.agentmux-host-ui-qa' and not owned.exists()
assert clone.is_dir()
parentCreated=not owned.parent.exists()
owned.parent.mkdir(mode=0o700,exist_ok=True); owned.mkdir(mode=0o700)
content=data['token']+'\\n'
fd=os.open(owned/'host-ui-task.txt',os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f:f.write(content)
reference=owned/'design-and-execution-evidence-with-an-intentionally-long-reference-name-for-the-remote-workspace.txt'
fd=os.open(reference,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
with os.fdopen(fd,'w') as f:f.write('Task-owned file picker reference.\\n')
print(json.dumps({'workspacePath':str(owned),'canonicalPath':str(owned.resolve()),'taskFile':'host-ui-task.txt','taskFileSha256':hashlib.sha256(content.encode()).hexdigest(),'parentCreated':parentCreated,'created':True}))
`)
}

export async function inspectFarmOs({ workspacePath, agent, terminal, prompt, token } = {}) {
  if (workspacePath) assert.ok(workspacePath.startsWith(clonePath + '/.agentmux-host-ui-qa/'))
  if (agent) assert.notEqual(agent.sessionId, originalSessionId)
  return await farmPython(("import pathlib,json,subprocess,hashlib\ndata=" + (pythonInput({ workspacePath, agent, terminal, prompt, token })) + "\nclone=pathlib.Path(" + (JSON.stringify(clonePath)) + ("); original=pathlib.Path('" + _hygiene_fixturePath("home/zhouliqihan/proj/larkvc/flowlens") + "')\ndef process(pid):\n d=pathlib.Path('/proc')/str(pid); parts=(d/'stat').read_text().rsplit(')',1)[1].split()\n return {'pid':pid,'alive':True,'parentPid':int(parts[1]),'startTicks':parts[19],'cwd':str((d/'cwd').resolve()),'exe':str((d/'exe').resolve())}\ndef git(c,*args):return subprocess.run(['git',*args],cwd=c,check=True,capture_output=True,text=True).stdout.strip()\nowner=process(3398225); protected=process(3401036); native=process(3398260)\nassert owner['startTicks']=='260488014' and protected['startTicks']=='260504347' and native['startTicks']=='260488044'\nassert protected['cwd']==str(clone.resolve()) and protected['parentPid']==native['pid']\nrepos=[{'path':str(c),'head':git(c,'rev-parse','HEAD'),'trackedStatus':git(c,'status','--porcelain=v1','--untracked-files=no'),'status':git(c,'status','--porcelain=v1','--untracked-files=all')} for c in [original,clone]]\nassert all(r['head']=='3ef69e66b09253ab71125187f4481db18294effb' and r['trackedStatus']=='' for r in repos)\nassert repos[0]['status']==''\nresult={'owner':owner,'protectedAgent':protected,'native':native,'repositories':repos,'originalInputSentByThisTask':False}\nfor kind in ['agent','terminal']:\n value=data.get(kind)\n if value:\n  proc=process(value['pid']); assert proc['cwd']==str(pathlib.Path(data['workspacePath']).resolve()) and proc['parentPid']==native['pid']\n  result[kind]=proc\nif data.get('agent') and data['agent'].get('transcriptPath'):\n path=pathlib.Path(data['agent']['transcriptPath']); history={'exists':path.is_file(),'userTurns':0,'matchedUserTurns':0,'assistantReplies':0,'matchedAssistantReplies':0,'ownedFileReads':0,'writeToolCalls':0,'toolErrors':0,'cwdFacts':[]}\n if path.is_file():\n  content=path.read_bytes();history.update({'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()})\n  for line in content.decode().splitlines():\n   try:item=json.loads(line)\n   except ValueError:continue\n   if item.get('cwd') and item['cwd'] not in history['cwdFacts']:history['cwdFacts'].append(item['cwd'])\n   message=item.get('message',{}); role=message.get('role'); parts=message.get('content',[])\n   if isinstance(parts,str):parts=[{'type':'text','text':parts}]\n   text='\\n'.join(p.get('text','') for p in parts if isinstance(p,dict) and p.get('type')=='text')\n   if role=='user' and text:\n    history['userTurns']+=1\n    if data.get('prompt') and data['prompt'] in text:history['matchedUserTurns']+=1\n   if role=='assistant' and text:\n    history['assistantReplies']+=1\n    if 'HOST_UI_GEMINICC_READY' in text and data.get('token','never') in text:history['matchedAssistantReplies']+=1\n   for part in parts:\n    if not isinstance(part,dict):continue\n    if part.get('type')=='tool_use':\n     name=part.get('name',''); target=part.get('input',{}).get('file_path','')\n     if name=='Read' and pathlib.Path(target).resolve()==(pathlib.Path(data['workspacePath'])/'host-ui-task.txt').resolve():history['ownedFileReads']+=1\n     if name in ['Write','Edit','MultiEdit','NotebookEdit']:history['writeToolCalls']+=1\n    if part.get('type')=='tool_result' and part.get('is_error'):history['toolErrors']+=1\n  history['cwdFactsMatch']=bool(history['cwdFacts']) and all(pathlib.Path(c).resolve()==pathlib.Path(data['workspacePath']).resolve() for c in history['cwdFacts'])\n result['history']=history\nprint(json.dumps(result))\n")))
}

export async function observeProtected(client) {
  const owner = client.runtimeOwnerIdentity()
  const status = await client.statusAgent(originalSessionId)
  assert.equal(owner.runtimeId, farmRuntimeId); assert.equal(owner.processId, 3398225)
  assert.equal(owner.ownerInstanceId, '3898ec29-09fb-467e-afe5-4745857616c6')
  assert.equal(status.run.runId, originalRunId); assert.equal(status.run.pid, 3401036)
  assert.equal(status.run.state, 'running'); assert.equal(status.session.workspacePath, clonePath)
  assert.equal(status.session.nativeHandle?.sessionId, 'e37b5aa1-306a-4afc-ad00-6eeda7e8b59d')
  return { owner, sessionId: status.session.agentSessionId, runId: status.run.runId, pid: status.run.pid,
    workspacePath: status.session.workspacePath, nativeHandle: status.session.nativeHandle,
    acceptedInputBytes: status.run.acceptedInputBytes, inputByteSource: 'unknown; concurrently usable by user' }
}

export async function removeFarmWorkspace(workspacePath, parentCreated) {
  assert.ok(workspacePath.startsWith(clonePath + '/.agentmux-host-ui-qa/'))
  return await farmPython(`import pathlib,json,shutil
data=${pythonInput({ workspacePath, parentCreated })}; owned=pathlib.Path(data['workspacePath'])
assert owned.parent==pathlib.Path(${JSON.stringify(clonePath)})/'.agentmux-host-ui-qa'
assert not owned.is_symlink()
if owned.exists():shutil.rmtree(owned)
if data['parentCreated']:
 try:owned.parent.rmdir()
 except OSError:pass
print(json.dumps({'exactOwnedWorkspaceRemoved':not owned.exists(),'path':str(owned),'sharedRemoteServiceTouched':False}))
`)
}
