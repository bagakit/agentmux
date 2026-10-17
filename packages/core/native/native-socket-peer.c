/* Read-only Darwin process identity. libc/libproc owns these facts. */
#include <libproc.h>
#include <sys/proc_info.h>
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
int main(int argc,char **argv) {
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
