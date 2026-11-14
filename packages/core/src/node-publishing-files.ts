import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentMuxError } from './errors.js';
export type NodeDirectoryWitness = {
    path: string;
    device: string;
    inode: string;
};
export type NodePublishedRead = {
    root: NodeDirectoryWitness;
    directory: NodeDirectoryWitness;
    logicalDirectory: string;
    denied: string[];
    action: 'list' | 'read';
    name: string;
    offset: number;
    limit: number;
    maxBytes: number;
    expectedRevision?: string;
};
// The kernel pins cwd before executing Node. Every filesystem operation below is
// relative to that directory; public input cannot select an executable or write.
const READER = String.raw `
import { open, opendir, stat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';import { resolve,sep } from 'node:path';import {createHash} from 'node:crypto';
const p=JSON.parse(process.argv[1]),inside=(root,path)=>path===root||path.startsWith(root===sep?root:root+sep);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code})};
const denied=(path)=>p.denied.some(root=>inside(root,path));
const witness=async(path)=>{const s=await stat(path,{bigint:true});return {device:String(s.dev),inode:String(s.ino),revision:createHash('sha256').update([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')).digest('hex')}};
async function guard(){
 const cwd=await realpath('.'),root=await realpath(p.root.path),a=await witness('.'),b=await witness(root);
 if(cwd!==p.directory.path||root!==p.root.path||!inside(root,cwd)||a.device!==p.directory.device||a.inode!==p.directory.inode||b.device!==p.root.device||b.inode!==p.root.inode)fail('NODE_PATH_CHANGED','The original shared directory changed. Refresh the published root.');
 if(denied(cwd)||denied(p.logicalDirectory))fail('NODE_PATH_DENIED','This path is excluded from the Node publication.');
}
try{
 await guard();let result;
 if(p.action==='list'){
  const before=await witness('.');if(p.expectedRevision&&p.expectedRevision!==before.revision)fail('NODE_DIRECTORY_CHANGED','This directory changed. Read a new first page.');
  const entries=[];let visible=0,more=false;const directory=await opendir('.');
  for await(const entry of directory){
   const logical=resolve(p.logicalDirectory,entry.name),actual=resolve(process.cwd(),entry.name);
   if(denied(logical)||denied(actual))continue;
   // Never reveal the target of a link which escapes or enters an excluded path.
   if(entry.isSymbolicLink()){try{const target=await realpath(entry.name);if(!inside(p.root.path,target)||denied(target))continue}catch{continue}}
   if(visible++<p.offset)continue;if(entries.length===p.limit){more=true;break}
   entries.push({name:entry.name,kind:entry.isFile()?'file':entry.isDirectory()?'directory':entry.isSymbolicLink()?'link':'other'});
  }
  await guard();if((await witness('.')).revision!==before.revision)fail('NODE_DIRECTORY_CHANGED','This directory changed during the read. Read a new first page.');
  result={entries,offset:p.offset,nextOffset:more?p.offset+entries.length:null,truncated:more,revision:before.revision};
 }else{
  const handle=await open(p.name,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const s=await handle.stat({bigint:true});if(!s.isFile())fail('NODE_FILE_UNSUPPORTED','Choose a regular published file.');
   const revision=createHash('sha256').update([s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':')).digest('hex');
   const check=async()=>{await guard();const actual=await realpath(p.name),named=await stat(p.name,{bigint:true});if(!inside(p.root.path,actual)||denied(actual)||denied(resolve(p.logicalDirectory,p.name)))fail('NODE_PATH_DENIED','This path is excluded from the Node publication.');if(named.dev!==s.dev||named.ino!==s.ino)fail('NODE_PATH_CHANGED','The original shared file changed. Refresh the published root.');};
   await check();if(p.expectedRevision&&p.expectedRevision!==revision)fail('NODE_FILE_CHANGED','This shared file changed. Read its original first block again.');
   const totalBytes=Number(s.size);if(!Number.isSafeInteger(totalBytes)||p.offset>totalBytes)fail('INVALID_CONTROL_REQUEST','Choose an offset inside the original file.');
   const bytes=Buffer.alloc(Math.min(p.maxBytes,totalBytes-p.offset));const {bytesRead}=await handle.read(bytes,0,bytes.length,p.offset);
   await check();const after=await handle.stat({bigint:true});if([after.dev,after.ino,after.size,after.mtimeNs,after.ctimeNs].join(':')!==[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':'))fail('NODE_FILE_CHANGED','This shared file changed during the read. Read its original first block again.');
   result={encoding:'base64',data:bytes.subarray(0,bytesRead).toString('base64'),totalBytes,offset:p.offset,nextOffset:p.offset+bytesRead<totalBytes?p.offset+bytesRead:null,revision};
  }finally{await handle.close()}
 }
 process.stdout.write(JSON.stringify({result}));
}catch(error){process.stdout.write(JSON.stringify({error:{code:typeof error.code==='string'?error.code:'NODE_READ_UNAVAILABLE',message:error.code?.startsWith('NODE_')||error.code==='INVALID_CONTROL_REQUEST'?error.message:'The shared resource is unavailable. Refresh its published root and original path.'}}));}
`;
export async function readNodePublishedDirectory(input: NodePublishedRead, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_OPTIONS;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', READER, JSON.stringify(input)], {
        cwd: input.directory.path, env, ...(signal ? { signal } : {}), maxBuffer: 1024 * 1024, encoding: 'utf8'
    });
    signal?.throwIfAborted();
    const result = JSON.parse(stdout) as {
        error?: {
            code: string;
            message: string;
        };
        result?: unknown;
    };
    if (result.error)
        throw new AgentMuxError(result.error.message, result.error.code);
    return result.result;
}
