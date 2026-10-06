/** These programs are transported as single quoted argv by ExecutionHost. They
 * have no shell interpolation, provider branches, or access to Agent credentials. */
export const INSPECT_CORE_OWNER = String.raw`
import json,os,sys,hashlib,platform,stat
p=json.loads(sys.stdin.read())
def text(path):
 with open(path) as f: return f.read()
def sha(path):
 with open(path,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
if not sys.platform.startswith('linux') or platform.machine() not in ['x86_64','amd64']: raise RuntimeError('Only Linux x64 headless owners have qualified process inspection.')
def listener(path):
 target=os.lstat(path)
 if not stat.S_ISSOCK(target.st_mode) or target.st_uid!=os.getuid(): raise RuntimeError('The exact socket file belongs to another or unknown owner.')
 inodes=[]
 for line in text('/proc/net/unix').splitlines()[1:]:
  row=line.split(None,7)
  if len(row)!=8 or row[3]!='00010000' or os.path.dirname(row[7])!=os.path.dirname(path): continue
  try:
   bound=os.lstat(row[7])
   if stat.S_ISSOCK(bound.st_mode) and bound.st_uid==target.st_uid and (bound.st_dev,bound.st_ino)==(target.st_dev,target.st_ino): inodes.append((row[6],row[7]))
  except FileNotFoundError: pass
 if len(inodes)!=1: raise RuntimeError('The exact listener is not uniquely verified.')
 owners=[]
 for entry in os.listdir('/proc'):
  if not entry.isdigit(): continue
  directory='/proc/'+entry
  try:
   if os.stat(directory).st_uid!=os.getuid(): continue
   for fd in os.listdir(directory+'/fd'):
    try:
     if os.readlink(directory+'/fd/'+fd)=='socket:['+inodes[0][0]+']': owners.append(int(entry)); break
    except FileNotFoundError: pass
  except (FileNotFoundError,PermissionError): pass
 if len(owners)!=1: raise RuntimeError('The exact listener process is not uniquely verified.')
 return owners[0],inodes[0][1],target.st_dev,target.st_ino
worker_pid,bound_path,socket_dev,socket_inode=listener(p['socket']); worker_base='/proc/'+str(worker_pid)
worker_stat=text(worker_base+'/stat').rsplit(')',1)[1].split()
worker_argv=open(worker_base+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))
if len(worker_argv)!=3 or not worker_argv[1].endswith('/dist/control-endpoint-listener-worker.js') or worker_argv[2]!=bound_path or os.path.realpath(worker_argv[0])!=os.readlink(worker_base+'/exe'):
 raise RuntimeError('The published socket has no qualified Core listener worker.')
pid=int(worker_stat[1]); base='/proc/'+str(pid)
if p.get('pid') not in [None,pid]: raise RuntimeError('The semantic listener process changed.')
start=text(base+'/stat').rsplit(')',1)[1].split()[19]
if p.get('startTicks') not in [None,start]: raise RuntimeError('The semantic listener birth identity changed.')
argv=open(base+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))
exe=os.readlink(base+'/exe'); cwd=os.readlink(base+'/cwd')
if len(argv)!=3 or argv[2]!='serve' or not argv[1].endswith('/dist/headless-runtime-cli.js') or os.path.realpath(argv[0])!=exe:
 raise RuntimeError('This owner has no qualified headless launch identity.')
if os.path.dirname(worker_argv[1])!=os.path.dirname(argv[1]) or os.readlink(worker_base+'/exe')!=exe:
 raise RuntimeError('The listener worker belongs to another program or Node image.')
if os.stat(base).st_uid != os.getuid(): raise RuntimeError('The semantic owner belongs to another user.')
allowed={'HOME','PATH','SHELL','CLAUDE_CONFIG_DIR','LANG','LC_ALL','TZ','AGENTMUX_STATE_DIRECTORY','AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_AGENT_SESSION_STORE','AGENTMUX_HOOK_PORT','AGENTMUX_MESSAGE_QUEUE_PATH'}
metadata={'USER','LOGNAME','PWD','OLDPWD','SHLVL','_','SSH_CONNECTION','SSH_CLIENT','SSH_TTY'}
env={}
for item in open(base+'/environ','rb').read().split(bytes([0])):
 key,sep,value=item.partition(b'=')
 if not sep: continue
 name=key.decode(errors='replace')
 if name in allowed: env[name]=value.decode()
 elif name not in metadata: raise RuntimeError('Original launch has additional unsupported environment configuration; this update cannot reconstruct it. Existing Runs are retained.')
for key in ['HOME','PATH','AGENTMUX_STATE_DIRECTORY','AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_AGENT_SESSION_STORE']:
 if not env.get(key): raise RuntimeError('Original owner lacks explicit '+key+'; namespace cannot be reconstructed.')
for key in ['HOME','AGENTMUX_STATE_DIRECTORY','AGENTMUX_RUNTIME_DIRECTORY','AGENTMUX_AGENT_SESSION_STORE']:
 if not os.path.isabs(env[key]): raise RuntimeError('Original namespace is not absolute.')
state=os.path.abspath(env['AGENTMUX_STATE_DIRECTORY'].strip()); runtime=os.path.abspath(env['AGENTMUX_RUNTIME_DIRECTORY'].strip()); store=os.path.abspath(env['AGENTMUX_AGENT_SESSION_STORE'].strip())
if p['socket'] != os.path.join(runtime,'control.sock') or p.get('store') not in [None,store]: raise RuntimeError('Endpoint/Store does not match owner namespace.')
binding=json.loads(text(os.path.join(state,'semantic-runtime.json')))
hook_port=40000+int.from_bytes(hashlib.sha256(runtime.encode()).digest()[:2],'big')%20000
authority=hashlib.sha256(json.dumps({'stateDirectory':state,'storePath':store,'ctxmuxSocket':os.path.join(runtime,'ctxmux.sock'),'ctxmuxState':os.path.join(state,'ctxmux'),'hookPort':hook_port},separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
if binding.get('schema')!='agentmux.semantic-runtime.v1' or binding.get('runtimeId')!=p['runtimeId'] or binding.get('authority')!=authority:
 raise RuntimeError('Durable Runtime authority does not match original launch namespace.')
for lease in [os.path.join(state,'semantic-owner.lock'),p['socket']+'.owner.lock']:
 held=False
 for fd in os.listdir(base+'/fd'):
  try:
   if os.path.realpath(base+'/fd/'+fd)!=os.path.realpath(lease): continue
   inode=os.stat(base+'/fd/'+fd).st_ino
   for line in text(base+'/fdinfo/'+fd).splitlines():
    lock=line.split()
    if len(lock)==9 and lock[0]=='lock:' and lock[3:5]==['ADVISORY','WRITE'] and lock[7:]==['0','EOF'] and int(lock[6].rsplit(':',1)[1])==inode:
     if lock[2]=='OFDLCK' and lock[5]=='-1' or lock[2]=='FLOCK' and lock[5]==str(pid): held=True
  except FileNotFoundError: pass
 if not held: raise RuntimeError('Original semantic owner lease is not verified.')
root=os.path.dirname(os.path.dirname(argv[1]))
if json.loads(text(os.path.join(root,'package.json'))).get('name')!='@agentmux/core': raise RuntimeError('Original program is not Core.')
deployment_path=os.path.join(root,'deployment.json')
if not os.path.isfile(deployment_path): raise RuntimeError('Original Core lacks a content-bound deployment inventory; this update is unverified. Existing Runs are retained.')
deployment=json.loads(text(deployment_path)); files=deployment.get('files')
if not isinstance(files,list) or not files or hashlib.sha256(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!=deployment.get('digest'):
 raise RuntimeError('Original Core deployment inventory is invalid.')
seen=set()
for item in files:
 path=item['path']; target=os.path.join(root,path)
 if path in seen or not path or os.path.isabs(path) or os.path.commonpath([root,os.path.realpath(target)])!=root: raise RuntimeError('Original Core file scope is invalid.')
 seen.add(path)
 if sha(target)!=item['sha256'] or os.stat(target).st_mode&0o777!=item['mode']: raise RuntimeError('Original Core deployment file was changed.')
for required in ['package.json','dist/headless-runtime-cli.js','dist/control-endpoint-listener-worker.js','dist/public-rpc-client.js','dist/hosted-value.js','dist/rpc-native-codec.js']:
 if required not in seen: raise RuntimeError('Original Core reader is not bound to its deployment.')
native_socket=os.path.join(runtime,'ctxmux.sock'); native_pid,_,_,_=listener(native_socket); native_base='/proc/'+str(native_pid)
if p.get('nativePid') not in [None,native_pid]: raise RuntimeError('The Native listener process changed.')
native_argv=open(native_base+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))
def flag(name):
 if native_argv.count(name)!=1: raise RuntimeError('Native launch namespace is ambiguous.')
 return native_argv[native_argv.index(name)+1]
if flag('--socket')!=native_socket or flag('--state-dir')!=os.path.join(state,'ctxmux'): raise RuntimeError('Native listener namespace differs from the original Core.')
native_start=text(native_base+'/stat').rsplit(')',1)[1].split()[19]
native_sha=sha(native_base+'/exe')
receipt=json.loads(text(os.path.join(runtime,'owner.json')))
if receipt.get('schema')!='agentmux.ctxmux-owner.v1' or receipt.get('socketPath')!=native_socket or receipt.get('stateDirectory')!=os.path.join(state,'ctxmux') or receipt.get('daemonSha256')!=native_sha or not os.path.isabs(receipt.get('daemonPath','')) or os.path.realpath(receipt['daemonPath'])!=os.readlink(native_base+'/exe'):
 raise RuntimeError('Original Native executable does not match its exact ownership receipt.')
artifact=os.path.dirname(os.path.dirname(receipt['daemonPath'])); manifest_path=os.path.join(artifact,'manifest.json'); manifest=json.loads(text(manifest_path))
daemon=next((item for item in manifest.get('binaries',[]) if item.get('name')=='ctxmuxd'),None)
if sha(manifest_path)!=receipt.get('manifestSha256') or manifest.get('schema')!='ctxmux.local-artifacts.v1' or manifest.get('support',{}).get('platform')!='linux' or manifest.get('support',{}).get('architecture')!='x64' or manifest.get('source',{}).get('commit')!=receipt.get('sourceCommit') or manifest.get('source',{}).get('tree')!=receipt.get('sourceTree') or not daemon or os.path.join(artifact,daemon['path'])!=receipt['daemonPath'] or daemon.get('sha256')!=native_sha or sha(receipt['daemonPath'])!=native_sha:
 raise RuntimeError('Original Native artifact does not match its executable and ownership receipt.')
print(json.dumps({'node':exe,'cli':argv[1],'cwd':cwd,'processId':pid,'startTicks':start,'listenerProcessId':worker_pid,'listenerStartTicks':worker_stat[19],'socketDevice':socket_dev,'socketInode':socket_inode,'env':env,'stateDirectory':state,'runtimeDirectory':runtime,'storePath':store,'nativeSha256':native_sha,'nativeProcessId':native_pid,'nativeStartTicks':native_start,'nativeArtifactDirectory':artifact,'nativeManifestSha256':receipt['manifestSha256'],'nativeInstanceId':receipt['daemonInstanceId'],'nativeRuntimeId':receipt['runtimeId'],'nativeBuildId':receipt['runtimeBuildId'],'platform':'linux-x64','deploymentDigest':deployment['digest']}))
`

