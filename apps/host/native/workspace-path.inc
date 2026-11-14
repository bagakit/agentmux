/* Exact path discovery and mkdir use the original helper's confined descriptors.
 * The private producer directory is retained across a missing reply. Readers
 * inspect it; they never re-enter publication or adopt an unrelated basename. */
typedef struct { struct stat file; long long birthtime_ns; int birthtime_known; } path_info;

static int path_entry_info(int fd, const char *name, path_info *info) {
  if (fstatat(fd, name, &info->file, AT_SYMLINK_NOFOLLOW)) return -1;
#if defined(__linux__)
  struct statx extra;
  info->birthtime_known = !statx(fd, name, AT_SYMLINK_NOFOLLOW, STATX_BTIME, &extra) && (extra.stx_mask & STATX_BTIME);
  info->birthtime_ns = info->birthtime_known ? (long long)extra.stx_btime.tv_sec * 1000000000LL + extra.stx_btime.tv_nsec : 0;
#else
  info->birthtime_ns = 0; info->birthtime_known = 1;
#endif
  return 0;
}
static int path_fd_info(int fd, path_info *info) {
  if (fstat(fd, &info->file)) return -1;
#if defined(__linux__)
  struct statx extra;
  info->birthtime_known = !statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_BTIME, &extra) && (extra.stx_mask & STATX_BTIME);
  info->birthtime_ns = info->birthtime_known ? (long long)extra.stx_btime.tv_sec * 1000000000LL + extra.stx_btime.tv_nsec : 0;
#else
  info->birthtime_ns = 0; info->birthtime_known = 1;
#endif
  return 0;
}

typedef struct {
  int root, parent;
  char root_path[PATH_MAX], parent_path[PATH_MAX], name[NAME_MAX + 1];
  path_info root_info, parent_info;
} path_scope;

static long long path_birth_ns(const path_info *info) {
#if defined(__APPLE__)
  return (long long)info->file.st_birthtimespec.tv_sec * 1000000000LL + info->file.st_birthtimespec.tv_nsec;
#else
  /* Linux exposes the original generation through statx on the pinned inode. */
  return info->birthtime_ns;
#endif
}

static void path_witness_text(const path_info *info, char *out, size_t size) {
  char birth[64]; if (info->birthtime_known) snprintf(birth, sizeof(birth), "%lld", path_birth_ns(info)); else strcpy(birth, "unavailable");
  snprintf(out, size, "%llu:%llu:%llu:%lld:%lld:%s",
    (unsigned long long)info->file.st_dev, (unsigned long long)info->file.st_ino,
    (unsigned long long)info->file.st_size, workspace_ctime(&info->file), workspace_mtime(&info->file), birth);
}

static void path_witness_output(FILE *output, const path_info *info) {
  fprintf(output, "{\"device\":\"%llu\",\"inode\":\"%llu\",\"size\":\"%llu\",\"ctimeNs\":\"%lld\",\"mtimeNs\":\"%lld\",\"birthtimeNs\":",
    (unsigned long long)info->file.st_dev, (unsigned long long)info->file.st_ino,
    (unsigned long long)info->file.st_size, workspace_ctime(&info->file), workspace_mtime(&info->file));
  if (info->birthtime_known) fprintf(output, "\"%lld\"}", path_birth_ns(info)); else fprintf(output, "null}");
}

static void path_witness_json(const path_info *info) { path_witness_output(stdout, info); }

static int path_same_entry(const path_info *a, const path_info *b) {
  char before[256], after[256]; path_witness_text(a, before, sizeof(before)); path_witness_text(b, after, sizeof(after));
  return (a->file.st_mode & S_IFMT) == (b->file.st_mode & S_IFMT) && !strcmp(before, after);
}

static int path_identity_equal(const path_info *a, const path_info *b) {
  return a->file.st_dev == b->file.st_dev && a->file.st_ino == b->file.st_ino &&
    (a->file.st_mode & S_IFMT) == (b->file.st_mode & S_IFMT) && a->birthtime_known == b->birthtime_known && (!a->birthtime_known || path_birth_ns(a) == path_birth_ns(b));
}

