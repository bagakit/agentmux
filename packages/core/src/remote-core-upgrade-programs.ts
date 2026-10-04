/** These programs are transported as single quoted argv by ExecutionHost. They
 * have no shell interpolation, provider branches, or access to Agent credentials. */
export const INSPECT_CORE_OWNER = String.raw`
import json,os,sys,hashlib,platform
p=json.loads(sys.stdin.read()); pid=p['pid']; base='/proc/'+str(pid)
def text(path):
 with open(path) as f: return f.read()
def sha(path):
 with open(path,'rb') as f: return hashlib.sha256(f.read()).hexdigest()
if not sys.platform.startswith('linux') or platform.machine() not in ['x86_64','amd64']: raise RuntimeError('Only Linux x64 headless owners have qualified process inspection.')
start=text(base+'/stat').rsplit(')',1)[1].split()[19]
argv=open(base+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))
exe=os.readlink(base+'/exe'); cwd=os.readlink(base+'/cwd')
if len(argv)!=3 or argv[2]!='serve' or not argv[1].endswith('/dist/headless-runtime-cli.js') or os.path.realpath(argv[0])!=exe:
 raise RuntimeError('This owner has no qualified headless launch identity.')
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
if p['socket'] != os.path.join(runtime,'control.sock') or p['store']!=store: raise RuntimeError('Endpoint/Store does not match owner namespace.')
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
deployment=json.loads(text(os.path.join(root,'deployment.json'))).get('digest') if os.path.isfile(os.path.join(root,'deployment.json')) else None
native_socket=os.path.join(runtime,'ctxmux.sock'); inodes=[]
for line in text('/proc/net/unix').splitlines()[1:]:
 row=line.split(None,7)
 if len(row)==8 and row[7]==native_socket and row[3]=='00010000': inodes.append(row[6])
if len(inodes)!=1: raise RuntimeError('The exact Native listener is not uniquely verified.')
native_pids=[]
for entry in os.listdir('/proc'):
 if not entry.isdigit(): continue
 directory='/proc/'+entry
 try:
  if os.stat(directory).st_uid!=os.getuid(): continue
  for fd in os.listdir(directory+'/fd'):
   try:
    if os.readlink(directory+'/fd/'+fd)=='socket:['+inodes[0]+']': native_pids.append(int(entry)); break
   except FileNotFoundError: pass
 except (FileNotFoundError,PermissionError): pass
if len(native_pids)!=1 or p.get('nativePid') not in [None,native_pids[0]]: raise RuntimeError('The Native listener process is not uniquely verified.')
native_pid=native_pids[0]; native_base='/proc/'+str(native_pid)
native_argv=open(native_base+'/cmdline','rb').read().decode().rstrip(chr(0)).split(chr(0))
def flag(name):
 if native_argv.count(name)!=1: raise RuntimeError('Native launch namespace is ambiguous.')
 return native_argv[native_argv.index(name)+1]
if flag('--socket')!=native_socket or flag('--state-dir')!=os.path.join(state,'ctxmux'): raise RuntimeError('Native listener namespace differs from the original Core.')
native_start=text(native_base+'/stat').rsplit(')',1)[1].split()[19]
native_sha=sha(native_base+'/exe')
print(json.dumps({'node':exe,'cli':argv[1],'cwd':cwd,'startTicks':start,'env':env,'stateDirectory':state,'runtimeDirectory':runtime,'storePath':store,'nativeSha256':native_sha,'nativeProcessId':native_pid,'nativeStartTicks':native_start,'platform':'linux-x64','deploymentDigest':deployment}))
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
const command=path.join(root,'bin','agentmux-public');fs.writeFileSync(command,'#!/bin/sh\nexec '+quote(p.node)+' '+quote(path.join(root,'dist','agentmux.js'))+' "$@"\n',{mode:0o755});
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