/** The exact serving producer validates its own public DTOs before projecting
 * maintenance facts. The current normal client never parses an old Hosted DTO. */
export const READ_CORE_MAINTENANCE = String.raw`
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),crypto=require('node:crypto'),cp=require('node:child_process'),os=require('node:os');
const p=JSON.parse(fs.readFileSync(0,'utf8')),launch=p.launch,root=path.dirname(path.dirname(launch.cli));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function source(){
 const deployment=JSON.parse(fs.readFileSync(path.join(root,'deployment.json'),'utf8'));
 if(deployment.digest!==launch.deploymentDigest||hash(JSON.stringify(deployment.files))!==deployment.digest||!deployment.files.length)throw Error('Original producer deployment changed');
 for(const file of deployment.files){const target=path.join(root,file.path),relative=path.relative(root,fs.realpathSync(target));
  if(path.isAbsolute(file.path)||relative.startsWith('..')||path.isAbsolute(relative)||hash(fs.readFileSync(target))!==file.sha256||(fs.statSync(target).mode&0o777)!==file.mode)throw Error('Original producer source changed');}
 return deployment.digest;
}
function nativeScope(){
 const base='/proc/'+launch.nativeProcessId,stat=fs.readFileSync(base+'/stat','utf8').split(')').slice(1).join(')').trim().split(/\s+/);
 if(stat[19]!==launch.nativeStartTicks||hash(fs.readFileSync(base+'/exe'))!==launch.nativeSha256)throw Error('The original Native process changed');
 const manifestBytes=fs.readFileSync(path.join(launch.nativeArtifactDirectory,'manifest.json'));
 if(hash(manifestBytes)!==launch.nativeManifestSha256)throw Error('Original Native manifest changed');
 return JSON.parse(manifestBytes);
}
function ownerFacts(owner){
 if(owner.runtimeId!==p.runtimeId||owner.processId!==launch.processId||owner.availability!=='connected'||!owner.ctxmux||owner.ctxmux.instanceId!==launch.nativeInstanceId||owner.ctxmux.buildIdentity!==launch.nativeBuildId||owner.ctxmux.processId!==null&&owner.ctxmux.processId!==launch.nativeProcessId)throw Error('The original owner or Native identity is unconfirmed');
 return {runtimeId:owner.runtimeId,ownerInstanceId:owner.ownerInstanceId,processId:owner.processId,
  ctxmux:{instanceId:owner.ctxmux.instanceId,processId:owner.ctxmux.processId,buildIdentity:owner.ctxmux.buildIdentity,protocolVersion:owner.ctxmux.protocolVersion}};
}
void(async()=>{
 source();const manifest=nativeScope(),archive=manifest.sdk?.archive;
 if(!archive||path.basename(archive.path)!==archive.path)throw Error('Original Native SDK archive scope is invalid');
 const bytes=fs.readFileSync(path.join(launch.nativeArtifactDirectory,archive.path));
 if(hash(bytes)!==archive.sha256||bytes.length!==archive.bytes)throw Error('Original Native SDK archive changed');
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'agentmux-maintenance-sdk-'));fs.chmodSync(scratch,0o700);
 let rpc;
 try{
  const tar=path.join(scratch,'sdk.tgz');fs.writeFileSync(tar,bytes,{mode:0o600});
  const members=cp.execFileSync('tar',['-tzf',tar],{encoding:'utf8'}).trim().split('\n');
  if(!members.length||members.some(name=>!name.startsWith('package/')||name.split('/').includes('..')))throw Error('Original Native SDK archive members are invalid');
  cp.execFileSync('tar',['-xzf',tar,'--no-same-owner','-C',scratch]);
  const sdkPackage=JSON.parse(fs.readFileSync(path.join(scratch,'package/package.json'),'utf8'));
  if(sdkPackage.name!==manifest.sdk.name||sdkPackage.version!==manifest.sdk.version)throw Error('Original Native SDK package identity is invalid');
  const {CtxmuxClient,CtxmuxProtocolError}=await import(url.pathToFileURL(path.join(scratch,'package/dist/index.js')).href);
  const sdk=new CtxmuxClient({socketPath:path.join(launch.runtimeDirectory,'ctxmux.sock')}),hello=await sdk.runtimeInfo();
  if(hello.daemonInstanceId!==launch.nativeInstanceId||hello.runtimeId!==launch.nativeRuntimeId||hello.buildId!==launch.nativeBuildId||hello.protocolGeneration!==manifest.product.protocol)throw Error('The exact Native Hello identity is unconfirmed');
  const native=new CtxmuxClient({socketPath:path.join(launch.runtimeDirectory,'ctxmux.sock'),expectedRuntimeIdentity:hello});
  const nativeRuntime={daemonInstanceId:hello.daemonInstanceId,runtimeId:hello.runtimeId,buildId:hello.buildId,protocolGeneration:hello.protocolGeneration,runtimeIdPersistence:hello.runtimeIdPersistence,platform:hello.platform,arch:hello.arch,capabilities:hello.capabilities};
  const {connectAgentMuxRpc}=await import(url.pathToFileURL(path.join(root,'dist/public-rpc-client.js')).href);
  rpc=await connectAgentMuxRpc({endpoint:{transport:'unix',path:p.socket}});
  const call=(method,params)=>rpc.call(method,params,{signal:AbortSignal.timeout(20000)});
  const owner=ownerFacts((await call('runtime.owner.identity',{expectedRuntimeId:p.runtimeId})).owner);
  if(owner.ctxmux.protocolVersion!==hello.protocolGeneration)throw Error('Core and Native protocol observations differ');
  const fence={runtimeId:owner.runtimeId,ownerInstanceId:owner.ownerInstanceId};
  if(p.shutdown){
   if(owner.ownerInstanceId!==p.shutdown.ownerInstanceId||owner.processId!==p.shutdown.processId||source()!==p.shutdown.sourceDigest)throw Error('The original shutdown admission changed');
   nativeScope();
   const response=await call('runtime.owner.shutdown',{fence}),stopped=ownerFacts(response.owner);
   if(response.accepted!==true||JSON.stringify(stopped)!==JSON.stringify(owner))throw Error('The original Core shutdown acknowledgement is unknown');
   source();nativeScope();console.log(JSON.stringify({accepted:true,owner:stopped}));return;
  }
  const bootstrap=await call('runtime.bootstrap',{consumerId:'core-upgrade-inspect-'+crypto.randomUUID(),fence});
  if(bootstrap.owner.runtimeId!==owner.runtimeId||bootstrap.owner.ownerInstanceId!==owner.ownerInstanceId||bootstrap.hostProcessId!==owner.processId||bootstrap.storePath!==launch.storePath)throw Error('Original bootstrap belongs to another owner or Store');
  const sessions=[],runs=[],missing=new Set();
  for(const session of bootstrap.sessions){
   sessions.push({agentSessionId:session.agentSessionId,run:{runId:session.run.runId}});
   try{const run=await native.status(session.run.runId);
    if(run.id!==session.run.runId)throw Error('Native status belongs to another Run');
    runs.push({agentSessionId:session.agentSessionId,runId:run.id,pid:run.pid,state:run.state.type,outputBytes:run.latest_output_bytes,inputBytes:run.applied_input_bytes});
   }catch(error){if(!(error instanceof CtxmuxProtocolError)||error.code!=='run_not_found')throw error;missing.add(session.run.runId);}
  }
  if(JSON.stringify(ownerFacts((await call('runtime.owner.identity',{expectedRuntimeId:p.runtimeId})).owner))!==JSON.stringify(owner))throw Error('The original owner changed during observation');
  const after=await sdk.runtimeInfo();
  if(after.daemonInstanceId!==hello.daemonInstanceId||after.runtimeId!==hello.runtimeId||after.buildId!==hello.buildId)throw Error('Native identity changed during observation');
  source();nativeScope();console.log(JSON.stringify({owner,bootstrap:{storePath:bootstrap.storePath,hostProcessId:bootstrap.hostProcessId,sessions},runs,missingRunIds:[...missing],nativeRuntime}));
 }finally{await rpc?.dispose();fs.rmSync(scratch,{recursive:true,force:true});}
})().catch(e=>{console.error(e.message);process.exitCode=1});
`

