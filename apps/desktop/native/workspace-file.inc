/* Single-directory operations share the move helper's process and kernel-pinned cwd. */
#include <dirent.h>
#include <limits.h>
#include <signal.h>
#include <sys/resource.h>
#include <sys/wait.h>

static int workspace_write_published = 0;
static char *workspace_temporary = NULL;
static long long workspace_read_cost = -1;

static void workspace_json_string(FILE *output, const char *text) {
  fputc('"', output);
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p == '"' || *p == '\\') fprintf(output, "\\%c", *p);
    else if (*p < 32) fprintf(output, "\\u%04x", *p);
    else fputc(*p, output);
  }
  fputc('"', output);
}

static _Noreturn void workspace_error(const char *code, const char *message) {
  if (workspace_temporary) unlink(workspace_temporary);
  fprintf(stderr, "AGENTMUX_WORKSPACE_ERROR:{\"message\":");
  workspace_json_string(stderr, message);
  fprintf(stderr, ",\"code\":"); workspace_json_string(stderr, code);
  fprintf(stderr, ",\"writeOutcomeUnknown\":%s", workspace_write_published ? "true" : "false");
  if (workspace_read_cost >= 0) fprintf(stderr, ",\"readCost\":{\"payloadBytes\":%lld}", workspace_read_cost);
  fprintf(stderr, "}\n");
  exit(1);
}

static _Noreturn void workspace_errno(void) {
  const int value = errno;
  const char *code = value == ENOENT ? "ENOENT" : value == EEXIST ? "EEXIST" :
    value == ELOOP ? "ELOOP" : value == EACCES ? "EACCES" : value == ENOTDIR ? "ENOTDIR" :
    value == ENOSPC ? "ENOSPC" : value == ENOMEM ? "ENOMEM" : value == EIO ? "EIO" :
    value == EINVAL ? "EINVAL" : value == ENAMETOOLONG ? "ENAMETOOLONG" : value == EROFS ? "EROFS" :
    value == EPERM ? "EPERM" : value == ENOTEMPTY ? "ENOTEMPTY" : value == EMFILE ? "EMFILE" :
    value == ENFILE ? "ENFILE" : value == ESTALE ? "ESTALE" : "WORKSPACE_FILE_IO_ERROR";
  workspace_error(code, strerror(value));
}

static void workspace_cwd(const char *root, char *path) {
  if (!getcwd(path, PATH_MAX)) workspace_errno();
  const size_t length = strlen(root);
  if (strcmp(path, root) && !(length == 1 && root[0] == '/') &&
      !(strncmp(path, root, length) == 0 && path[length] == '/'))
    workspace_error("WORKSPACE_PATH_ESCAPE", "Path escapes the workspace root");
}

static unsigned char *workspace_input(int fd, size_t *length) {
  size_t capacity = 65536; *length = 0;
  unsigned char *bytes = malloc(capacity);
  if (!bytes) workspace_errno();
  for (;;) {
    if (*length == capacity) {
      if (capacity > SIZE_MAX / 2) { errno = ENOMEM; workspace_errno(); }
      capacity *= 2;
      unsigned char *next = realloc(bytes, capacity);
      if (!next) { free(bytes); workspace_errno(); }
      bytes = next;
    }
    const ssize_t count = read(fd, bytes + *length, capacity - *length);
    if (count < 0) { if (errno == EINTR) continue; free(bytes); workspace_errno(); }
    if (!count) return bytes;
    *length += (size_t)count;
  }
}

static int workspace_regular(const char *name) {
  const int fd = open(name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return fd;
  struct stat info;
  if (fstat(fd, &info)) { const int value = errno; close(fd); errno = value; return -1; }
  if (!S_ISREG(info.st_mode)) { close(fd); errno = EINVAL; return -1; }
  return fd;
}

static void workspace_digest(const unsigned char *bytes, size_t length, char *revision) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  for (size_t offset = 0; offset < length;) {
    const size_t block = length - offset > 65536 ? 65536 : length - offset;
    CC_SHA256_Update(&context, bytes + offset, (CC_LONG)block); offset += block;
  }
  CC_SHA256_Final(digest, &context);
  strcpy(revision, "sha256:");
  for (size_t index = 0; index < sizeof(digest); index++) snprintf(revision + 7 + index * 2, 3, "%02x", digest[index]);
}

