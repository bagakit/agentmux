#define _DARWIN_C_SOURCE
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/stdio.h>
#else
#error "Atomic confined no-replace Workspace move is unavailable on this platform"
#endif

static void fail_with_errno(const char *operation) {
  fprintf(stderr, "errno=%d operation=%s message=%s\n", errno, operation, strerror(errno));
  exit(1);
}

static unsigned long long parse_identity(const char *value, const char *label) {
  char *end = NULL;
  errno = 0;
  const unsigned long long parsed = strtoull(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0') {
    fprintf(stderr, "invalid %s\n", label);
    exit(64);
  }
  return parsed;
}

static void validate_relative_path(const char *relative_path) {
  if (relative_path[0] == '\0' || relative_path[0] == '/') {
    errno = EINVAL;
    fail_with_errno("validate-path");
  }
  char *storage = strdup(relative_path);
  if (storage == NULL) fail_with_errno("strdup");
  char *cursor = storage;
  while (cursor != NULL) {
    char *slash = strchr(cursor, '/');
    if (slash != NULL) *slash = '\0';
    if (cursor[0] == '\0' || strcmp(cursor, ".") == 0 || strcmp(cursor, "..") == 0) {
      free(storage);
      errno = EINVAL;
      fail_with_errno("validate-segment");
    }
    cursor = slash == NULL ? NULL : slash + 1;
  }
  free(storage);
}

static int atomic_move_no_replace(
  int root_fd,
  const char *source_path,
  const char *destination_path
) {
  return renameatx_np(
    root_fd,
    source_path,
    root_fd,
    destination_path,
    RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH
  );
}

int main(int argc, char **argv) {
  if (argc < 6 || argc > 8) {
    fprintf(
      stderr,
      "usage: workspace-move <root> <dev> <ino> <source> <destination> "
      "[--before-commit-barrier] [--after-commit-barrier]\n"
    );
    return 64;
  }
  int before_commit_barrier = 0;
  int after_commit_barrier = 0;
  for (int index = 6; index < argc; index += 1) {
    if (strcmp(argv[index], "--before-commit-barrier") == 0) {
      before_commit_barrier = 1;
    } else if (strcmp(argv[index], "--after-commit-barrier") == 0) {
      after_commit_barrier = 1;
    } else {
      errno = EINVAL;
      fail_with_errno("validate-barrier");
    }
  }
  const int root_fd = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root_fd < 0) fail_with_errno("open-root");
  struct stat root_info;
  if (fstat(root_fd, &root_info) != 0) fail_with_errno("stat-root");
  const unsigned long long expected_dev = parse_identity(argv[2], "root device");
  const unsigned long long expected_ino = parse_identity(argv[3], "root inode");
  if ((unsigned long long)root_info.st_dev != expected_dev ||
      (unsigned long long)root_info.st_ino != expected_ino) {
    errno = ESTALE;
    fail_with_errno("verify-root");
  }

  validate_relative_path(argv[4]);
  validate_relative_path(argv[5]);
  struct stat existing;
  if (fstatat(
        root_fd,
        argv[5],
        &existing,
        AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH
      ) == 0) {
    errno = EEXIST;
    fail_with_errno("verify-destination-absent");
  }
  if (errno != ENOENT) fail_with_errno("verify-destination-absent");

  if (before_commit_barrier) {
    char signal = 'R';
    if (write(3, &signal, 1) != 1) fail_with_errno("before-commit-ready");
    if (read(4, &signal, 1) != 1) fail_with_errno("before-commit-release");
  }

  if (atomic_move_no_replace(
        root_fd,
        argv[4],
        argv[5]
      ) != 0) {
    fail_with_errno("move-no-replace");
  }

  if (after_commit_barrier) {
    char signal = 'C';
    if (write(5, &signal, 1) != 1) fail_with_errno("after-commit-ready");
    if (read(6, &signal, 1) != 1) fail_with_errno("after-commit-release");
  }

  close(root_fd);
  return 0;
}
