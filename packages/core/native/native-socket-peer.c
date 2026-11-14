/* Read-only Darwin process identity. libc/libproc owns these facts. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static void failure(const char *phase) {
  fprintf(stderr,"{\"code\":\"NATIVE_SOCKET_PEER_UNCONFIRMED\",\"phase\":\"%s\",\"errno\":null}\n",phase);
  exit(1);
}
static struct proc_bsdinfo process(pid_t pid) {
  struct proc_bsdinfo value;
  if (proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&value,sizeof(value))!=sizeof(value) ||
      value.pbi_pid!=(uint32_t)pid || value.pbi_uid!=getuid() ||
      !value.pbi_start_tvsec || value.pbi_start_tvusec>=1000000) failure("process-owner");
  return value;
}
static void process_environment(pid_t pid) {
  struct proc_bsdinfo before=process(pid);
  int maximum=0,limit_mib[2]={CTL_KERN,KERN_ARGMAX};size_t limit_size=sizeof(maximum);
  if(sysctl(limit_mib,2,&maximum,&limit_size,NULL,0)!=0 || limit_size!=sizeof(maximum) || maximum<=(int)sizeof(int)) failure("environment-limit");
  unsigned char *buffer=malloc((size_t)maximum);
  if(!buffer)failure("environment-memory");
  int mib[3]={CTL_KERN,KERN_PROCARGS2,pid};size_t length=(size_t)maximum;
  if(sysctl(mib,3,buffer,&length,NULL,0)!=0 || length>(size_t)maximum || length<sizeof(int)) failure("process-environment");
  int count=0;memcpy(&count,buffer,sizeof(count));
  if(count<1 || (size_t)count>length-sizeof(count))failure("environment-arguments");
  unsigned char *cursor=buffer+sizeof(count),*end=buffer+length,*nul=memchr(cursor,0,(size_t)(end-cursor));
  if(!nul)failure("environment-executable");
  cursor=nul+1;
  /* KERN_PROCARGS2 puts padding after the executable path, then exactly argc argv strings. */
  while(cursor<end && !*cursor)cursor++;
  for(int i=0;i<count;i++) {
    if(cursor>=end || !(nul=memchr(cursor,0,(size_t)(end-cursor))))failure("environment-arguments");
    cursor=nul+1;
  }
  unsigned char *environment=cursor;
  while(cursor<end && *cursor) {
    nul=memchr(cursor,0,(size_t)(end-cursor));
    if(!nul || !memchr(cursor,'=',(size_t)(nul-cursor)))failure("environment-record");
    cursor=nul+1;
  }
  size_t environment_length=(size_t)(cursor-environment);
  /* The empty string ends environ. Darwin's later Apple auxiliary strings are not environment. */
  /* Restricted processes can redact this region to empty; that cannot prove an empty launch environment. */
  if(!environment_length)failure("environment-unavailable");
  struct proc_bsdinfo after=process(pid);
  if(before.pbi_start_tvsec!=after.pbi_start_tvsec || before.pbi_start_tvusec!=after.pbi_start_tvusec)failure("process-generation");
  printf("{\"type\":\"native-process-environment\",\"schema\":1,\"pid\":%u,\"uid\":%u,\"startSec\":\"%llu\",\"startUsec\":\"%llu\",\"environmentHex\":\"",
    after.pbi_pid,after.pbi_uid,after.pbi_start_tvsec,after.pbi_start_tvusec);
  for(size_t i=0;i<environment_length;i++)printf("%02x",environment[i]);
  printf("\"}\n");free(buffer);
}
int main(int argc,char **argv) {
  if(argc==3 && !strcmp(argv[1],"--process-environment")) {
    char *end=NULL;long number=strtol(argv[2],&end,10);
    if(!end||*end||number<=0||number>INT_MAX)failure("original-process");
    process_environment((pid_t)number);
    return 0;
  }
  if(argc==2 && !strcmp(argv[1],"--socket-peer")) {
    pid_t pid=0; socklen_t length=sizeof(pid); uid_t uid; gid_t gid;
    if(getsockopt(STDIN_FILENO,SOL_LOCAL,LOCAL_PEERPID,&pid,&length)!=0 ||
        length!=sizeof(pid) || pid<=0 || getpeereid(STDIN_FILENO,&uid,&gid)!=0 || uid!=getuid()) failure("socket-peer");
    struct proc_bsdinfo value=process(pid);
    printf("{\"type\":\"native-socket-peer\",\"schema\":1,\"pid\":%u,\"uid\":%u,\"startSec\":\"%llu\",\"startUsec\":\"%llu\"}\n",
      value.pbi_pid,value.pbi_uid,value.pbi_start_tvsec,value.pbi_start_tvusec);
    return 0;
  }
  if(argc==3 && !strcmp(argv[1],"--process-executable")) {
    char *end=NULL;long number=strtol(argv[2],&end,10);
    if(!end||*end||number<=0||number>INT_MAX)failure("original-process");
    struct proc_bsdinfo before=process((pid_t)number);
    char path[PROC_PIDPATHINFO_MAXSIZE];
    int length=proc_pidpath((pid_t)number,path,sizeof(path));
    if(length<=0 || length>=(int)sizeof(path) || path[0]!='/')failure("process-executable");
    struct proc_bsdinfo after=process((pid_t)number);
    if(before.pbi_start_tvsec!=after.pbi_start_tvsec || before.pbi_start_tvusec!=after.pbi_start_tvusec)failure("process-generation");
    printf("{\"type\":\"native-process-executable\",\"schema\":1,\"pid\":%u,\"uid\":%u,\"pathHex\":\"",after.pbi_pid,after.pbi_uid);
    for(size_t i=0;path[i];i++)printf("%02x",(unsigned char)path[i]);
    printf("\"}\n");
    return 0;
  }
  if(argc==3 && !strcmp(argv[1],"--process-identity")) {
    char *end=NULL;long number=strtol(argv[2],&end,10);
    if(!end||*end||number<=0||number>INT_MAX)failure("original-process");
    struct proc_bsdinfo value=process((pid_t)number);
    printf("{\"type\":\"native-process-identity\",\"schema\":1,\"pid\":%u,\"uid\":%u,\"startSec\":\"%llu\",\"startUsec\":\"%llu\"}\n",
      value.pbi_pid,value.pbi_uid,value.pbi_start_tvsec,value.pbi_start_tvusec);
    return 0;
  }
  failure("arguments");
}