static void workspace_byte_range(const char *name, size_t offset, size_t max_bytes,
                                 size_t max_file, const char *expected) {
  workspace_read_cost = 0;
  const int fd = workspace_regular(name);
  if (fd < 0) workspace_errno();
  struct stat before, after;
  if (fstat(fd, &before)) workspace_errno();
  if (before.st_size < 0 || (uint64_t)before.st_size > max_file)
    workspace_error("WORKSPACE_FILE_BYTE_LIMIT", "Workspace file exceeds the byte transfer budget");
  const size_t total = (size_t)before.st_size;
  if (offset > total) workspace_error("WORKSPACE_FILE_INVALID_REQUEST", "Byte offset exceeds the Workspace file length");
  const size_t length = max_bytes < total - offset ? max_bytes : total - offset;
  unsigned char *bytes = malloc(length ? length : 1), block[65536], digest[CC_SHA256_DIGEST_LENGTH];
  if (!bytes) workspace_errno();
  CC_SHA256_CTX context; CC_SHA256_Init(&context);
  for (size_t position = 0; position < total;) {
    const size_t wanted = total - position < sizeof(block) ? total - position : sizeof(block);
    const ssize_t count = read(fd, block, wanted);
    if (count < 0) { if (errno == EINTR) continue; workspace_errno(); }
    if (!count) workspace_error("WORKSPACE_FILE_CHANGED_WHILE_READING", "Workspace file changed while reading its bytes");
    CC_SHA256_Update(&context, block, (CC_LONG)count);
    const size_t start = position > offset ? position : offset;
    const size_t stop = position + (size_t)count < offset + length ? position + (size_t)count : offset + length;
    if (stop > start) memcpy(bytes + start - offset, block + start - position, stop - start);
    position += (size_t)count; workspace_read_cost = (long long)position;
  }
  if (fstat(fd, &after)) workspace_errno(); close(fd);
  if (before.st_size != after.st_size || before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec ||
      before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec || before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec ||
      before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec)
    workspace_error("WORKSPACE_FILE_CHANGED_WHILE_READING", "Workspace file changed while reading its bytes");
  CC_SHA256_Final(digest, &context);
  char revision[72]; strcpy(revision, "sha256:");
  for (size_t index = 0; index < sizeof(digest); index++) snprintf(revision + 7 + index * 2, 3, "%02x", digest[index]);
  if (strcmp(expected, "null") && strcmp(revision, expected))
    workspace_error("WORKSPACE_FILE_REVISION_MISMATCH", "Workspace file no longer matches its original revision");
  printf("{\"data\":\"");
  const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (size_t index = 0; index < length; index += 3) {
    const unsigned int first = bytes[index], second = index + 1 < length ? bytes[index + 1] : 0,
      third = index + 2 < length ? bytes[index + 2] : 0;
    putchar(alphabet[first >> 2]); putchar(alphabet[((first & 3) << 4) | (second >> 4)]);
    putchar(index + 1 < length ? alphabet[((second & 15) << 2) | (third >> 6)] : '=');
    putchar(index + 2 < length ? alphabet[third & 63] : '=');
  }
  printf("\",\"totalBytes\":%zu,\"revision\":", total); workspace_json_string(stdout, revision);
  printf(",\"offset\":%zu,\"returnedBytes\":%zu,\"nextOffset\":", offset, length);
  if (offset + length < total) printf("%zu", offset + length); else printf("null");
  printf(",\"readCost\":{\"payloadBytes\":%zu}}", total); free(bytes);
}

static int workspace_binary(const unsigned char *bytes, size_t length) {
  if ((length >= 5 && !memcmp(bytes, "%PDF-", 5)) ||
      (length >= 6 && (!memcmp(bytes, "GIF87a", 6) || !memcmp(bytes, "GIF89a", 6))) ||
      (length >= 3 && !memcmp(bytes, "ID3", 3)) || (length >= 4 && !memcmp(bytes, "fLaC", 4)) ||
      (length >= 4 && (!memcmp(bytes, "\x89PNG", 4) || !memcmp(bytes, "PK\3\4", 4))) ||
      (length >= 3 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255) ||
      (length >= 2 && bytes[0] == 31 && bytes[1] == 139) ||
      (length >= 12 && !memcmp(bytes, "RIFF", 4) &&
       (!memcmp(bytes + 8, "WEBP", 4) || !memcmp(bytes + 8, "WAVE", 4) || !memcmp(bytes + 8, "AVI ", 4)))) return 1;
  for (size_t index = 0; index < length;) {
    const unsigned char first = bytes[index++];
    if (!first) return 1;
    if (first < 128) continue;
    const size_t extra = first >= 194 && first <= 223 ? 1 : first >= 224 && first <= 239 ? 2 : first >= 240 && first <= 244 ? 3 : 0;
    if (!extra || extra > length - index) return 1;
    if ((first == 224 && bytes[index] < 160) || (first == 237 && bytes[index] >= 160) ||
        (first == 240 && bytes[index] < 144) || (first == 244 && bytes[index] >= 144)) return 1;
    for (size_t offset = 0; offset < extra; offset++) if ((bytes[index++] & 192) != 128) return 1;
  }
  return 0;
}

