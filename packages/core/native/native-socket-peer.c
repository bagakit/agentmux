/* Read-only Darwin socket identity and a connection to that same original peer.
 * libc/libproc ABI owns these facts. No command line/display strings are interpreted. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static void failure(const char *phase) {
  fprintf(stderr,"{\"code\":\"NATIVE_SOCKET_PEER_UNCONFIRMED\",\"phase\":\"%s\",\"errno\":null}\n",phase);
  exit(1);
}
static void syscall_failure(const char *phase) {
  int observed_errno=errno;
  fprintf(stderr,"{\"code\":\"NATIVE_SOCKET_PEER_UNCONFIRMED\",\"phase\":\"%s\",\"errno\":%d}\n",phase,observed_errno);
  exit(1);
}
struct endpoint_observation { struct stat value; const char *reason; int syscall_errno; };
/* Necessary candidate facts, never Native actor authority. Read once so a
 * successful predicate cannot borrow errno left by an unrelated observation. */
static struct endpoint_observation observe_endpoint(const char *path) {
  struct endpoint_observation result={0};
  if(lstat(path,&result.value)) { result.reason="stat-failed";result.syscall_errno=errno; }
  else if(!S_ISSOCK(result.value.st_mode)) result.reason="not-socket";
  else if(result.value.st_uid!=getuid()) result.reason="uid-mismatch";
  else if((result.value.st_mode&077)!=0) result.reason="permissions-mismatch";
  return result;
}
static void endpoint_failure(const char *phase,struct endpoint_observation observation) {
  fprintf(stderr,"{\"code\":\"NATIVE_SOCKET_PEER_UNCONFIRMED\",\"phase\":\"%s\",\"reason\":\"%s\",\"errno\":",phase,observation.reason);
  if(observation.syscall_errno) fprintf(stderr,"%d",observation.syscall_errno);
  else fputs("null",stderr);
  fprintf(stderr,",\"expectedUid\":%u",getuid());
  if(!observation.syscall_errno) fprintf(stderr,",\"stat\":{\"type\":%u,\"uid\":%u,\"mode\":%u}",
    observation.value.st_mode&S_IFMT,observation.value.st_uid,observation.value.st_mode&07777);
  fputs("}\n",stderr);exit(1);
}
static void quoted(const char *value) {
  putchar('"'); for (const unsigned char *at=(const unsigned char *)value; *at; at++) {
    if (*at=='"'||*at=='\\') { putchar('\\');putchar(*at); }
    else if (*at<32) printf("\\u%04x",*at); else putchar(*at);
  } putchar('"');
}
static struct proc_bsdinfo process(pid_t pid) {
  struct proc_bsdinfo value;
  if (proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&value,sizeof(value))!=sizeof(value) ||
      value.pbi_pid!=(uint32_t)pid || value.pbi_uid!=getuid() ||
      !value.pbi_start_tvsec || value.pbi_start_tvusec>=1000000) failure("process-owner");
  return value;
}
static struct socket_fdinfo socket_info(pid_t pid,int fd) {
  struct socket_fdinfo value;
  if (proc_pidfdinfo(pid,fd,PROC_PIDFDSOCKETINFO,&value,sizeof(value))!=sizeof(value)) failure("socket-metadata");
  if(value.psi.soi_family!=AF_UNIX || value.psi.soi_kind!=SOCKINFO_UN || value.psi.soi_type!=SOCK_STREAM || !(value.psi.soi_state&SOI_S_ISCONNECTED)) failure("connected-unix-stream");
  return value;
}
static struct proc_fdinfo *descriptors(pid_t pid,int *count) {
  int size=proc_pidinfo(pid,PROC_PIDLISTFDS,0,NULL,0);
  if(size<0)failure("descriptor-count");
  for(;;) {
    if(size>INT_MAX-(int)(16*sizeof(struct proc_fdinfo)))failure("descriptor-capacity");
    size+=(int)(16*sizeof(struct proc_fdinfo));
    struct proc_fdinfo *value=malloc((size_t)size); if(!value)failure("descriptor-memory");
    int used=proc_pidinfo(pid,PROC_PIDLISTFDS,0,value,size);
    if(used<0 || used%sizeof(struct proc_fdinfo))failure("descriptor-list");
    if(used<size) {*count=used/sizeof(struct proc_fdinfo);return value;}
    free(value);
  }
}
/* FD numbers are handles, not actor/connection identities. Only aliases of this
 * exact opaque socket pair in this exact process may replace the representative. */
