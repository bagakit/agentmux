import { identityRuntimeSource } from '@agentmux/identity/runtime-source'
/** These programs are transported as single quoted argv by ExecutionHost. They
 * have no shell interpolation, provider branches, or access to Agent credentials. */
export const INSPECT_CORE_OWNER = String.raw`
import json,os,sys,hashlib,platform,stat,subprocess
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
if os.path.dirname(os.path.realpath(worker_argv[1]))!=os.path.dirname(os.path.realpath(argv[1])) or os.readlink(worker_base+'/exe')!=exe:
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
def require_lease(directory,owner_pid,lease):
 held=False
 for fd in os.listdir(directory+'/fd'):
  try:
   if os.path.realpath(directory+'/fd/'+fd)!=os.path.realpath(lease): continue
   inode=os.stat(directory+'/fd/'+fd).st_ino
   for line in text(directory+'/fdinfo/'+fd).splitlines():
    lock=line.split()
    if len(lock)==9 and lock[0]=='lock:' and lock[3:5]==['ADVISORY','WRITE'] and lock[7:]==['0','EOF'] and int(lock[6].rsplit(':',1)[1])==inode:
     if lock[2]=='OFDLCK' and lock[5]=='-1' or lock[2]=='FLOCK' and lock[5]==str(owner_pid): held=True
  except FileNotFoundError: pass
 if not held: raise RuntimeError('Original process state lease is not verified.')
for lease in [os.path.join(state,'semantic-owner.lock'),p['socket']+'.owner.lock']:
 require_lease(base,pid,lease)
root=os.path.dirname(os.path.dirname(os.path.realpath(argv[1])))
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
require_lease(native_base,native_pid,os.path.join(state,'ctxmux','state.lock'))
native_start=text(native_base+'/stat').rsplit(')',1)[1].split()[19]
native_sha=sha(native_base+'/exe')
native_executable=os.readlink(native_base+'/exe')
artifact=os.path.dirname(os.path.dirname(native_executable)); manifest_path=os.path.join(artifact,'manifest.json'); manifest=json.loads(text(manifest_path))
daemon=next((item for item in manifest.get('binaries',[]) if item.get('name')=='ctxmuxd'),None)
if not os.path.isabs(native_executable) or os.path.realpath(native_executable)!=native_executable or not daemon or os.path.join(artifact,daemon['path'])!=native_executable or manifest.get('schema')!='ctxmux.local-artifacts.v1' or manifest.get('support',{}).get('platform')!='linux' or manifest.get('support',{}).get('architecture')!='x64' or daemon.get('sha256')!=native_sha or sha(native_executable)!=native_sha:
 raise RuntimeError('Original Native artifact does not match its exact executing image.')
manifest_sha=sha(manifest_path)
package_version=json.loads(text(os.path.join(root,'package.json'))).get('version')
release_source=json.loads(text(os.path.join(root,'release.json'))).get('sourceCommit') if 'release.json' in seen else None
# The cgroup path only locates a candidate. The user manager must confirm that this
# exact Core is the unit MainPID; no display name or inherited SSH environment does.
service=None
uid=os.getuid(); user_runtime='/run/user/'+str(uid)
for row in text(base+'/cgroup').splitlines():
 hierarchy,controllers,group=row.split(':',2)
 if hierarchy!='0' and controllers!='name=systemd': continue
 if '/user@'+str(uid)+'.service/' not in group or not group.endswith('.service'): continue
 unit=group.rsplit('/',1)[1]
 manager_env={**os.environ,'XDG_RUNTIME_DIR':user_runtime,'DBUS_SESSION_BUS_ADDRESS':'unix:path='+user_runtime+'/bus'}
 shown=subprocess.run(['systemctl','--user','show',unit,'--property=Id,MainPID,FragmentPath,ControlGroup,KillMode,ActiveState'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True,env=manager_env,timeout=10)
 if shown.returncode!=0: raise RuntimeError('The original user service could not be inspected; no owner was stopped.')
 facts=dict(line.split('=',1) for line in shown.stdout.splitlines() if '=' in line)
 if facts.get('Id')!=unit or facts.get('MainPID')!=str(pid) or facts.get('ControlGroup')!=group or facts.get('ActiveState')!='active' or not os.path.isabs(facts.get('FragmentPath','')):
  raise RuntimeError('The user manager does not confirm this exact Core as its MainPID; no owner was stopped.')
 if facts.get('KillMode')!='process': raise RuntimeError('This user service would stop the Native Runtime with its Core (KillMode must be process); no owner was stopped.')
 service={'unit':unit,'fragmentPath':facts['FragmentPath'],'controlGroup':group,'runtimeDirectory':user_runtime}
 break
result={'service':service,'node':exe,'cli':argv[1],'cwd':cwd,'processId':pid,'startTicks':start,'listenerProcessId':worker_pid,'listenerStartTicks':worker_stat[19],'socketDevice':socket_dev,'socketInode':socket_inode,'env':env,'stateDirectory':state,'runtimeDirectory':runtime,'storePath':store,'nativeSha256':native_sha,'nativeProcessId':native_pid,'nativeStartTicks':native_start,'nativeArtifactDirectory':artifact,'nativeManifestSha256':manifest_sha,'platform':'linux-x64','deploymentDigest':deployment['digest'],'version':package_version if isinstance(package_version,str) and package_version else None,'sourceCommit':release_source if isinstance(release_source,str) and release_source else None}
# The caller derives this exact address only after public Core/Native identity agrees.
# Receipt contents never select the current instance or override these OS facts.
if 'receipt' in p:
 request=p['receipt']; receipt_path=request['path']; identity=request['identity']
 if os.path.dirname(receipt_path)!=runtime or not os.path.basename(receipt_path).startswith('owner-') or not os.path.basename(receipt_path).endswith('.json'): raise RuntimeError('Owner receipt address is outside the original namespace.')
 diagnostic={'status':'unreadable','path':receipt_path}
 try:
  metadata=os.lstat(receipt_path)
  if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid!=os.getuid() or metadata.st_mode&0o777!=0o600 or metadata.st_size>65536: raise RuntimeError('Owner receipt is not a bounded private regular file.')
  receipt=json.loads(text(receipt_path))
  matching=receipt.get('schema')=='agentmux.ctxmux-owner.v1' and receipt.get('socketPath')==native_socket and receipt.get('stateDirectory')==os.path.join(state,'ctxmux') and receipt.get('daemonSha256')==native_sha and receipt.get('daemonPath')==native_executable and receipt.get('manifestSha256')==manifest_sha and receipt.get('sourceCommit')==manifest.get('source',{}).get('commit') and receipt.get('sourceTree')==manifest.get('source',{}).get('tree') and receipt.get('daemonInstanceId')==identity['daemonInstanceId'] and receipt.get('runtimeId')==identity['runtimeId'] and receipt.get('runtimeBuildId')==identity['buildId']
  diagnostic['status']='matching' if matching else 'mismatch'
 except FileNotFoundError: diagnostic['status']='missing'
 except Exception as error: diagnostic['detail']=str(error)
 result['ownerReceipt']=diagnostic
print(json.dumps(result))
`