static int workspace_current(const char *name, char *revision, mode_t *mode, int *binary) {
  const int fd = workspace_regular(name);
  if (fd < 0) { if (errno == ENOENT) return 0; workspace_errno(); }
  struct stat info;
  if (fstat(fd, &info)) workspace_errno();
  size_t length;
  unsigned char *bytes = workspace_input(fd, &length);
  close(fd);
  workspace_digest(bytes, length, revision); *mode = info.st_mode & 07777;
  *binary = workspace_binary(bytes, length); free(bytes); return 1;
}

static void workspace_write_all(int fd, const unsigned char *bytes, size_t length) {
  for (size_t offset = 0; offset < length;) {
    const ssize_t count = write(fd, bytes + offset, length - offset);
    if (count < 0) { if (errno == EINTR) continue; workspace_errno(); }
    if (!count) { errno = EIO; workspace_errno(); }
    offset += (size_t)count;
  }
}

static void workspace_conflict(int exists, const char *revision) {
  printf("{\"status\":\"conflict\",\"observedRevision\":");
  if (exists) workspace_json_string(stdout, revision); else printf("null");
  printf("}");
}

static int workspace_expect(int exists, const char *revision, const char *expected) {
  return exists ? !strcmp(revision, expected) : !strcmp(expected, "null");
}

static void workspace_write(const char *name, const char *expected, int exclusive, int text_only,
                            const char *fault, const unsigned char *bytes, size_t length) {
  char revision[72]; mode_t mode = 0666; int binary = 0;
  const int exists = workspace_current(name, revision, &mode, &binary);
  if (text_only && binary) workspace_error("WORKSPACE_BINARY_FILE_NOT_EDITABLE", "The current file contains binary bytes. The original file and text draft were kept.");
  if (!workspace_expect(exists, revision, expected)) { workspace_conflict(exists, revision); return; }
  char token[33]; unsigned char entropy[16]; arc4random_buf(entropy, sizeof(entropy));
  for (size_t i = 0; i < sizeof(entropy); i++) snprintf(token + i * 2, 3, "%02x", entropy[i]);
  char *temporary = malloc(strlen(name) + 64);
  if (!temporary) workspace_errno();
  sprintf(temporary, ".%s.agentmux-%d-%s", name, getpid(), token);
  const int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode);
  if (fd < 0) workspace_errno();
  workspace_temporary = temporary;
  if (exists && fchmod(fd, mode)) workspace_errno();
  if (!strcmp(fault, "temporary-write")) {
    close(fd); unlink(temporary); workspace_error("INJECTED_TEMPORARY_WRITE", "Injected temporary write failure");
  }
  workspace_write_all(fd, bytes, length);
  if (fsync(fd)) { const int value = errno; close(fd); unlink(temporary); errno = value; workspace_errno(); }
  close(fd);
  const int current = workspace_current(name, revision, &mode, &binary);
  if ((text_only && binary) || !workspace_expect(current, revision, expected)) {
    unlink(temporary); workspace_temporary = NULL; free(temporary);
    if (text_only && binary) workspace_error("WORKSPACE_BINARY_FILE_NOT_EDITABLE", "The current file contains binary bytes. The original file and text draft were kept.");
    workspace_conflict(current, revision); return;
  }
  if (!strcmp(fault, "replace")) { unlink(temporary); workspace_error("INJECTED_REPLACE", "Injected atomic replace failure"); }
  if (!strcmp(fault, "occupy")) {
    const int competitor = open(name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (competitor < 0) workspace_errno();
    workspace_write_all(competitor, (const unsigned char *)"competing bytes", 15); close(competitor);
  }
  commit_barrier(!strcmp(fault, "before-publish-barrier"), 3, 4, "before-workspace-file-publish");
  const int published = exclusive ? link(temporary, name) : rename(temporary, name);
  const int value = errno;
  unlink(temporary); workspace_temporary = NULL; free(temporary);
  if (published) {
    if (exclusive && value == EEXIST) {
      const int observed = workspace_current(name, revision, &mode, &binary); workspace_conflict(observed, revision); return;
    }
    errno = value; workspace_errno();
  }
  workspace_write_published = 1;
  if (!strcmp(fault, "receipt")) workspace_error("INJECTED_WRITE_RECEIPT", "Write was published but its receipt failed");
  workspace_digest(bytes, length, revision);
  printf("{\"status\":\"written\",\"revision\":"); workspace_json_string(stdout, revision); printf("}");
}