static int object_descriptor(pid_t peer,uint64_t socket,uint64_t connected,const char *phase) {
  int count,found=-1;struct proc_fdinfo *fds=descriptors(peer,&count);
  for(int i=0;i<count;i++)if(fds[i].proc_fdtype==PROX_FDTYPE_SOCKET) {
    struct socket_fdinfo info;
    if(proc_pidfdinfo(peer,fds[i].proc_fd,PROC_PIDFDSOCKETINFO,&info,sizeof(info))!=sizeof(info))continue;
    if(info.psi.soi_family==AF_UNIX && info.psi.soi_kind==SOCKINFO_UN && info.psi.soi_type==SOCK_STREAM &&
       info.psi.soi_so==socket && info.psi.soi_proto.pri_un.unsi_conn_so==connected &&
       (info.psi.soi_state&SOI_S_ISCONNECTED)) {
      if(found<0||fds[i].proc_fd<found)found=fds[i].proc_fd;
    }
  }
  free(fds);if(found<0)failure(phase);return found;
}
struct original_connection {pid_t pid;int descriptor;struct socket_fdinfo value;char endpoint[sizeof(((struct sockaddr_un *)0)->sun_path)];};
static struct original_connection original_connection(pid_t root,const char *endpoint) {
  char selected[sizeof(((struct sockaddr_un *)0)->sun_path)]={0};
  int size=proc_listpids(PROC_PGRP_ONLY,(uint32_t)root,NULL,0);
  if(size<=0||size>INT_MAX-(int)(16*sizeof(pid_t)))failure("group-count");
  pid_t *pids=calloc(1,(size_t)size+16*sizeof(pid_t));if(!pids)failure("group-memory");
  int used=proc_listpids(PROC_PGRP_ONLY,(uint32_t)root,pids,size+16*sizeof(pid_t));
  if(used<=0||used>=size+(int)(16*sizeof(pid_t)))failure("group-changed");
  pid_t tui=0;int tui_fd=-1;struct socket_fdinfo original;
  for(int n=0;n<used/(int)sizeof(pid_t);n++)if(pids[n]>0) {
    int count;struct proc_fdinfo *fds=descriptors(pids[n],&count);
    for(int i=0;i<count;i++)if(fds[i].proc_fdtype==PROX_FDTYPE_SOCKET) {
      struct socket_fdinfo value;
      if(proc_pidfdinfo(pids[n],fds[i].proc_fd,PROC_PIDFDSOCKETINFO,&value,sizeof(value))!=sizeof(value))continue;
      if(value.psi.soi_family!=AF_UNIX||value.psi.soi_kind!=SOCKINFO_UN||value.psi.soi_type!=SOCK_STREAM||!(value.psi.soi_state&SOI_S_ISCONNECTED))continue;
      const struct sockaddr_un *peer=&value.psi.soi_proto.pri_un.unsi_caddr.ua_sun;
      if(peer->sun_family!=AF_UNIX||!memchr(peer->sun_path,0,sizeof(peer->sun_path))||peer->sun_path[0]!='/'||(endpoint[0]&&strcmp(peer->sun_path,endpoint)))continue;
      if(!endpoint[0]) {
        struct endpoint_observation candidate=observe_endpoint(peer->sun_path);
        if(candidate.reason) {
          if(candidate.syscall_errno && candidate.syscall_errno!=ENOENT) endpoint_failure("endpoint-observation",candidate);
          continue;
        }
      }
      if(!value.psi.soi_so||!value.psi.soi_proto.pri_un.unsi_conn_so)failure("opaque-peer-unavailable");
      if(tui) {
        if(tui!=pids[n]||original.psi.soi_so!=value.psi.soi_so||
           original.psi.soi_proto.pri_un.unsi_conn_so!=value.psi.soi_proto.pri_un.unsi_conn_so||strcmp(selected,peer->sun_path))failure("ambiguous-original-connection");
        if(fds[i].proc_fd<tui_fd)tui_fd=fds[i].proc_fd;
      } else {tui=pids[n];tui_fd=fds[i].proc_fd;original=value;strcpy(selected,peer->sun_path);}
    }
    free(fds);
  }
  free(pids);if(!tui)failure("original-connection-absent");
  struct original_connection result={.pid=tui,.descriptor=tui_fd,.value=original};strcpy(result.endpoint,selected);return result;
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
  if(argc==14 && !strcmp(argv[1],"--verify")) {
    struct endpoint_observation endpoint=observe_endpoint(argv[12]);
    if(endpoint.reason) endpoint_failure("endpoint-changed",endpoint);
    pid_t root=(pid_t)strtol(argv[2],NULL,10),tui=(pid_t)strtol(argv[3],NULL,10),peer=(pid_t)strtol(argv[4],NULL,10);
    struct proc_bsdinfo r=process(root),t=process(tui),p=process(peer);
    char birth[80];snprintf(birth,sizeof(birth),"%llu:%llu",r.pbi_start_tvsec,r.pbi_start_tvusec);if(strcmp(birth,argv[9]))failure("run-birth-changed");
    snprintf(birth,sizeof(birth),"%llu:%llu",t.pbi_start_tvsec,t.pbi_start_tvusec);if(strcmp(birth,argv[10]))failure("tui-birth-changed");
    snprintf(birth,sizeof(birth),"%llu:%llu",p.pbi_start_tvsec,p.pbi_start_tvusec);if(strcmp(birth,argv[11]))failure("peer-birth-changed");
    uint64_t tui_socket=strtoull(argv[7],NULL,10),peer_socket=strtoull(argv[8],NULL,10);
    if(!tui_socket||!peer_socket)failure("opaque-peer-unavailable");
    struct original_connection connected=original_connection(root,argv[12]);
    if(connected.pid!=tui)failure("original-association-changed");
    struct socket_fdinfo a=socket_info(tui,connected.descriptor),
      b=socket_info(peer,object_descriptor(peer,peer_socket,tui_socket,"original-peer-fd"));
    if(getpgid(root)!=root||getpgid(tui)!=root||a.psi.soi_so!=strtoull(argv[7],NULL,10)||b.psi.soi_so!=strtoull(argv[8],NULL,10)||
       a.psi.soi_proto.pri_un.unsi_conn_so!=b.psi.soi_so||b.psi.soi_proto.pri_un.unsi_conn_so!=a.psi.soi_so)failure("original-association-changed");
    endpoint=observe_endpoint(argv[12]);if(endpoint.reason)endpoint_failure("endpoint-changed",endpoint);
    struct stat path=endpoint.value;
    char identity[80];snprintf(identity,sizeof(identity),"%llu:%llu",(unsigned long long)path.st_dev,(unsigned long long)path.st_ino);if(strcmp(identity,argv[13]))failure("endpoint-changed");
    puts("{\"type\":\"native-socket-current\",\"schema\":1}");return 0;
  }
  if(argc!=5)failure("arguments");
  char *end=NULL;long number=strtol(argv[1],&end,10);
  if(!end||*end||number<=0||number>INT_MAX)failure("original-run");
  pid_t root=(pid_t)number;if(getpgid(root)!=root)failure("original-group");
  struct proc_bsdinfo root_before=process(root);
  if(argv[2][0] && argv[2][0]!='/')failure("endpoint");
  const char *endpoint=argv[2];struct stat path_before;
  if(endpoint[0]) { struct endpoint_observation requested=observe_endpoint(endpoint);
    if(requested.reason)endpoint_failure("endpoint-owner",requested); }
  struct original_connection connected=original_connection(root,endpoint);
  pid_t tui=connected.pid;int tui_fd=connected.descriptor;struct socket_fdinfo original=connected.value;endpoint=connected.endpoint;
  if(!original.psi.soi_so||!original.psi.soi_proto.pri_un.unsi_conn_so)failure("opaque-peer-unavailable");
  struct endpoint_observation selected_endpoint=observe_endpoint(endpoint);
  if(selected_endpoint.reason)endpoint_failure("endpoint-owner",selected_endpoint);
  path_before=selected_endpoint.value;
  struct proc_bsdinfo tui_before=process(tui);
  int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0)syscall_failure("connect-socket");
  struct sockaddr_un address={0};address.sun_family=AF_UNIX;
  if(strlen(endpoint)>=sizeof(address.sun_path))failure("endpoint-length");
  strcpy(address.sun_path,endpoint);address.sun_len=sizeof(address);
  if(connect(fd,(struct sockaddr *)&address,sizeof(address)))syscall_failure("connect-original-peer");
  pid_t peer=0;socklen_t length=sizeof(peer);
  if(getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,&peer,&length))syscall_failure("connected-peer-pid");
  if(length!=sizeof(peer)||peer<=0)failure("connected-peer-pid");
  uid_t uid;gid_t gid;if(getpeereid(fd,&uid,&gid))syscall_failure("connected-peer-uid");
  if(uid!=getuid())failure("connected-peer-uid");
  struct proc_bsdinfo peer_before=process(peer);
  tui_fd=object_descriptor(tui,original.psi.soi_so,original.psi.soi_proto.pri_un.unsi_conn_so,"original-tui-fd");
  int peer_fd=object_descriptor(peer,original.psi.soi_proto.pri_un.unsi_conn_so,original.psi.soi_so,"original-peer-fd");
  struct socket_fdinfo again=socket_info(tui,tui_fd),other=socket_info(peer,peer_fd);
  struct proc_bsdinfo root_after=process(root),tui_after=process(tui),peer_after=process(peer);
  selected_endpoint=observe_endpoint(endpoint);if(selected_endpoint.reason)endpoint_failure("endpoint-recheck",selected_endpoint);
  struct stat path_after=selected_endpoint.value;
  if(root_before.pbi_start_tvsec!=root_after.pbi_start_tvsec||root_before.pbi_start_tvusec!=root_after.pbi_start_tvusec||
     tui_before.pbi_start_tvsec!=tui_after.pbi_start_tvsec||tui_before.pbi_start_tvusec!=tui_after.pbi_start_tvusec||
     peer_before.pbi_start_tvsec!=peer_after.pbi_start_tvsec||peer_before.pbi_start_tvusec!=peer_after.pbi_start_tvusec||
     getpgid(root)!=root||getpgid(tui)!=root||path_before.st_dev!=path_after.st_dev||path_before.st_ino!=path_after.st_ino||
     again.psi.soi_so!=original.psi.soi_so||again.psi.soi_proto.pri_un.unsi_conn_so!=original.psi.soi_proto.pri_un.unsi_conn_so||
     other.psi.soi_so!=again.psi.soi_proto.pri_un.unsi_conn_so||other.psi.soi_proto.pri_un.unsi_conn_so!=again.psi.soi_so)failure("binding-changed");
  if(fcntl(fd,F_SETFD,0))syscall_failure("inherit-connection");
  printf("{\"type\":\"native-socket-binding\",\"schema\":1,\"fd\":%d,\"runPid\":%d,\"tuiPid\":%d,\"peerPid\":%d,\"uid\":%u,\"tuiFd\":%d,\"peerFd\":%d,\"tuiSocket\":\"%llu\",\"peerSocket\":\"%llu\",\"runBirth\":\"%llu:%llu\",\"tuiBirth\":\"%llu:%llu\",\"peerBirth\":\"%llu:%llu\",\"device\":\"%llu\",\"inode\":\"%llu\",\"endpoint\":",fd,root,tui,peer,uid,tui_fd,peer_fd,
    original.psi.soi_so,original.psi.soi_proto.pri_un.unsi_conn_so,root_before.pbi_start_tvsec,root_before.pbi_start_tvusec,tui_before.pbi_start_tvsec,tui_before.pbi_start_tvusec,peer_before.pbi_start_tvsec,peer_before.pbi_start_tvusec,(unsigned long long)path_before.st_dev,(unsigned long long)path_before.st_ino);
  quoted(endpoint);puts("}");fflush(stdout);
  char descriptor[32];snprintf(descriptor,sizeof(descriptor),"%d",fd);setenv("AGENTMUX_NATIVE_SOCKET_FD",descriptor,1);setenv("ELECTRON_RUN_AS_NODE","1",1);
  char *args[]={argv[3],argv[4],NULL};execv(argv[3],args);syscall_failure("transport-exec");
}
