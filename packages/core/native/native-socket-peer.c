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