static void workspace_delete(int parent, const char *name) {
  struct stat before;
  if (fstatat(parent, name, &before, AT_SYMLINK_NOFOLLOW)) workspace_errno();
  if (!S_ISDIR(before.st_mode)) { if (unlinkat(parent, name, 0)) workspace_errno(); return; }
  const int fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) workspace_errno();
  struct stat opened;
  if (fstat(fd, &opened)) workspace_errno();
  if (before.st_dev != opened.st_dev || before.st_ino != opened.st_ino) {
    close(fd); workspace_error("WORKSPACE_FILE_CHANGED_WHILE_DELETING", "Directory changed while deleting its contents");
  }
  DIR *directory = fdopendir(fd);
  if (!directory) { close(fd); workspace_errno(); }
  struct dirent *entry;
  for (;;) {
    errno = 0; entry = readdir(directory);
    if (!entry) { if (errno) workspace_errno(); break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    workspace_delete(fd, entry->d_name);
  }
  struct stat current;
  if (fstatat(parent, name, &current, AT_SYMLINK_NOFOLLOW)) workspace_errno();
  if (current.st_dev != opened.st_dev || current.st_ino != opened.st_ino) {
    closedir(directory); workspace_error("WORKSPACE_FILE_CHANGED_WHILE_DELETING", "Directory changed while deleting its contents");
  }
  closedir(directory);
  if (unlinkat(parent, name, AT_REMOVEDIR)) workspace_errno();
}

static int workspace_name_compare(const void *left, const void *right) {
  return strcmp(*(const char * const *)left, *(const char * const *)right);
}

/* Git decoration is optional. The child inherits the same pinned directory. */
static char *workspace_ignored(DIR *directory, size_t *length) {
  *length = 0;
  FILE *input = tmpfile(), *output = tmpfile();
  if (!input || !output) { if (input) fclose(input); if (output) fclose(output); return NULL; }
  struct dirent *entry;
  for (;;) {
    errno = 0; entry = readdir(directory);
    if (!entry) { if (errno) { fclose(input); fclose(output); rewinddir(directory); return NULL; } break; }
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) fprintf(input, "%s%c", entry->d_name, 0);
  }
  rewind(input); rewinddir(directory);
  const pid_t child = fork();
  if (!child) {
    if (dup2(fileno(input), STDIN_FILENO) < 0 || dup2(fileno(output), STDOUT_FILENO) < 0) _exit(1);
    const int quiet = open("/dev/null", O_WRONLY);
    if (quiet >= 0) dup2(quiet, STDERR_FILENO);
    const struct rlimit output_limit = { 2 * 1024 * 1024, 2 * 1024 * 1024 };
    if (setrlimit(RLIMIT_FSIZE, &output_limit)) _exit(1);
    alarm(5);
    execlp("git", "git", "check-ignore", "-z", "--stdin", (char *)NULL); _exit(127);
  }
  int status = 0; pid_t waited = -1;
  if (child > 0) do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  char *bytes = NULL;
  if (waited == child && WIFEXITED(status) && (WEXITSTATUS(status) == 0 || WEXITSTATUS(status) == 1)) {
    if (!fseek(output, 0, SEEK_END)) {
      const long size = ftell(output);
      if (size > 0 && size <= 2 * 1024 * 1024) {
        bytes = malloc((size_t)size + 1);
        if (bytes) { rewind(output); *length = fread(bytes, 1, (size_t)size, output); bytes[*length] = 0; }
      }
    }
  }
  fclose(input); fclose(output); return bytes;
}