export const STAGE_CORE = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const p=JSON.parse(fs.readFileSync(0,'utf8')); const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const root=path.join(p.stateDirectory,'core-releases',p.digest), archive=Buffer.from(p.archive,'base64');
if(hash(archive)!==p.archiveDigest)throw Error('Portable archive digest mismatch');
fs.mkdirSync(path.dirname(root),{recursive:true,mode:0o700});
if(!fs.existsSync(root)){
 const staged=root+'.'+p.operationId+'.staging'; fs.mkdirSync(staged,{mode:0o700});
 const tar=path.join(staged,'.archive.tar.gz');fs.writeFileSync(tar,archive,{mode:0o600});
 cp.execFileSync('tar',['-xzf',tar,'-C',staged]);fs.unlinkSync(tar);
 for(const f of p.files){const target=path.join(staged,f.path);if(path.relative(staged,target).startsWith('..')||hash(fs.readFileSync(target))!==f.sha256)throw Error('Portable file digest mismatch');fs.chmodSync(target,f.mode);}
 fs.writeFileSync(path.join(staged,'deployment.json'),JSON.stringify({digest:p.digest,files:p.files}));fs.renameSync(staged,root);
}
const record=JSON.parse(fs.readFileSync(path.join(root,'deployment.json'),'utf8'));if(record.digest!==p.digest)throw Error('Release identity mismatch');
for(const f of p.files){const target=path.join(root,f.path);if(hash(fs.readFileSync(target))!==f.sha256||(fs.statSync(target).mode&0o777)!==f.mode)throw Error('Staged release was changed');}
if(Number(process.versions.node.split('.')[0])<24)throw Error('The original Node executable is older than the candidate requires');
cp.execFileSync(p.node,['--input-type=module','--eval','await import('+JSON.stringify(require('node:url').pathToFileURL(path.join(root,'dist','headless-runtime.js')).href)+')'],{timeout:30000});
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const launcher=path.join(root,'launcher');fs.mkdirSync(launcher,{recursive:true,mode:0o700});
const command=path.join(launcher,'amux');fs.writeFileSync(command,'#!/bin/sh\nexec '+quote(p.node)+' '+quote(path.join(root,'dist','agentmux.js'))+' "$@"\n',{mode:0o755});
console.log(JSON.stringify({releaseDirectory:root,remoteCommand:command,digest:p.digest}));
`

export const START_CORE = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const lease=path.join(p.stateDirectory,'core-releases',p.operationId+'.start.json');
if(fs.existsSync(lease))throw Error('The original start admission already exists; inspect it without replaying');
const fd=fs.openSync(lease,'wx',0o600);fs.writeSync(fd,JSON.stringify({operationId:p.operationId,state:'admitted'}));fs.fsyncSync(fd);fs.closeSync(fd);
const log=fs.openSync(path.join(p.stateDirectory,'core-releases',p.operationId+'.log'),'a',0o600);
const child=cp.spawn(p.node,[path.join(p.releaseDirectory,'dist','headless-runtime-cli.js'),'serve'],{cwd:p.cwd,env:p.env,detached:true,stdio:['ignore',log,log]});
child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('spawn',()=>{fs.writeFileSync(lease,JSON.stringify({operationId:p.operationId,state:'started',processId:child.pid}));child.unref();console.log(JSON.stringify({processId:child.pid}));});
`
export const OWNER_GONE = String.raw`
import os,sys,json
p=json.loads(sys.stdin.read()); base='/proc/'+str(p['pid'])
try:
 with open(base+'/stat') as f: stat=f.read()
 parts=stat.rsplit(')',1)[1].split(); gone=parts[19]!=p['startTicks'] or parts[0]=='Z'
except FileNotFoundError: gone=True
print(json.dumps({'gone':gone}))
`
export const NATIVE_RUN_INVENTORY = String.raw`
const fs=require('node:fs'),path=require('node:path'),url=require('node:url');const p=JSON.parse(fs.readFileSync(0,'utf8'));
void(async()=>{const m=await import(url.pathToFileURL(path.join(p.releaseDirectory,'dist','ctxmux-run-adapter.js')).href);
const result=await m.observeExistingCtxmuxRuns(p.socketPath,p.instanceId);console.log(JSON.stringify(result));})().catch(e=>{console.error(e.message);process.exitCode=1});
`