static int path_witness_equal(const path_info *info, const char *expected) {
  char actual[256]; path_witness_text(info, actual, sizeof(actual)); return !strcmp(actual, expected);
}

static int path_open_parent(int root, const char *path) {
  int fd = dup(root); if (fd < 0) workspace_errno();
  if (!strcmp(path, ".")) return fd;
  char *storage = strdup(path), *cursor = storage;
  if (!storage) workspace_errno();
  while (cursor) {
    char *slash = strchr(cursor, '/'); if (slash) *slash = 0;
    const int next = openat(fd, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    const int saved = errno; close(fd);
    if (next < 0) { free(storage); errno = saved; return -1; }
    fd = next; cursor = slash ? slash + 1 : NULL;
  }
  free(storage); return fd;
}

static path_scope path_open_scope(const char *root, const char *relative_path, int allow_root) {
  path_scope scope;
  if (!*root || root[0] != '/' || strlen(root) >= PATH_MAX || strlen(relative_path) >= PATH_MAX)
    workspace_error("FILE_PATH_INVALID_SCOPE", "The original absolute root and bounded relative path are required");
  if (!allow_root || strcmp(relative_path, ".")) validate_relative_path(relative_path);
  strcpy(scope.root_path, root);
  scope.root = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (scope.root < 0 || path_fd_info(scope.root, &scope.root_info)) workspace_errno();
  char *path = strdup(relative_path); if (!path) workspace_errno();
  char *slash = strrchr(path, '/');
  if (strlen(slash ? slash + 1 : path) > NAME_MAX) workspace_error("FILE_PATH_INVALID_SCOPE", "The original entry name is too long");
  strcpy(scope.name, slash ? slash + 1 : path);
  if (slash) { *slash = 0; strcpy(scope.parent_path, path); }
  else strcpy(scope.parent_path, ".");
  free(path);
  scope.parent = path_open_parent(scope.root, scope.parent_path);
  if (scope.parent < 0 || path_fd_info(scope.parent, &scope.parent_info)) workspace_errno();
  return scope;
}

static int path_scope_current(const path_scope *scope) {
  path_info root, parent;
  if (path_entry_info(AT_FDCWD, scope->root_path, &root) || !path_identity_equal(&root, &scope->root_info)) return 0;
  const int fd = path_open_parent(scope->root, scope->parent_path);
  if (fd < 0) return 0;
  const int same = !path_fd_info(fd, &parent) && path_identity_equal(&parent, &scope->parent_info);
  close(fd); return same;
}

static void path_scope_close(path_scope *scope) { close(scope->parent); close(scope->root); }

static const char *path_kind(const path_info *info) {
  return S_ISREG(info->file.st_mode) ? "file" : S_ISDIR(info->file.st_mode) ? "directory" : S_ISLNK(info->file.st_mode) ? "symlink" : "other";
}

static void path_stat(const path_scope *scope) {
  path_info entry, after, parent, root;
  const int found = !path_entry_info(scope->parent, scope->name, &entry);
  if (!found && errno != ENOENT) workspace_errno();
  char root_witness[256], parent_witness[256];
  path_witness_text(&scope->root_info, root_witness, sizeof(root_witness));
  path_witness_text(&scope->parent_info, parent_witness, sizeof(parent_witness));
  if (!path_scope_current(scope) || path_fd_info(scope->parent, &parent) || path_fd_info(scope->root, &root) ||
      !path_witness_equal(&root, root_witness) || !path_witness_equal(&parent, parent_witness))
    workspace_error("FILE_PATH_SCOPE_CHANGED", "The original root or parent changed during stat");
  const int final_found = !path_entry_info(scope->parent, scope->name, &after);
  if ((!final_found && errno != ENOENT) || final_found != found || (found && !path_same_entry(&entry, &after)))
    workspace_error("FILE_PATH_ENTRY_CHANGED", "The original directory entry changed during stat");
  printf("{\"root\":"); path_witness_json(&root); printf(",\"parent\":"); path_witness_json(&parent);
  printf(",\"parentPath\":"); workspace_json_string(stdout, scope->parent_path);
  if (found) { printf(",\"entry\":{\"kind\":\"%s\",\"witness\":", path_kind(&entry)); path_witness_json(&entry); printf("}"); }
  else printf(",\"entry\":{\"kind\":\"absent\"}");
#if defined(__APPLE__)
  const char *platform = "darwin";
#else
  const char *platform = "linux";
#endif
  printf(",\"implementation\":{\"platform\":\"%s\",\"stat\":\"native\",\"mkdir\":\"%s\"}}", platform, !root.birthtime_known || !parent.birthtime_known ? "generation-unavailable" : "native-no-replace");
}

static void path_refused(const char *code, const char *message) {
  printf("{\"action\":\"mkdir\",\"phase\":\"settled\",\"filesystem\":\"not-applied\",\"durability\":\"confirmed\",\"code\":");
  workspace_json_string(stdout, code); printf(",\"message\":"); workspace_json_string(stdout, message); printf("}");
}

static void path_created(const path_info *info, int confirmed) {
  printf("{\"action\":\"mkdir\",\"phase\":\"published\",\"filesystem\":\"created\",\"durability\":\"%s\",\"createdWitness\":", confirmed ? "confirmed" : "unconfirmed");
  path_witness_json(info); printf("}");
}

static void path_unknown(const char *message) {
  printf("{\"action\":\"mkdir\",\"phase\":\"prepared\",\"filesystem\":\"unknown\",\"durability\":\"unconfirmed\",\"code\":\"FILE_MKDIR_UNCONFIRMED\",\"message\":");
  workspace_json_string(stdout, message); printf("}");
}

/* The dedicated pipe is a stable native protocol, not stdout presentation.
 * The original Host must durably retain these identities before publication. */
static void path_offer_stage(const path_info *stage, const path_info *entry) {
  FILE *output = fdopen(dup(3), "w"); if (!output) workspace_errno();
  fprintf(output, "{\"stage\":"); path_witness_output(output, stage);
  fprintf(output, ",\"entry\":"); path_witness_output(output, entry); fprintf(output, "}\n");
  if (fflush(output) || fclose(output)) workspace_errno();
  char ack;
  if (read(4, &ack, 1) != 1 || ack != 'G') workspace_error("FILE_PATH_STAGE_UNCONFIRMED", "The original Host did not confirm its stage witness; publication was not released");
}

static int path_move_new_directory(const path_scope *scope, int stage_fd) {
#if defined(__APPLE__)
  return renameatx_np(stage_fd, "entry", scope->parent, scope->name,
    RENAME_EXCL | RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH);
#else
  return renameat2(stage_fd, "entry", scope->parent, scope->name, RENAME_NOREPLACE);
#endif
}

static int path_original_directory(const path_info *info, const char *witness) {
  if (!info->birthtime_known || strlen(witness) > 255) return 0;
  char copy[256]; strcpy(copy, witness);
  char *parts[6], *cursor = copy;
  for (int index = 0; index < 6; index++) {
    parts[index] = cursor;
    char *next = strchr(cursor, ':');
    if ((index < 5 && !next) || (index == 5 && next)) return 0;
    if (next) { *next = 0; cursor = next + 1; }
  }
  char expected[128], actual[128];
  snprintf(expected, sizeof(expected), "%s:%s:%s", parts[0], parts[1], parts[5]);
  snprintf(actual, sizeof(actual), "%llu:%llu:%lld", (unsigned long long)info->file.st_dev,
    (unsigned long long)info->file.st_ino, path_birth_ns(info));
  return !strcmp(expected, actual);
}

static void path_mkdir_inspect(const path_scope *scope, const char *root_witness,
                              const char *parent_witness, const char *entry_witness) {
  if (!path_original_directory(&scope->root_info, root_witness) || !path_original_directory(&scope->parent_info, parent_witness)) {
    path_unknown("The original root or parent generation is unavailable. No action was replayed."); return;
  }
  path_info visible;
  if (path_scope_current(scope) && !path_entry_info(scope->parent, scope->name, &visible) && S_ISDIR(visible.file.st_mode) && path_original_directory(&visible, entry_witness))
    path_created(&visible, 0);
  else path_unknown("The exact original created identity is not confirmed at its target. Its request and producer witness are retained; no action was replayed.");
}

/* Only an empty, exact original private container is retired, never user trees. */
static void path_retire_empty_stage(const path_scope *scope, const char *name, const path_info *original) {
  if (!path_scope_current(scope)) return;
  char retiring[NAME_MAX + 1];
  if (snprintf(retiring, sizeof(retiring), "%s.retired", name) > NAME_MAX) return;
  if (atomic_move_no_replace(scope->parent, name, retiring)) return;
  path_info claimed;
  if (path_entry_info(scope->parent, retiring, &claimed) || !path_identity_equal(original, &claimed)) {
    if (atomic_move_no_replace(scope->parent, retiring, name)) fprintf(stderr, "Original mkdir stage cleanup is unconfirmed; both names are retained.\n");
    return;
  }
  if (unlinkat(scope->parent, retiring, AT_REMOVEDIR)) fprintf(stderr, "Original nonempty mkdir stage is retained; no recursive cleanup was attempted.\n");
  else if (fsync(scope->parent)) fprintf(stderr, "Original empty mkdir stage cleanup sync is unconfirmed.\n");
}

static void path_mkdir(path_scope *scope, const char *stage_name,
                       const char *root_witness, const char *parent_witness, const char *fault) {
  if (!scope->root_info.birthtime_known || !scope->parent_info.birthtime_known) {
    path_refused("FILE_PATH_GENERATION_UNAVAILABLE", "This filesystem does not expose the original directory birth generation required by exact mkdir"); return;
  }
  if (!path_original_directory(&scope->root_info, root_witness) || !path_original_directory(&scope->parent_info, parent_witness)) {
    path_refused("FILE_PATH_SCOPE_CONFLICT", "The observed original root or parent generation changed"); return;
  }
  if (!strcmp(fault, "before-stage-crash")) _exit(91);
  commit_barrier(!strcmp(fault, "before-stage-barrier"), 3, 4, "before-path-stage");
  if (!path_scope_current(scope)) { path_refused("FILE_PATH_SCOPE_CONFLICT", "The original parent moved before directory creation"); return; }
  path_info target;
  if (!path_entry_info(scope->parent, scope->name, &target) || errno != ENOENT) {
    path_refused("FILE_PATH_OCCUPIED", "The destination entry is occupied or its absence is unconfirmed"); return;
  }
  if (mkdirat(scope->parent, stage_name, 0700)) workspace_errno();
  const int stage = openat(scope->parent, stage_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (stage < 0 || mkdirat(stage, "entry", 0777)) workspace_errno();
  path_info entry;
  if (path_entry_info(stage, "entry", &entry)) workspace_errno();
  path_info stage_info;
  if (path_fd_info(stage, &stage_info)) workspace_errno();
  const int entry_fd = openat(stage, "entry", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (entry_fd < 0 || fsync(entry_fd) || fsync(stage) || fsync(scope->parent)) workspace_errno();
  if (!entry.birthtime_known || !stage_info.birthtime_known) {
    close(entry_fd); close(stage); path_refused("FILE_PATH_GENERATION_UNAVAILABLE", "The created directory generation is unavailable; no publication was issued"); return;
  }
  if (!strcmp(fault, "before-stage-offer-crash")) _exit(95);
  path_offer_stage(&stage_info, &entry);
  if (!strcmp(fault, "after-stage-crash")) _exit(92);
  commit_barrier(!strcmp(fault, "before-publish-barrier"), 5, 6, "before-path-publish");
  if (!path_scope_current(scope)) { close(entry_fd); close(stage); path_refused("FILE_PATH_SCOPE_CONFLICT", "The original parent changed before publication; its private stage is retained"); return; }
  path_info current_stage, current_entry;
  if (path_entry_info(scope->parent, stage_name, &current_stage) || path_fd_info(stage, &target) || !path_identity_equal(&current_stage, &target) ||
      path_entry_info(stage, "entry", &current_entry) || !path_identity_equal(&current_entry, &entry))
    workspace_error("FILE_PATH_STAGE_CHANGED", "The original private producer stage changed");
  commit_barrier(!strcmp(fault, "at-publish-barrier"), 5, 6, "at-path-publish");
  if (path_move_new_directory(scope, stage)) {
    if (errno == EEXIST || errno == ENOTEMPTY) { close(entry_fd); close(stage); path_refused("FILE_PATH_OCCUPIED", "A later destination entry was preserved"); return; }
    if (errno == ENOSYS || errno == ENOTSUP || errno == EOPNOTSUPP) { close(entry_fd); close(stage); path_refused("FILE_PATH_NATIVE_UNSUPPORTED", "This kernel or filesystem does not support atomic no-replace directory publication; existing entries and the original stage are retained"); return; }
    workspace_errno();
  }
  workspace_write_published = 1;
  if (!strcmp(fault, "after-publish-crash")) _exit(93);
  if (!strcmp(fault, "directory-sync")) workspace_error("EIO", "Injected directory confirmation failure");
  if (fsync(entry_fd) || fsync(stage) || fsync(scope->parent) || fsync(scope->root)) workspace_errno();
  if (!path_scope_current(scope) || path_entry_info(scope->parent, scope->name, &target) || !path_identity_equal(&entry, &target))
    workspace_error("FILE_PATH_SCOPE_CHANGED", "The original scope or created identity changed after publication");
  if (!strcmp(fault, "lost-reply")) _exit(94);
  path_retire_empty_stage(scope, stage_name, &stage_info);
  path_created(&target, 1); close(entry_fd); close(stage);
}

static int workspace_path_operation(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "--workspace-path")) return 0;
  if (argc < 5 || (strcmp(argv[2], "stat") && strcmp(argv[2], "mkdir") && strcmp(argv[2], "inspect")))
    workspace_error("FILE_PATH_INVALID_REQUEST", "Invalid original path helper action");
  const int observe = !strcmp(argv[2], "stat"), inspect = !strcmp(argv[2], "inspect");
  if (argc != (observe ? 5 : 10)) workspace_error("FILE_PATH_INVALID_REQUEST", "Invalid original path helper arguments");
  path_scope scope = path_open_scope(argv[3], argv[4], observe);
  fprintf(stderr, "AGENTMUX_WORKSPACE_READY\n"); fflush(stderr);
  size_t length; unsigned char *input = workspace_input(STDIN_FILENO, &length); free(input);
  if (observe) path_stat(&scope);
  else {
    const char *stage = argv[5], *digest = argv[6], *root_witness = argv[7], *parent_witness = argv[8];
    if (strlen(stage) > NAME_MAX || strncmp(stage, ".agentmux-mkdir-", 16) || strchr(stage, '/') || strlen(digest) != 64 || strspn(digest, "0123456789abcdef") != 64)
      workspace_error("FILE_PATH_INVALID_REQUEST", "The exact private producer and original digest are required");
    if (strcmp(stage + 16, digest)) workspace_error("FILE_PATH_INVALID_REQUEST", "The original producer name does not match its intent digest");
    if (inspect) path_mkdir_inspect(&scope, root_witness, parent_witness, argv[9]);
    else path_mkdir(&scope, stage, root_witness, parent_witness, argv[9]);
  }
  path_scope_close(&scope); return 1;
}
