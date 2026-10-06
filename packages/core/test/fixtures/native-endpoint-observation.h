/* Test-only syscall observation seam compiled over the actual production C.
 * No root peer, production flags, user socket or copied candidate algorithm. */
#include <sys/stat.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
static int endpoint_fixture_lstat(const char *path,struct stat *value) {
  int result=fstatat(AT_FDCWD,path,value,AT_SYMLINK_NOFOLLOW);
  const char *target=getenv("AMX_ENDPOINT_FIXTURE_PATH"),*fault=getenv("AMX_ENDPOINT_FIXTURE_FAULT");
  if(!target||strcmp(path,target)||!fault)return result;
  if(!strcmp(fault,"EIO")){errno=EIO;return -1;}
  if(!strcmp(fault,"EACCES")){errno=EACCES;return -1;}
  /* Isolate the UID predicate with controlled private mode; neither fact is an
   * observation of a real root-owned peer. The underlying socket is same-UID. */
  if(result==0&&!strcmp(fault,"root-uid")){value->st_uid=0;value->st_mode=(value->st_mode&~0777)|0600;}
  return result;
}
#define lstat endpoint_fixture_lstat
