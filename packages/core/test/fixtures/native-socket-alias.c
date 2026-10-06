/* Test-owned OS carrier, not a vendor Native protocol implementation. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static volatile sig_atomic_t action;
static void requested(int signum){action=signum;}
static void facts(const char *role,int fd){
  struct socket_fdinfo value;
  if(proc_pidfdinfo(getpid(),fd,PROC_PIDFDSOCKETINFO,&value,sizeof(value))!=sizeof(value))exit(3);
  printf("{\"role\":\"%s\",\"pid\":%d,\"fd\":%d,\"so\":\"%llu\",\"conn\":\"%llu\"}\n",role,getpid(),fd,value.psi.soi_so,value.psi.soi_proto.pri_un.unsi_conn_so);fflush(stdout);
}
static int connect_to(struct sockaddr_un *address){int fd=socket(AF_UNIX,SOCK_STREAM,0);if(fd<0||connect(fd,(struct sockaddr*)address,sizeof(*address)))exit(2);return fd;}
int main(int argc,char **argv){
  if(argc!=3)return 2;
  struct sockaddr_un address={0};address.sun_family=AF_UNIX;address.sun_len=sizeof(address);strcpy(address.sun_path,argv[1]);
  int listener=socket(AF_UNIX,SOCK_STREAM,0);
  if(listener<0||bind(listener,(struct sockaddr*)&address,sizeof(address))||chmod(argv[1],0600)||listen(listener,16))return 2;
  signal(SIGUSR1,requested);signal(SIGUSR2,requested);
  pid_t tui=fork();
  if(tui==0){
    close(listener);int fd=connect_to(&address);facts("tui",fd);
    if(!strcmp(argv[2],"tui-dup")||!strcmp(argv[2],"both-dup")){int alias=dup(fd);if(alias<0)exit(2);facts("tui-alias",alias);}
    if(!strcmp(argv[2],"distinct")){int second=connect_to(&address);facts("tui-distinct",second);}
    if(!strcmp(argv[2],"inherited-other-pid")){pid_t other=fork();if(other<0)exit(2);if(other==0){facts("inherited-other-pid",fd);for(;;)pause();}}
    for(;;){
      if(action==SIGUSR1){int alias=dup(fd);if(alias<0)exit(2);close(fd);fd=alias;action=0;facts("tui-current-alias",fd);}
      else if(action==SIGUSR2){int second=connect_to(&address);action=0;facts("tui-late-distinct",second);}
      pause();
    }
  }
  if(tui<0)return 2;
  int fd=accept(listener,NULL,NULL);if(fd<0)return 2;facts("peer",fd);
  if(!strcmp(argv[2],"peer-dup")||!strcmp(argv[2],"both-dup")){int alias=dup(fd);if(alias<0)return 2;facts("peer-alias",alias);}
  if(!strcmp(argv[2],"distinct")){int second=accept(listener,NULL,NULL);if(second<0)return 2;facts("peer-distinct",second);}
  usleep(100000);puts("{\"ready\":true}");fflush(stdout);
  for(;;){int observer=accept(listener,NULL,NULL);if(observer<0)return 2;
    if(action==SIGUSR1){int alias=dup(fd);if(alias<0)return 2;close(fd);fd=alias;action=0;facts("peer-current-alias",fd);}
    facts("observer-peer",observer);
  }
}
