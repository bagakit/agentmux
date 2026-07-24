#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

#include <libproc.h>

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: process-rusage <pid>\n");
    return 2;
  }

  errno = 0;
  char *end = NULL;
  const long parsed = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || parsed <= 1 || parsed > INT_MAX) {
    fprintf(stderr, "invalid pid\n");
    return 2;
  }

  struct rusage_info_v4 usage = {0};
  if (proc_pid_rusage((int)parsed, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
    perror("proc_pid_rusage");
    return 1;
  }

  printf("%" PRIu64 " %" PRIu64 "\n", usage.ri_user_time, usage.ri_system_time);
  return 0;
}