/** The exact serving producer validates its own public DTOs before projecting
 * maintenance facts. The current normal client never parses an old Hosted DTO. */
export const READ_CORE_MAINTENANCE = String.raw`
const { mintObjectId } = ${identityRuntimeSource};
const fs=require('node:fs'),path=require('node:path'),url=require('node:url'),crypto=require('node:crypto'),cp=require('node:child_process'),os=require('node:os');
const p=JSON.parse(fs.readFileSync(0,'utf8')),launch=p.launch,root=path.dirname(path.dirname(fs.realpathSync(launch.cli)));
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
let currentNative;
function ownerFacts(owner){
 if(owner.runtimeId!==p.runtimeId||owner.processId!==launch.processId||owner.availability!=='connected'||!owner.ctxmux||owner.ctxmux.instanceId!==currentNative.daemonInstanceId||owner.ctxmux.buildIdentity!==currentNative.buildId||owner.ctxmux.processId!==null&&owner.ctxmux.processId!==launch.nativeProcessId)throw Error('The original owner or Native identity is unconfirmed');
 return {runtimeId:owner.runtimeId,ownerInstanceId:owner.ownerInstanceId,processId:owner.processId,protocolVersion:owner.protocolVersion,
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
  if(hello.protocolGeneration!==manifest.product.protocol||launch.nativeInstanceId!==undefined&&(hello.daemonInstanceId!==launch.nativeInstanceId||hello.runtimeId!==launch.nativeRuntimeId||hello.buildId!==launch.nativeBuildId))throw Error('The exact Native Hello identity is unconfirmed');
  currentNative=hello;
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
  const bootstrap=await call('runtime.bootstrap',{consumerId:'core-upgrade-inspect-'+mintObjectId(),fence});
  if(bootstrap.owner.runtimeId!==owner.runtimeId||bootstrap.owner.ownerInstanceId!==owner.ownerInstanceId||bootstrap.hostProcessId!==owner.processId||bootstrap.storePath!==launch.storePath)throw Error('Original bootstrap belongs to another owner or Store');
  const sessions=bootstrap.sessions.map(session=>({agentSessionId:session.agentSessionId,run:{runId:session.run.runId}})),nativeRuns=[];
  // Every Run of this exact Native, read through its own SDK: the Session bindings, a
  // Core-only update and a Native replacement all use this one inventory.
  for(const summary of await native.list()){
   try{const run=await native.status(summary.id);
    if(run.id!==summary.id)throw Error('Native status belongs to another Run');
    nativeRuns.push({runId:run.id,pid:run.pid,state:run.state.type,outputBytes:run.latest_output_bytes,durableOutputBytes:run.durable_output_bytes,inputBytes:run.applied_input_bytes});
   }catch(error){if(!(error instanceof CtxmuxProtocolError)||error.code!=='run_not_found')throw error;}
  }
  if(JSON.stringify(ownerFacts((await call('runtime.owner.identity',{expectedRuntimeId:p.runtimeId})).owner))!==JSON.stringify(owner))throw Error('The original owner changed during observation');
  const after=await sdk.runtimeInfo();
  if(after.daemonInstanceId!==hello.daemonInstanceId||after.runtimeId!==hello.runtimeId||after.buildId!==hello.buildId)throw Error('Native identity changed during observation');
  source();nativeScope();console.log(JSON.stringify({owner,bootstrap:{storePath:bootstrap.storePath,hostProcessId:bootstrap.hostProcessId,sessions},nativeRuns,nativeRuntime}));
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

/** A systemd unit stays its original execution owner. Only this operation's runtime
 * drop-in selects the candidate until verification commits the persistent pointer. */
const USER_SERVICE_CONTROL = String.raw`
function serviceControl(service,args){
 const env={...process.env,XDG_RUNTIME_DIR:service.runtimeDirectory,DBUS_SESSION_BUS_ADDRESS:'unix:path='+service.runtimeDirectory+'/bus'};
 return cp.execFileSync('systemctl',['--user',...args],{env,encoding:'utf8',timeout:30000});
}
function serviceFacts(service){
 const output=serviceControl(service,['show',service.unit,'--property=Id,MainPID,FragmentPath,ControlGroup,KillMode']);
 return Object.fromEntries(output.trim().split('\n').filter(line=>line.includes('=')).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
}
function serviceDropin(service,operationId){
 if(!/^[A-Za-z0-9_-]+$/.test(operationId)||!service.unit.endsWith('.service')||path.basename(service.unit)!==service.unit)throw Error('The original service identity is invalid');
 return path.join(service.runtimeDirectory,'systemd','user',service.unit+'.d','50-agentmux-'+operationId+'.conf');
}
`
export const START_CORE = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const p=JSON.parse(fs.readFileSync(0,'utf8'));
` + USER_SERVICE_CONTROL + String.raw`
const lease=path.join(p.stateDirectory,'core-releases',p.operationId+'.start.json');
if(fs.existsSync(lease))throw Error('The original start admission already exists; inspect it without replaying');
const fd=fs.openSync(lease,'wx',0o600);fs.writeSync(fd,JSON.stringify({operationId:p.operationId,state:'admitted'}));fs.fsyncSync(fd);fs.closeSync(fd);
if(p.service){
 const service=p.service,facts=serviceFacts(service);
 if(facts.Id!==service.unit||facts.FragmentPath!==service.fragmentPath||facts.MainPID!=='0'||facts.KillMode!=='process'||facts.ControlGroup&&facts.ControlGroup!==service.controlGroup)throw Error('The original user service changed or has another MainPID; no service was started');
 const script=path.join(p.stateDirectory,'core-releases',p.operationId+'.service-start.sh'),quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 fs.writeFileSync(script,'#!/bin/sh\ncd '+quote(p.cwd)+'\nexec env -i '+Object.entries(p.env).map(([key,value])=>quote(key+'='+value)).join(' ')+' '+quote(p.node)+' '+quote(path.join(p.releaseDirectory,'dist','headless-runtime-cli.js'))+' serve\n',{mode:0o700,flag:'wx'});
 const dropin=serviceDropin(service,p.operationId);fs.mkdirSync(path.dirname(dropin),{recursive:true,mode:0o700});
 fs.writeFileSync(dropin,'[Service]\nExecStart=\nExecStart='+JSON.stringify(script.replaceAll('%','%%'))+'\n',{mode:0o600,flag:'wx'});
 serviceControl(service,['daemon-reload']);serviceControl(service,['start',service.unit]);
 const started=serviceFacts(service),pid=Number(started.MainPID);
 if(started.Id!==service.unit||started.FragmentPath!==service.fragmentPath||started.ControlGroup!==service.controlGroup||!Number.isSafeInteger(pid)||pid<1)throw Error('The original user service did not confirm its new MainPID');
 fs.writeFileSync(lease,JSON.stringify({operationId:p.operationId,state:'started',processId:pid,unit:service.unit}));
 console.log(JSON.stringify({processId:pid}));
}else{
 const log=fs.openSync(path.join(p.stateDirectory,'core-releases',p.operationId+'.log'),'a',0o600);
 const child=cp.spawn(p.node,[path.join(p.releaseDirectory,'dist','headless-runtime-cli.js'),'serve'],{cwd:p.cwd,env:p.env,detached:true,stdio:['ignore',log,log]});
 child.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('spawn',()=>{fs.writeFileSync(lease,JSON.stringify({operationId:p.operationId,state:'started',processId:child.pid}));child.unref();console.log(JSON.stringify({processId:child.pid}));});
}
`
/** Releases only this operation's temporary service command after the original
 * service was verified and the persistent current release was selected. */
export const RELEASE_CORE_SERVICE_START = String.raw`
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const p=JSON.parse(fs.readFileSync(0,'utf8'));
` + USER_SERVICE_CONTROL + String.raw`
if(p.service){
 const facts=serviceFacts(p.service);
 if(facts.Id!==p.service.unit||facts.FragmentPath!==p.service.fragmentPath||facts.ControlGroup!==p.service.controlGroup||Number(facts.MainPID)!==p.processId)throw Error('The original user service changed; its temporary command was retained');
 const dropin=serviceDropin(p.service,p.operationId);
 if(fs.existsSync(dropin)){fs.unlinkSync(dropin);serviceControl(p.service,['daemon-reload']);}
 const script=path.join(p.stateDirectory,'core-releases',p.operationId+'.service-start.sh');
 if(fs.existsSync(script))fs.unlinkSync(script);
}
console.log(JSON.stringify({released:true}));
`
/** Names the release the serving Core runs, for an installed entry and its restart.
 * Written only after the new Core is confirmed; the rename is atomic. */
export const SELECT_CORE_RELEASE = String.raw`
const fs=require('node:fs'),path=require('node:path');
const p=JSON.parse(fs.readFileSync(0,'utf8')),releases=path.join(p.stateDirectory,'core-releases');
if(!/^[a-f0-9]{64}$/.test(p.digest))throw Error('Release identity is invalid');
if(JSON.parse(fs.readFileSync(path.join(releases,p.digest,'deployment.json'),'utf8')).digest!==p.digest)throw Error('Release identity mismatch');
const current=path.join(releases,'current'),next=current+'.'+p.operationId+'.next';
fs.rmSync(next,{force:true});fs.symlinkSync(p.digest,next);fs.renameSync(next,current);
const directory=fs.openSync(releases,'r');fs.fsyncSync(directory);fs.closeSync(directory);
console.log(JSON.stringify({current:fs.readlinkSync(current)}));
`
/** Stops one exact original Native after its Core has gone, then keeps a complete copy of
 * its state directory. Without stop it only confirms the process and room for the copy. A
 * process that survives its Native is reported, never signalled by a stored PID. */
export const REPLACE_NATIVE = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const p=JSON.parse(fs.readFileSync(0,'utf8')),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sleep=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
function birth(pid){try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(')').slice(1).join(')').trim().split(/\s+/);return stat[0]==='Z'?null:stat[19];}
 catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')return null;throw error;}}
function measure(directory){let bytes=0;
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const target=path.join(directory,entry.name);
  if(entry.isDirectory())bytes+=measure(target);
  else if(entry.isFile())bytes+=fs.statSync(target).size;
  else throw Error('The Native state holds an entry that cannot be copied: '+entry.name+'.');}
 return bytes;}
