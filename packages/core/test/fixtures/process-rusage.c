#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <libproc.h>

enum {
  calibration_samples = 256,
};

static const uint64_t calibration_sampling_delay_nanoseconds = 100000;
static volatile uint64_t burn_sink = 0;

struct process_sample {
  uint64_t monotonic_before_nanoseconds;
  uint64_t monotonic_after_nanoseconds;
  uint64_t user_nanoseconds;
  uint64_t system_nanoseconds;
};

static int monotonic_raw_nanoseconds(uint64_t *result) {
  struct timespec value = {0};
  if (clock_gettime(CLOCK_MONOTONIC_RAW, &value) != 0) {
    perror("clock_gettime");
    return 1;
  }
  *result = (uint64_t)value.tv_sec * 1000000000ULL + (uint64_t)value.tv_nsec;
  return 0;
}

static int sample_process(int pid, struct process_sample *sample) {
  struct rusage_info_v4 usage = {0};
  if (monotonic_raw_nanoseconds(&sample->monotonic_before_nanoseconds) != 0) return 1;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
    perror("proc_pid_rusage");
    return 1;
  }
  if (monotonic_raw_nanoseconds(&sample->monotonic_after_nanoseconds) != 0) return 1;
  sample->user_nanoseconds = usage.ri_user_time;
  sample->system_nanoseconds = usage.ri_system_time;
  return 0;
}

static int total_cpu_nanoseconds(const struct process_sample *sample, uint64_t *result) {
  if (UINT64_MAX - sample->user_nanoseconds < sample->system_nanoseconds) {
    fprintf(stderr, "process CPU counter overflow\n");
    return 1;
  }
  *result = sample->user_nanoseconds + sample->system_nanoseconds;
  return 0;
}

static void burn_cpu(pid_t expected_parent) {
  for (;;) {
    for (uint64_t index = 0; index < 4096; index += 1) {
      burn_sink = burn_sink * 6364136223846793005ULL + index + 1442695040888963407ULL;
    }
    if (getppid() != expected_parent) _exit(1);
  }
}

static int calibration_sampling_pause(void) {
  struct timespec remaining = {
      .tv_sec = 0,
      .tv_nsec = (long)calibration_sampling_delay_nanoseconds,
  };
  while (nanosleep(&remaining, &remaining) != 0) {
    if (errno != EINTR) {
      perror("nanosleep");
      return 1;
    }
  }
  return 0;
}

static int stop_calibration_child(pid_t child) {
  if (kill(child, SIGKILL) != 0 && errno != ESRCH) {
    perror("kill");
    return 1;
  }
  int status = 0;
  pid_t waited = 0;
  do {
    waited = waitpid(child, &status, 0);
  } while (waited < 0 && errno == EINTR);
  if (waited != child) {
    perror("waitpid");
    return 1;
  }
  return 0;
}

static int calibrate(void) {
  int readiness[2] = {-1, -1};
  if (pipe(readiness) != 0) {
    perror("pipe");
    return 1;
  }
  const pid_t child = fork();
  if (child < 0) {
    perror("fork");
    close(readiness[0]);
    close(readiness[1]);
    return 1;
  }
  if (child == 0) {
    const pid_t expected_parent = getppid();
    close(readiness[0]);
    const char ready = '1';
    if (write(readiness[1], &ready, 1) != 1) _exit(1);
    close(readiness[1]);
    burn_cpu(expected_parent);
    _exit(0);
  }
  close(readiness[1]);
  char ready = '\0';
  const ssize_t readiness_bytes = read(readiness[0], &ready, 1);
  close(readiness[0]);
  if (readiness_bytes != 1 || ready != '1') {
    fprintf(stderr, "calibration child did not become ready\n");
    stop_calibration_child(child);
    return 1;
  }

  struct process_sample previous = {0};
  if (sample_process(child, &previous) != 0) {
    stop_calibration_child(child);
    return 1;
  }
  uint64_t previous_total = 0;
  if (total_cpu_nanoseconds(&previous, &previous_total) != 0) {
    stop_calibration_child(child);
    return 1;
  }

  printf(
      "calibration %d %" PRIu64 "\n",
      calibration_samples,
      calibration_sampling_delay_nanoseconds);
  for (int index = 0; index < calibration_samples; index += 1) {
    if (calibration_sampling_pause() != 0) {
      stop_calibration_child(child);
      return 1;
    }
    struct process_sample current = {0};
    if (sample_process(child, &current) != 0) {
      stop_calibration_child(child);
      return 1;
    }
    uint64_t current_total = 0;
    if (total_cpu_nanoseconds(&current, &current_total) != 0) {
      stop_calibration_child(child);
      return 1;
    }
    if (current_total < previous_total) {
      fprintf(stderr, "process CPU counter regressed\n");
      stop_calibration_child(child);
      return 1;
    }
    const uint64_t step = current_total - previous_total;
    if (step > 0) printf("step %" PRIu64 "\n", step);
    previous_total = current_total;
  }
  return stop_calibration_child(child);
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fprintf(stderr, "usage: process-rusage <pid|--calibrate>\n");
    return 2;
  }

  if (strcmp(argv[1], "--calibrate") == 0) return calibrate();

  errno = 0;
  char *end = NULL;
  const long parsed = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || parsed <= 1 || parsed > INT_MAX) {
    fprintf(stderr, "invalid pid\n");
    return 2;
  }

  struct process_sample sample = {0};
  if (sample_process((int)parsed, &sample) != 0) return 1;
  printf(
      "sample %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
      sample.monotonic_before_nanoseconds,
      sample.monotonic_after_nanoseconds,
      sample.user_nanoseconds,
      sample.system_nanoseconds);
  return 0;
}
