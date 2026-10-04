/* Private SQLite VFS probe: delegates real file IO; counters and failures never enter product APIs. */
#include <sqlite3ext.h>
static const sqlite3_api_routines *engine;
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

typedef struct { sqlite3_file base; sqlite3_file *real; int relevant; } ProbeFile;
static sqlite3_vfs *parent;
static sqlite3_vfs probe;
static sqlite3_io_methods methods;
static char target[4096];
static sqlite3_int64 reads, readBytes, writes, writeBytes, syncs, dirSyncs, failures;
static int fault, skip;
static int relevant(const char *name) { return name && target[0] && strncmp(name,target,strlen(target))==0 && strncmp(name+strlen(target),".mutex.sqlite",13)!=0; }
static int fail(int kind) { if (fault != kind) return 0; if (skip > 0) { skip--; return 0; } fault=0; failures++; return 1; }
static int closeFile(sqlite3_file *f) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->xClose(p->real); }
static int readFile(sqlite3_file *f, void *b, int n, sqlite3_int64 at) {
  ProbeFile *p=(ProbeFile*)f;
  if(p->relevant) { reads++; readBytes+=n; if(fail(3)) return SQLITE_IOERR_READ; }
  return p->real->pMethods->xRead(p->real,b,n,at);
}
static int writeFile(sqlite3_file *f, const void *b, int n, sqlite3_int64 at) {
  ProbeFile *p=(ProbeFile*)f;
  if(p->relevant) { writes++; writeBytes+=n; if(fail(1)) {
    p->real->pMethods->xWrite(p->real,b,n>17?17:n,at); return SQLITE_IOERR_WRITE;
  }}
  return p->real->pMethods->xWrite(p->real,b,n,at);
}
static int syncFile(sqlite3_file *f,int flags) { ProbeFile *p=(ProbeFile*)f;
  if(p->relevant) { syncs++; if(fail(2)) return SQLITE_IOERR_FSYNC; }
  return p->real->pMethods->xSync(p->real,flags);
}
#define FORWARD0(name) static int name(sqlite3_file *f) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->name(p->real); }
static int truncateFile(sqlite3_file *f,sqlite3_int64 n) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->xTruncate(p->real,n); }
static int sizeFile(sqlite3_file *f,sqlite3_int64 *n) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->xFileSize(p->real,n); }
static int lockFile(sqlite3_file *f,int n) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->xLock(p->real,n); }
static int unlockFile(sqlite3_file *f,int n) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->xUnlock(p->real,n); }
static int reservedFile(sqlite3_file *f,int *n) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->xCheckReservedLock(p->real,n); }
static int controlFile(sqlite3_file *f,int op,void *n) { ProbeFile *p=(ProbeFile*)f; return p->real->pMethods->xFileControl(p->real,op,n); }
FORWARD0(xSectorSize)
FORWARD0(xDeviceCharacteristics)
static int openFile(sqlite3_vfs *v,const char *name,sqlite3_file *f,int flags,int *out) {
  ProbeFile *p=(ProbeFile*)f; memset(p,0,sizeof(*p)); p->real=(sqlite3_file*)((char*)f+sizeof(*p));
  int rc=parent->xOpen(parent,name,p->real,flags,out);
  if(rc==SQLITE_OK) { p->base.pMethods=&methods; p->relevant=relevant(name); }
  return rc;
}
static int deleteFile(sqlite3_vfs*v,const char*n,int syncDir) { if(relevant(n) && syncDir) dirSyncs++; return parent->xDelete(parent,n,syncDir); }
static int accessFile(sqlite3_vfs*v,const char*n,int f,int*out) { return parent->xAccess(parent,n,f,out); }
static int fullPath(sqlite3_vfs*v,const char*n,int len,char*out) { return parent->xFullPathname(parent,n,len,out); }
static void *dlOpen(sqlite3_vfs*v,const char*n) { return parent->xDlOpen(parent,n); }
static void dlError(sqlite3_vfs*v,int n,char*out) { parent->xDlError(parent,n,out); }
static void (*dlSym(sqlite3_vfs*v,void*h,const char*n))(void) { return parent->xDlSym(parent,h,n); }
static void dlClose(sqlite3_vfs*v,void*h) { parent->xDlClose(parent,h); }
static int randomBytes(sqlite3_vfs*v,int n,char*out) { return parent->xRandomness(parent,n,out); }
static int sleepTime(sqlite3_vfs*v,int n) { return parent->xSleep(parent,n); }
static int currentTime(sqlite3_vfs*v,double*out) { return parent->xCurrentTime(parent,out); }
static int lastError(sqlite3_vfs*v,int n,char*out) { return parent->xGetLastError?parent->xGetLastError(parent,n,out):0; }
static void pathFn(sqlite3_context*c,int n,sqlite3_value**v) { snprintf(target,sizeof(target),"%s",engine->value_text(v[0])); engine->result_int(c,1); }
static void resetFn(sqlite3_context*c,int n,sqlite3_value**v) { reads=readBytes=writes=writeBytes=syncs=dirSyncs=failures=0; fault=0; skip=0; engine->result_int(c,1); }
static void faultFn(sqlite3_context*c,int n,sqlite3_value**v) { const char*k=(const char*)engine->value_text(v[0]); fault=strcmp(k,"write")==0?1:strcmp(k,"sync")==0?2:3; skip=engine->value_int(v[1]); engine->result_int(c,1); }
static void restoreFn(sqlite3_context*c,int n,sqlite3_value**v) { engine->vfs_register(parent,1); engine->vfs_unregister(&probe); engine->result_int(c,1); }
static void statsFn(sqlite3_context*c,int n,sqlite3_value**v) { char result[512]; snprintf(result,sizeof(result),"{\"reads\":%lld,\"readBytes\":%lld,\"writes\":%lld,\"writeBytes\":%lld,\"syncs\":%lld,\"dirSyncs\":%lld,\"failures\":%lld}",reads,readBytes,writes,writeBytes,syncs,dirSyncs,failures); engine->result_text(c,result,-1,SQLITE_TRANSIENT); }
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(sqlite3 *db,char**error,const sqlite3_api_routines*api) {
  engine=api;
  parent=engine->vfs_find(0);
  methods=(sqlite3_io_methods){1,closeFile,readFile,writeFile,truncateFile,syncFile,sizeFile,lockFile,unlockFile,reservedFile,controlFile,xSectorSize,xDeviceCharacteristics};
  probe=(sqlite3_vfs){1,(int)(sizeof(ProbeFile)+parent->szOsFile),parent->mxPathname,0,"amux-private-probe",0,openFile,deleteFile,accessFile,fullPath,dlOpen,dlError,dlSym,dlClose,randomBytes,sleepTime,currentTime,lastError};
  engine->vfs_register(&probe,1);
  engine->create_function(db,"amux_io_path",1,SQLITE_UTF8,0,pathFn,0,0);
  engine->create_function(db,"amux_io_reset",0,SQLITE_UTF8,0,resetFn,0,0);
  engine->create_function(db,"amux_io_fault",2,SQLITE_UTF8,0,faultFn,0,0);
  engine->create_function(db,"amux_io_restore",0,SQLITE_UTF8,0,restoreFn,0,0);
  return engine->create_function(db,"amux_io_stats",0,SQLITE_UTF8,0,statsFn,0,0);
}