function copy(from,to){const mode=fs.statSync(from).mode&0o777;fs.mkdirSync(to,{mode});fs.chmodSync(to,mode);
 for(const entry of fs.readdirSync(from,{withFileTypes:true})){const source=path.join(from,entry.name),target=path.join(to,entry.name);
  if(entry.isDirectory()){copy(source,target);continue;}
  // The source no longer changes: its only writer has exited. Read it once and write the copy from those bytes.
  const bytes=fs.readFileSync(source),fd=fs.openSync(target,'wx',fs.statSync(source).mode&0o777);
  try{fs.writeFileSync(fd,bytes);fs.fchmodSync(fd,fs.statSync(source).mode&0o777);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  if(hash(fs.readFileSync(target))!==hash(bytes))throw Error('The Native state copy differs from '+entry.name);}
 const fd=fs.openSync(to,'r');fs.fsyncSync(fd);fs.closeSync(fd);}
function prepare(){
 const base='/proc/'+p.pid;
 if(birth(p.pid)!==p.startTicks||hash(fs.readFileSync(base+'/exe'))!==p.nativeSha256)throw Error('The original Native process changed.');
 // The copy needs the state's own size; the WAL ceiling stays free for the Native that starts next.
 const needed=measure(p.nativeStateDirectory)+p.reserveBytes,space=fs.statfsSync(p.stateDirectory),available=Number(space.bavail)*Number(space.bsize);
 if(available<needed)throw Error('Keeping a copy of the Native state needs '+needed+' free bytes; '+available+' are available.');
}
// A plan read fails like any read. A stop answers with its own outcome, so the caller can tell
// a confirmed refusal or copy failure from a lost reply.
if(!p.stop){prepare();console.log(JSON.stringify({ready:true}));}
else{
 try{prepare();}catch(error){console.log(JSON.stringify({outcome:'refused',detail:error.message}));process.exit(0);}
 const runs=new Map(p.runProcessIds.map(pid=>[pid,birth(pid)]));
 process.kill(p.pid,'SIGINT');
 let gone=false;for(let attempt=0;attempt<600&&!gone;attempt++){gone=birth(p.pid)!==p.startTicks;if(!gone)sleep(100);}
 if(!gone){console.log(JSON.stringify({outcome:'stop-unconfirmed'}));process.exit(0);}
 // Run processes receive SIGHUP when their terminals close; a short bounded observation lets them leave.
 const alive=()=>[...runs].filter(([pid,start])=>start!==null&&birth(pid)===start).map(([pid])=>pid);
 for(let attempt=0;attempt<30&&alive().length;attempt++)sleep(100);
 const partial=p.copyDirectory+'.partial';
 try{
  fs.mkdirSync(path.dirname(p.copyDirectory),{recursive:true,mode:0o700});fs.rmSync(partial,{recursive:true,force:true});
  copy(p.nativeStateDirectory,partial);fs.renameSync(partial,p.copyDirectory);
  const parent=fs.openSync(path.dirname(p.copyDirectory),'r');fs.fsyncSync(parent);fs.closeSync(parent);
 }catch(error){fs.rmSync(partial,{recursive:true,force:true});console.log(JSON.stringify({outcome:'copy-failed',detail:error.message}));process.exit(0);}
 console.log(JSON.stringify({outcome:'replaced',stateCopy:p.copyDirectory,survivingProcessIds:alive()}));
}
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
