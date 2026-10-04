#define _DARWIN_C_SOURCE
#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <sys/stdio.h>
#include <CommonCrypto/CommonDigest.h>
#else
#error "Atomic confined no-replace Workspace move is unavailable on this platform"
#endif

static _Noreturn void fail_with_errno(const char *operation) {
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

static void commit_barrier(int enabled, int ready_fd, int release_fd, const char *phase) {
  if (!enabled) return;
  char signal = 'R';
  if (write(ready_fd, &signal, 1) != 1) fail_with_errno(phase);
  if (read(release_fd, &signal, 1) != 1) fail_with_errno(phase);
}

typedef struct { char *storage, *parent, *name; } direct_entry;

/* The caller owns object meaning. The helper confines two actual directory entries. */
static direct_entry direct_relative_entry(const char *path) {
  validate_relative_path(path);
  direct_entry entry = { .storage = strdup(path) };
  if (!entry.storage) fail_with_errno("allocate-direct-entry");
  char *slash = strchr(entry.storage, '/');
  if (!slash || strchr(slash + 1, '/')) { errno = EINVAL; fail_with_errno("validate-direct-entry"); }
  *slash = '\0'; entry.parent = entry.storage; entry.name = slash + 1;
  return entry;
}

typedef struct {
  const char *current, *pending, *stage, *digest;
  unsigned long long parent_dev, parent_ino, record_dev, record_ino;
} alias_witness;

static int file_exists(int fd, const char *name);
static int file_matches(int fd, const char *name, unsigned long long dev,
                        unsigned long long ino, const char *digest, int sync_file);
static void restore_claim(int fd, const char *pending, const char *current, const char *phase);

static void verify_entry(int fd, const char *name, const struct stat *expected, int directory,
                         const char *operation) {
  struct stat current;
  if (fstatat(fd, name, &current, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) != 0) {
    fail_with_errno(operation);
  }
  if (current.st_dev != expected->st_dev || current.st_ino != expected->st_ino ||
      (directory ? !S_ISDIR(current.st_mode) : !S_ISLNK(current.st_mode))) {
    errno = ESTALE;
    fail_with_errno(operation);
  }
}

static void verify_link(int fd, const char *name, const char *text, const struct stat *expected,
                        const char *operation) {
  if (expected) verify_entry(fd, name, expected, 0, operation);
  const size_t size = strlen(text) + 1;
  char *observed = malloc(size);
  if (!observed) fail_with_errno("allocate-alias-observation");
  const ssize_t length = readlinkat(fd, name, observed, size);
  if (length < 0) fail_with_errno(operation);
  if ((size_t)length != strlen(text) || memcmp(observed, text, (size_t)length) != 0) {
    errno = ESTALE; fail_with_errno(operation);
  }
  free(observed);
}

static void atomic_alias_swap(int root_fd, const char *root_path, const char *source, const char *destination,
                              unsigned long long expected_dev, unsigned long long expected_ino,
                              int before_barrier, int after_barrier, int witness_barrier,
                              int finalize_barrier, int swap_barrier, int sync_fault, const alias_witness *witness) {
  direct_entry from = direct_relative_entry(source), to = direct_relative_entry(destination);
  if (strcmp(source, destination) == 0) { errno = EINVAL; fail_with_errno("validate-distinct-alias"); }
  const int source_fd = openat(root_fd, from.parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (source_fd < 0) fail_with_errno("open-alias-source-parent");
  const int destination_fd = openat(root_fd, to.parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (destination_fd < 0) fail_with_errno("open-alias-destination-parent");
  struct stat root, source_parent, destination_parent, original, existing;
  if (fstat(root_fd, &root) != 0 || fstat(source_fd, &source_parent) != 0 || fstat(destination_fd, &destination_parent) != 0) {
    fail_with_errno("stat-alias-parent");
  }
  verify_entry(root_fd, from.parent, &source_parent, 1, "verify-alias-source-parent");
  verify_entry(root_fd, to.parent, &destination_parent, 1, "verify-alias-destination-parent");
  struct stat source_entry;
  if (fstatat(source_fd, from.name, &source_entry, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) != 0) {
    fail_with_errno("stat-alias-source");
  }
  int committed = S_ISLNK(source_entry.st_mode);
  if (committed) {
    if (!witness || fstatat(destination_fd, to.name, &original, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) != 0)
      fail_with_errno("verify-alias-source");
  } else original = source_entry;
  if (!S_ISDIR(original.st_mode) || (unsigned long long)original.st_dev != expected_dev ||
      (unsigned long long)original.st_ino != expected_ino) {
    errno = ESTALE;
    fail_with_errno("verify-alias-source");
  }
  if (original.st_dev != destination_parent.st_dev) {
    errno = EXDEV;
    fail_with_errno("verify-alias-device");
  }
  /* Same-object helpers serialize on the original directory, without a lock file. */
  const int object_fd = openat(committed ? destination_fd : source_fd, committed ? to.name : from.name,
                              O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (object_fd < 0 || flock(object_fd, LOCK_EX) != 0) fail_with_errno("lock-alias-object");
  struct stat locked;
  if (fstat(object_fd, &locked) != 0 || locked.st_dev != original.st_dev || locked.st_ino != original.st_ino) {
    errno = ESTALE; fail_with_errno("verify-locked-alias-object");
  }
  verify_entry(root_fd, from.parent, &source_parent, 1, "verify-locked-source-parent");
  verify_entry(root_fd, to.parent, &destination_parent, 1, "verify-locked-destination-parent");
  if (fstatat(source_fd, from.name, &source_entry, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) != 0)
    fail_with_errno("verify-locked-source");
  committed = S_ISLNK(source_entry.st_mode);
  if (committed) verify_entry(destination_fd, to.name, &original, 1, "verify-locked-destination");
  else verify_entry(source_fd, from.name, &original, 1, "verify-locked-source");
  const size_t link_size = strlen(to.parent) + strlen(to.name) + 5;
  char *link_text = malloc(link_size);
  if (link_text == NULL) fail_with_errno("allocate-alias-link");
  snprintf(link_text, link_size, "../%s/%s", to.parent, to.name);
  int meta_fd = -1, already_confirmed = 0;
  struct stat meta;
  direct_entry current = {0}, pending = {0}, stage = {0};
  struct stat staged;
  if (witness) {
    current = direct_relative_entry(witness->current); pending = direct_relative_entry(witness->pending);
    stage = direct_relative_entry(witness->stage);
    if (strcmp(current.parent, pending.parent) || strcmp(current.parent, stage.parent) ||
        !strcmp(current.name, pending.name) || !strcmp(current.name, stage.name) || !strcmp(pending.name, stage.name)) {
      errno = EINVAL; fail_with_errno("validate-alias-witness-siblings");
    }
    meta_fd = openat(object_fd, current.parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (meta_fd < 0 || fstat(meta_fd, &meta) != 0) fail_with_errno("open-alias-witness-parent");
    if ((unsigned long long)meta.st_dev != witness->parent_dev || (unsigned long long)meta.st_ino != witness->parent_ino) {
      errno = ESTALE; fail_with_errno("verify-alias-witness-parent");
    }
    const int has_pending = file_exists(meta_fd, pending.name), has_stage = file_exists(meta_fd, stage.name);
    if (has_pending != has_stage) {
      errno = ESTALE; fail_with_errno("alias-witness-incomplete");
    }
    already_confirmed = committed && !has_pending;
    if (already_confirmed) {
      if (!file_matches(meta_fd, current.name, witness->record_dev, witness->record_ino, witness->digest, 1))
        fail_with_errno("verify-completed-alias-record");
      staged = source_entry;
      verify_link(source_fd, from.name, link_text, &staged, "verify-completed-alias");
    } else {
    if (!has_pending) {
      if (!file_matches(meta_fd, current.name, witness->record_dev, witness->record_ino, witness->digest, 1))
        fail_with_errno("verify-alias-current-witness");
      if (fstatat(destination_fd, to.name, &existing, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) == 0) {
        errno = EEXIST; fail_with_errno("verify-alias-destination-absent");
      }
      if (errno != ENOENT) fail_with_errno("verify-alias-destination-absent");
      if (symlinkat(link_text, meta_fd, stage.name) != 0) fail_with_errno("create-alias-witness-stage");
      if (fsync(meta_fd) != 0) fail_with_errno("sync-alias-witness-stage");
      commit_barrier(witness_barrier == 1, 7, 8, "after-alias-stage-create-barrier");
      if (atomic_move_no_replace(meta_fd, current.name, pending.name) != 0) fail_with_errno("claim-alias-record");
      if (!file_matches(meta_fd, pending.name, witness->record_dev, witness->record_ino, witness->digest, 1))
        fail_with_errno("verify-claimed-alias-record");
      if (fsync(meta_fd) != 0) fail_with_errno("sync-claimed-alias-record");
    }
    if (!file_matches(meta_fd, pending.name, witness->record_dev, witness->record_ino, witness->digest, 1))
      fail_with_errno("verify-alias-pending-witness");
    if (!file_exists(meta_fd, current.name) && linkat(meta_fd, pending.name, meta_fd, current.name, 0) != 0)
      fail_with_errno("restore-alias-current-no-replace");
    if (!file_matches(meta_fd, current.name, witness->record_dev, witness->record_ino, witness->digest, 1))
      fail_with_errno("verify-alias-current-witness");
    if (fstatat(meta_fd, stage.name, &staged, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) != 0)
      fail_with_errno("stat-alias-witness-stage");
    verify_link(meta_fd, stage.name, link_text, &staged, "verify-alias-witness-link");
    if (fsync(meta_fd) != 0 || fsync(object_fd) != 0) fail_with_errno("sync-alias-witness");
    commit_barrier(witness_barrier == 2, 7, 8, "after-alias-witness-barrier");
    if (!committed) {
      if (!file_exists(destination_fd, to.name) && linkat(meta_fd, stage.name, destination_fd, to.name, 0) != 0)
        fail_with_errno("create-alias-stage-no-replace");
      verify_link(destination_fd, to.name, link_text, &staged, "verify-alias-stage");
    }
    }
  } else {
    if (fstatat(destination_fd, to.name, &existing, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) == 0) {
      errno = EEXIST; fail_with_errno("verify-alias-destination-absent");
    }
    if (errno != ENOENT) fail_with_errno("verify-alias-destination-absent");
    if (symlinkat(link_text, destination_fd, to.name) != 0) fail_with_errno("create-alias-stage");
    if (fstatat(destination_fd, to.name, &staged, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) != 0)
      fail_with_errno("stat-alias-stage");
  }
  commit_barrier(before_barrier, 3, 4, "before-commit-alias-barrier");
  verify_entry(root_fd, from.parent, &source_parent, 1, "verify-alias-source-parent");
  verify_entry(root_fd, to.parent, &destination_parent, 1, "verify-alias-destination-parent");
  if (!committed) {
    verify_entry(source_fd, from.name, &original, 1, "verify-alias-source");
    verify_link(destination_fd, to.name, link_text, &staged, "verify-alias-stage");
    commit_barrier(swap_barrier, 11, 12, "last-check-alias-swap-barrier");
    if (renameatx_np(source_fd, from.name, destination_fd, to.name,
                   RENAME_SWAP | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH) != 0) {
      fail_with_errno("alias-swap");
    }
  }
  commit_barrier(after_barrier, 5, 6, "after-commit-alias-barrier");
  verify_link(source_fd, from.name, link_text, &staged, "after-commit-verify-alias");
  verify_entry(destination_fd, to.name, &original, 1, "after-commit-verify-destination");
  verify_entry(root_fd, from.parent, &source_parent, 1, "after-commit-source-parent");
  verify_entry(root_fd, to.parent, &destination_parent, 1, "after-commit-destination-parent");
  const int first_sync = sync_fault == 1 ? (errno = EIO, -1) : fsync(source_fd);
  const int first_errno = errno;
  const int second_sync = sync_fault == 2 ? (errno = EIO, -1) : fsync(destination_fd);
  if (first_sync != 0 || second_sync != 0) { if (first_sync != 0) errno = first_errno; fail_with_errno("after-commit-sync-alias"); }
  commit_barrier(finalize_barrier, 9, 10, "before-alias-finalize-barrier");
  struct stat visible_root;
  if (lstat(root_path, &visible_root) != 0 || !S_ISDIR(visible_root.st_mode) ||
      visible_root.st_dev != root.st_dev || visible_root.st_ino != root.st_ino) {
    errno = ESTALE; fail_with_errno("after-commit-visible-root");
  }
  verify_entry(root_fd, from.parent, &source_parent, 1, "after-sync-source-parent");
  verify_entry(root_fd, to.parent, &destination_parent, 1, "after-sync-destination-parent");
  verify_link(source_fd, from.name, link_text, &staged, "after-sync-alias");
  verify_entry(destination_fd, to.name, &original, 1, "after-sync-destination");
  if (witness) {
    verify_entry(object_fd, current.parent, &meta, 1, "after-sync-witness-parent");
    if (already_confirmed) {
      if (!file_matches(meta_fd, current.name, witness->record_dev, witness->record_ino, witness->digest, 1) ||
          fsync(meta_fd) != 0 || fsync(object_fd) != 0 || fsync(root_fd) != 0) fail_with_errno("sync-completed-alias-record");
    } else {
    verify_link(meta_fd, stage.name, link_text, &staged, "after-sync-witness-stage");
    if (!file_matches(meta_fd, pending.name, witness->record_dev, witness->record_ino, witness->digest, 1) ||
        !file_matches(meta_fd, current.name, witness->record_dev, witness->record_ino, witness->digest, 1) ||
        fsync(meta_fd) != 0 || fsync(object_fd) != 0 || fsync(root_fd) != 0) fail_with_errno("after-sync-original-witness");
    /* Claim before deleting, so a replacement at either public witness name is preserved. */
    unsigned char entropy[16]; char token[33]; arc4random_buf(entropy, sizeof(entropy));
    for (size_t i = 0; i < sizeof(entropy); i += 1) snprintf(token + i * 2, 3, "%02x", entropy[i]);
    char *retired_stage = malloc(strlen(stage.name) + 39), *retired_raw = malloc(strlen(pending.name) + 39);
    if (!retired_stage || !retired_raw) fail_with_errno("allocate-alias-retirement");
    sprintf(retired_stage, "%s.%s.tmp", stage.name, token); sprintf(retired_raw, "%s.%s.tmp", pending.name, token);
    if (atomic_move_no_replace(meta_fd, stage.name, retired_stage) != 0) fail_with_errno("claim-alias-stage-retirement");
    struct stat claimed_stage;
    if (fstatat(meta_fd, retired_stage, &claimed_stage, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) != 0 ||
        !S_ISLNK(claimed_stage.st_mode) || claimed_stage.st_dev != staged.st_dev || claimed_stage.st_ino != staged.st_ino)
      restore_claim(meta_fd, retired_stage, stage.name, "after-commit-stage-claim-conflict");
    if (atomic_move_no_replace(meta_fd, pending.name, retired_raw) != 0) fail_with_errno("claim-alias-record-retirement");
    if (!file_matches(meta_fd, retired_raw, witness->record_dev, witness->record_ino, witness->digest, 0) ||
        !file_matches(meta_fd, current.name, witness->record_dev, witness->record_ino, witness->digest, 0))
      restore_claim(meta_fd, retired_raw, pending.name, "after-commit-record-claim-conflict");
    verify_link(source_fd, from.name, link_text, &staged, "after-claim-original-alias");
    verify_entry(destination_fd, to.name, &original, 1, "after-claim-original-object");
    verify_entry(root_fd, from.parent, &source_parent, 1, "after-claim-source-parent");
    verify_entry(root_fd, to.parent, &destination_parent, 1, "after-claim-destination-parent");
    /* The original facts were durable before these private links were retired. */
    if (unlinkat(meta_fd, retired_stage, 0) != 0 || unlinkat(meta_fd, retired_raw, 0) != 0 || fsync(meta_fd) != 0)
      fail_with_errno("after-commit-witness-cleanup");
    free(retired_stage); free(retired_raw);
    }
    close(meta_fd); free(current.storage); free(pending.storage); free(stage.storage);
  }
  close(object_fd);
  free(link_text);
  free(from.storage); free(to.storage);
  close(source_fd);
  close(destination_fd);
}

/* Bounded file publication shares the original confined no-replace owner. */
static int file_exists(int fd, const char *name) {
  struct stat info;
  if (fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW | AT_RESOLVE_BENEATH) == 0) return 1;
  if (errno == ENOENT) return 0;
  fail_with_errno("file-publication-stat");
}

static int file_matches(int fd, const char *name, unsigned long long dev,
                        unsigned long long ino, const char *digest, int sync_file) {
  const int file = openat(fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file < 0) return 0;
  struct stat info;
  unsigned char bytes[4097], output[CC_SHA256_DIGEST_LENGTH];
  char actual[CC_SHA256_DIGEST_LENGTH * 2 + 1];
  const int stat_result = fstat(file, &info);
  int failure_errno = stat_result == 0 ? ESTALE : errno;
  int valid = stat_result == 0 && S_ISREG(info.st_mode) && info.st_size <= 4096 &&
    (dev == 0 || (unsigned long long)info.st_dev == dev) &&
    (ino == 0 || (unsigned long long)info.st_ino == ino);
  size_t length = 0;
  while (valid && length < sizeof(bytes)) {
    const ssize_t count = read(file, bytes + length, sizeof(bytes) - length);
    if (count < 0) { if (errno == EINTR) continue; failure_errno = errno; valid = 0; break; }
    if (count == 0) break;
    length += (size_t)count;
  }
  if (length > 4096) valid = 0;
  if (valid) {
    CC_SHA256(bytes, (CC_LONG)length, output);
    for (size_t index = 0; index < sizeof(output); index += 1) snprintf(actual + index * 2, 3, "%02x", output[index]);
    valid = strcmp(actual, digest) == 0;
  }
  if (valid && sync_file && fsync(file) != 0) { failure_errno = errno; valid = 0; }
  close(file);
  if (!valid) errno = failure_errno;
  return valid;
}

static void restore_claim(int fd, const char *pending, const char *current, const char *phase) {
  /* Restoration also refuses to overwrite a fact that appeared at the old name. */
  const int restored = atomic_move_no_replace(fd, pending, current);
  fprintf(stderr, "claim-restored=%d\n", restored == 0);
  if (restored == 0 && fsync(fd) != 0) fail_with_errno("file-restore-sync");
  errno = ESTALE;
  fail_with_errno(phase);
}

static void file_publication(int object_fd, const char *object_path, char **argv,
                             int confirm, int before_barrier, int after_barrier, int sync_fault) {
  char *parent = strdup(argv[4]);
  if (!parent) fail_with_errno("file-publication-parent");
  char *slash = strrchr(parent, '/');
  if (!slash) { errno = EINVAL; fail_with_errno("file-publication-parent"); }
  *slash = '\0';
  if (strchr(parent, '/')) { errno = EINVAL; fail_with_errno("file-publication-direct-parent"); }
  const char *current = strrchr(argv[4], '/') + 1;
  const char *temporary = strrchr(argv[5], '/');
  const char *pending = strrchr(argv[6], '/');
  if (!temporary || !pending || strncmp(argv[5], parent, strlen(parent)) != 0 || argv[5][strlen(parent)] != '/' ||
      strncmp(argv[6], parent, strlen(parent)) != 0 || argv[6][strlen(parent)] != '/' ||
      strchr(argv[5] + strlen(parent) + 1, '/') || strchr(argv[6] + strlen(parent) + 1, '/')) {
    errno = EINVAL; fail_with_errno("file-publication-siblings");
  }
  temporary += 1; pending += 1;
  if (strcmp(current, temporary) == 0 || strcmp(current, pending) == 0 || strcmp(temporary, pending) == 0) {
    errno = EINVAL; fail_with_errno("file-publication-distinct-names");
  }
  const int fd = openat(object_fd, parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail_with_errno("file-publication-open-parent");
  struct stat meta, object;
  if (fstat(fd, &meta) != 0 || fstat(object_fd, &object) != 0) fail_with_errno("file-publication-stat-parent");
  if ((unsigned long long)meta.st_dev != parse_identity(argv[7], "parent device") ||
      (unsigned long long)meta.st_ino != parse_identity(argv[8], "parent inode")) {
    errno = ESTALE; fail_with_errno("file-publication-parent-changed");
  }
  const unsigned long long old_dev = parse_identity(argv[9], "old device"), old_ino = parse_identity(argv[10], "old inode");
  const char *old_hash = argv[11], *new_hash = argv[12];
  if (strlen(old_hash) != CC_SHA256_DIGEST_LENGTH * 2 || strlen(new_hash) != CC_SHA256_DIGEST_LENGTH * 2) {
    errno = EINVAL; fail_with_errno("file-publication-digest");
  }
  if (confirm) {
    if (!file_matches(fd, pending, old_dev, old_ino, old_hash, 0) || !file_matches(fd, current, 0, 0, new_hash, 1))
      fail_with_errno("file-confirm-original-witness");
    if (fsync(fd) != 0 || fsync(object_fd) != 0) fail_with_errno("file-confirm-sync");
    commit_barrier(before_barrier, 3, 4, "before-file-confirm-barrier");
    verify_entry(object_fd, parent, &meta, 1, "file-confirm-parent-changed");
    if (atomic_move_no_replace(fd, pending, temporary) != 0) fail_with_errno("file-confirm-claim-pending");
    if (!file_matches(fd, temporary, old_dev, old_ino, old_hash, 0) || !file_matches(fd, current, 0, 0, new_hash, 0))
      restore_claim(fd, temporary, pending, "file-confirm-witness-changed");
    /* Publication durability is confirmed before retiring its original witness. */
    if (unlinkat(fd, temporary, 0) != 0) fail_with_errno("file-confirm-retire-witness");
    if (fsync(fd) != 0) fprintf(stderr, "file-confirm-cleanup-sync-unknown\n");
  } else {
    const int already_claimed = file_exists(fd, pending);
    if (already_claimed) {
      if (!file_matches(fd, pending, old_dev, old_ino, old_hash, 0)) fail_with_errno("file-publish-pending-changed");
      if (file_exists(fd, current)) {
        if (!file_matches(fd, current, 0, 0, new_hash, 0)) fail_with_errno("file-publish-current-conflict");
        close(fd); free(parent); return;
      }
    } else if (!file_matches(fd, current, old_dev, old_ino, old_hash, 0)) fail_with_errno("file-publish-original-changed");
    if (!file_matches(fd, temporary, 0, 0, new_hash, 0)) fail_with_errno("file-publish-stage-changed");
    commit_barrier(before_barrier, 3, 4, "before-file-claim-barrier");
    verify_entry(object_fd, parent, &meta, 1, "file-publish-parent-changed");
    if (!already_claimed) {
      if (atomic_move_no_replace(fd, current, pending) != 0) fail_with_errno("file-publish-claim-original");
      if (!file_matches(fd, pending, old_dev, old_ino, old_hash, 0))
        restore_claim(fd, pending, current, "file-publish-claimed-conflict");
      if (fsync(fd) != 0) fail_with_errno("file-publish-sync-claim");
    }
    commit_barrier(after_barrier, 5, 6, "after-file-claim-barrier");
    verify_entry(object_fd, parent, &meta, 1, "file-publish-parent-changed-after-claim");
    if (atomic_move_no_replace(fd, temporary, current) != 0) fail_with_errno("file-publish-no-replace");
    if (sync_fault) { errno = EIO; fail_with_errno("file-publish-sync"); }
    if (!file_matches(fd, current, 0, 0, new_hash, 1)) fail_with_errno("file-publish-readback");
    if (fsync(fd) != 0 || fsync(object_fd) != 0) fail_with_errno("file-publish-sync");
  }
  struct stat visible;
  if (lstat(object_path, &visible) != 0 || !S_ISDIR(visible.st_mode) || visible.st_dev != object.st_dev || visible.st_ino != object.st_ino) {
    errno = ESTALE; fail_with_errno("file-publication-visible-object-changed");
  }
  verify_entry(object_fd, parent, &meta, 1, "file-publication-visible-parent-changed");
  close(fd); free(parent);
}

int main(int argc, char **argv) {
  const int alias_swap = argc > 1 && strcmp(argv[1], "--alias-swap") == 0;
  const int file_publish = argc > 1 && strcmp(argv[1], "--file-publish") == 0;
  const int file_confirm = argc > 1 && strcmp(argv[1], "--file-confirm") == 0;
  if (alias_swap || file_publish || file_confirm) { argc -= 1; argv += 1; }
  const int required = file_publish || file_confirm ? 13 : alias_swap ? 8 : 6;
  if (argc < required || (!alias_swap && argc > required + (file_publish || file_confirm ? 3 : 2))) {
    fprintf(
      stderr,
      "usage: workspace-move <root> <dev> <ino> <source> <destination> "
      "[--before-commit-barrier] [--after-commit-barrier]\n"
      "       workspace-move --alias-swap <root> <dev> <ino> <source> <destination> "
      "<source-dev> <source-ino> [--before-commit-barrier] [--after-commit-barrier]\n"
      "       workspace-move --file-publish|--file-confirm <root> <dev> <ino> <current> <stage> <pending> "
      "<parent-dev> <parent-ino> <old-dev> <old-ino> <old-sha256> <new-sha256> "
      "[--before-commit-barrier] [--after-commit-barrier]\n"
    );
    return 64;
  }
  int before_commit_barrier = 0;
  int after_commit_barrier = 0;
  int file_sync_fault = 0;
  int witness_barrier = 0, finalize_barrier = 0, swap_barrier = 0, alias_sync_fault = 0;
  alias_witness witness = {0};
  int has_witness = 0;
  for (int index = required; index < argc; index += 1) {
    if (strcmp(argv[index], "--before-commit-barrier") == 0) {
      before_commit_barrier = 1;
    } else if (strcmp(argv[index], "--after-commit-barrier") == 0) {
      after_commit_barrier = 1;
    } else if (file_publish && strcmp(argv[index], "--file-sync-fault") == 0) {
      file_sync_fault = 1;
    } else if (alias_swap && strcmp(argv[index], "--witness") == 0 && index + 8 < argc && !has_witness) {
      witness.current = argv[++index]; witness.pending = argv[++index]; witness.stage = argv[++index];
      witness.parent_dev = parse_identity(argv[++index], "witness parent device");
      witness.parent_ino = parse_identity(argv[++index], "witness parent inode");
      witness.record_dev = parse_identity(argv[++index], "witness record device");
      witness.record_ino = parse_identity(argv[++index], "witness record inode");
      witness.digest = argv[++index];
      if (strlen(witness.digest) != CC_SHA256_DIGEST_LENGTH * 2) { errno = EINVAL; fail_with_errno("validate-witness-digest"); }
      has_witness = 1;
    } else if (alias_swap && strcmp(argv[index], "--after-stage-create-barrier") == 0) {
      witness_barrier = 1;
    } else if (alias_swap && strcmp(argv[index], "--after-witness-barrier") == 0) {
      witness_barrier = 2;
    } else if (alias_swap && strcmp(argv[index], "--before-finalize-barrier") == 0) {
      finalize_barrier = 1;
    } else if (alias_swap && strcmp(argv[index], "--last-swap-barrier") == 0) {
      swap_barrier = 1;
    } else if (alias_swap && strcmp(argv[index], "--alias-sync-fault") == 0 && index + 1 < argc) {
      const char *role = argv[++index];
      if (!strcmp(role, "source")) alias_sync_fault = 1;
      else if (!strcmp(role, "destination")) alias_sync_fault = 2;
      else { errno = EINVAL; fail_with_errno("validate-alias-sync-role"); }
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
  if (file_publish || file_confirm) {
    validate_relative_path(argv[6]);
    file_publication(root_fd, argv[1], argv, file_confirm, before_commit_barrier, after_commit_barrier, file_sync_fault);
    close(root_fd);
    return 0;
  }
  if (alias_swap) {
    atomic_alias_swap(root_fd, argv[1], argv[4], argv[5], parse_identity(argv[6], "source device"),
                      parse_identity(argv[7], "source inode"), before_commit_barrier, after_commit_barrier,
                      witness_barrier, finalize_barrier, swap_barrier, alias_sync_fault, has_witness ? &witness : NULL);
    close(root_fd);
    return 0;
  }
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