static void workspace_list(void) {
  const int fd = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) workspace_errno();
  DIR *directory = fdopendir(fd);
  if (!directory) { close(fd); workspace_errno(); }
  size_t ignored_length; char *ignored = workspace_ignored(directory, &ignored_length);
  size_t ignored_count = 0;
  for (size_t index = 0; index < ignored_length; index++) if (!ignored[index]) ignored_count++;
  char **names = ignored_count ? malloc(ignored_count * sizeof(char *)) : NULL;
  if (names) {
    size_t count = 0;
    for (size_t index = 0; index < ignored_length;) {
      const char *end = memchr(ignored + index, 0, ignored_length - index);
      if (!end) break;
      names[count++] = ignored + index; index = (size_t)(end - ignored) + 1;
    }
    ignored_count = count;
    qsort(names, ignored_count, sizeof(char *), workspace_name_compare);
  }
  printf("["); int first = 1; struct dirent *entry;
  for (;;) {
    errno = 0; entry = readdir(directory);
    if (!entry) { if (errno) workspace_errno(); break; }
    const char *name = entry->d_name;
    if (!strcmp(name, ".") || !strcmp(name, "..")) continue;
    if (!first) printf(","); first = 0;
    struct stat info, linked;
    const int known = fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0;
    const int is_link = known ? S_ISLNK(info.st_mode) : entry->d_type == DT_LNK;
    int is_directory = known ? S_ISDIR(info.st_mode) : entry->d_type == DT_DIR;
    const int target_known = is_link && fstatat(fd, name, &linked, 0) == 0;
    if (target_known) is_directory = S_ISDIR(linked.st_mode);
    printf("{\"name\":"); workspace_json_string(stdout, name);
    printf(",\"isDirectory\":%s,\"isSymlink\":%s", is_directory ? "true" : "false", is_link ? "true" : "false");
    if (names && bsearch(&name, names, ignored_count, sizeof(char *), workspace_name_compare)) printf(",\"ignored\":true");
    if (is_link) {
      char text[PATH_MAX + 1]; const ssize_t size = readlinkat(fd, name, text, PATH_MAX);
      if (size < 0) workspace_errno(); text[size] = 0;
      printf(",\"linkTarget\":"); workspace_json_string(stdout, text);
      if (!target_known) printf(",\"linkIssue\":\"unavailable\"");
    } else if (known && S_ISREG(info.st_mode)) {
      printf(",\"mtimeMs\":%.17g", (double)info.st_mtimespec.tv_sec * 1000 + (double)info.st_mtimespec.tv_nsec / 1000000);
    }
    printf("}");
  }
  printf("]"); free(names); free(ignored); closedir(directory);
}

static int workspace_file_operation(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "--workspace-file")) return 0;
  if (argc != 13) workspace_error("WORKSPACE_FILE_INVALID_REQUEST", "Invalid local file helper arguments");
  const char *action = argv[2], *root = argv[3], *name = argv[4];
  if (strcmp(action, "list") && !( !strcmp(action, "reveal") && !*name) &&
      (!*name || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")))
    workspace_error("WORKSPACE_FILE_INVALID_REQUEST", "Invalid local file basename");
  char cwd[PATH_MAX]; workspace_cwd(root, cwd);
  fprintf(stderr, "AGENTMUX_WORKSPACE_READY\n"); fflush(stderr);
  size_t length; unsigned char *input = workspace_input(STDIN_FILENO, &length);
  workspace_cwd(root, cwd);
  if (!strcmp(action, "read")) {
    const int fd = workspace_regular(name);
    if (fd < 0) workspace_errno();
    unsigned char buffer[65536];
    for (;;) {
      const ssize_t count = read(fd, buffer, sizeof(buffer));
      if (count < 0) { if (errno == EINTR) continue; workspace_errno(); }
      if (!count) break;
      workspace_write_all(STDOUT_FILENO, buffer, (size_t)count);
    }
    close(fd);
  } else if (!strcmp(action, "read-bytes")) {
    workspace_byte_range(name, (size_t)parse_identity(argv[9], "byte offset"),
      (size_t)parse_identity(argv[10], "byte length"), (size_t)parse_identity(argv[11], "file byte limit"), argv[12]);
  } else if (!strcmp(action, "write")) {
    workspace_write(name, argv[5], !strcmp(argv[6], "1"), !strcmp(argv[7], "1"), argv[8], input, length);
  } else if (!strcmp(action, "list")) {
    workspace_list();
  } else if (!strcmp(action, "reveal")) {
    if (*name) {
      const int fd = open(name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
      if (fd < 0) workspace_errno(); close(fd);
      printf("%s/%s", cwd, name);
    } else printf("%s", cwd);
  } else if (!strcmp(action, "create")) {
    if (!strcmp(argv[5], "directory")) { if (mkdir(name, 0777)) workspace_errno(); }
    else {
      const int fd = open(name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
      if (fd < 0) workspace_errno(); close(fd);
    }
  } else if (!strcmp(action, "delete")) {
    workspace_delete(AT_FDCWD, name);
  } else workspace_error("WORKSPACE_FILE_INVALID_REQUEST", "Unknown local file helper action");
  free(input); return 1;
}
