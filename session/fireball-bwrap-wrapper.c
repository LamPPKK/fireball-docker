#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef FIREBALL_BWRAP_POLICY_TEST
#include <sys/mman.h>
#endif

#define FIREBALL_MAX_ARGUMENT_BYTES (1024U * 1024U)
#define FIREBALL_REAL_BWRAP "/usr/lib/fireball/bwrap.real"

static int fail(const char *message)
{
    fprintf(stderr, "fireball-bwrap: %s\n", message);
    return -1;
}

static bool token_equals(const char *token, size_t length, const char *expected)
{
    size_t expected_length = strlen(expected);
    return length == expected_length && memcmp(token, expected, length) == 0;
}

static bool numeric_fd(const char *token, size_t length)
{
    if (length == 0 || length > 10)
        return false;
    for (size_t index = 0; index < length; ++index) {
        if (token[index] < '0' || token[index] > '9')
            return false;
    }
    return true;
}

static int append_token(char *output, size_t capacity, size_t *length, const char *token, size_t token_length)
{
    if (token_length == 0 || *length > capacity || token_length >= capacity - *length)
        return fail("rewritten argument file exceeds its bound");
    memcpy(output + *length, token, token_length);
    *length += token_length;
    output[(*length)++] = '\0';
    return 0;
}

static int next_token(
    const char *input,
    size_t input_length,
    size_t position,
    const char **token,
    size_t *token_length,
    size_t *next_position)
{
    if (position >= input_length)
        return fail("argument file ended unexpectedly");
    const char *start = input + position;
    const char *end = memchr(start, '\0', input_length - position);
    if (end == NULL || end == start)
        return fail("argument file contains a missing or empty terminator");
    *token = start;
    *token_length = (size_t)(end - start);
    *next_position = position + *token_length + 1;
    return 0;
}

static int rewrite_webkit_arguments(
    const char *input,
    size_t input_length,
    char *output,
    size_t output_capacity,
    size_t *output_length)
{
    if (input_length == 0 || input_length > FIREBALL_MAX_ARGUMENT_BYTES || input[input_length - 1] != '\0')
        return fail("argument file is empty, oversized, or unterminated");

    unsigned int unshare_pid_count = 0;
    unsigned int proc_count = 0;
    unsigned int seccomp_count = 0;
    unsigned int unshare_uts_count = 0;
    size_t position = 0;
    *output_length = 0;

    while (position < input_length) {
        const char *token;
        size_t token_length;
        size_t after_token;
        if (next_token(input, input_length, position, &token, &token_length, &after_token) != 0)
            return -1;

        if (token_equals(token, token_length, "--args"))
            return fail("nested --args is forbidden");
        if (token_equals(token, token_length, "--pidns"))
            return fail("an externally supplied PID namespace is forbidden");
        if (token_equals(token, token_length, "--cap-add")
            || token_equals(token, token_length, "--cap-drop")
            || token_equals(token, token_length, "--not-a-security-boundary"))
            return fail("capability or non-boundary overrides are forbidden");

        if (token_equals(token, token_length, "--unshare-pid")) {
            ++unshare_pid_count;
            position = after_token;
            continue;
        }

        if (token_equals(token, token_length, "--proc")) {
            const char *destination;
            size_t destination_length;
            size_t after_destination;
            if (next_token(
                    input,
                    input_length,
                    after_token,
                    &destination,
                    &destination_length,
                    &after_destination)
                != 0)
                return -1;
            if (!token_equals(destination, destination_length, "/proc"))
                return fail("WebKit procfs destination changed");
            ++proc_count;
            if (append_token(output, output_capacity, output_length, "--ro-bind", 9) != 0
                || append_token(output, output_capacity, output_length, "/proc", 5) != 0
                || append_token(output, output_capacity, output_length, "/proc", 5) != 0)
                return -1;
            position = after_destination;
            continue;
        }

        if (token_equals(token, token_length, "--seccomp")) {
            const char *descriptor;
            size_t descriptor_length;
            size_t ignored;
            if (next_token(
                    input,
                    input_length,
                    after_token,
                    &descriptor,
                    &descriptor_length,
                    &ignored)
                != 0)
                return -1;
            if (!numeric_fd(descriptor, descriptor_length))
                return fail("WebKit seccomp descriptor is invalid");
            ++seccomp_count;
        }
        if (token_equals(token, token_length, "--unshare-uts"))
            ++unshare_uts_count;

        if (append_token(output, output_capacity, output_length, token, token_length) != 0)
            return -1;
        position = after_token;
    }

    if (unshare_pid_count != 1 || proc_count != 1 || seccomp_count != 1 || unshare_uts_count != 1)
        return fail("WebKit sandbox invariants are missing or duplicated");
    return 0;
}

#ifdef FIREBALL_BWRAP_POLICY_TEST

static void require(bool condition, const char *message)
{
    if (!condition) {
        fprintf(stderr, "fireball-bwrap-policy-test: %s\n", message);
        exit(1);
    }
}

static int rewrite_fixture(const char *input, size_t input_length, char *output, size_t *output_length)
{
    memset(output, 0, 1024);
    return rewrite_webkit_arguments(input, input_length, output, 1024, output_length);
}

int main(void)
{
    static const char valid[] = "--unshare-uts\0--proc\0/proc\0--unshare-pid\0--unshare-net\0--seccomp\0" "7\0--ro-bind\0/etc\0/etc\0";
    static const char expected[] = "--unshare-uts\0--ro-bind\0/proc\0/proc\0--unshare-net\0--seccomp\0" "7\0--ro-bind\0/etc\0/etc\0";
    char output[1024];
    size_t output_length = 0;
    require(rewrite_fixture(valid, sizeof(valid) - 1, output, &output_length) == 0, "valid WebKit arguments were rejected");
    require(output_length == sizeof(expected) - 1, "rewritten argument size is wrong");
    require(memcmp(output, expected, output_length) == 0, "PID/proc rewrite is wrong");

    static const char missing_pid[] = "--unshare-uts\0--proc\0/proc\0--seccomp\0" "7\0";
    static const char duplicate_pid[] = "--unshare-uts\0--proc\0/proc\0--unshare-pid\0--unshare-pid\0--seccomp\0" "7\0";
    static const char changed_proc[] = "--unshare-uts\0--proc\0/private-proc\0--unshare-pid\0--seccomp\0" "7\0";
    static const char external_pid[] = "--unshare-uts\0--proc\0/proc\0--unshare-pid\0--pidns\0" "8\0--seccomp\0" "7\0";
    static const char capability[] = "--unshare-uts\0--proc\0/proc\0--unshare-pid\0--cap-add\0CAP_SYS_ADMIN\0--seccomp\0" "7\0";
    static const char nested_args[] = "--unshare-uts\0--proc\0/proc\0--unshare-pid\0--args\0" "8\0--seccomp\0" "7\0";
    static const char missing_seccomp[] = "--unshare-uts\0--proc\0/proc\0--unshare-pid\0";
    static const char unterminated[] = "--unshare-uts";

    require(rewrite_fixture(missing_pid, sizeof(missing_pid) - 1, output, &output_length) != 0, "missing PID marker accepted");
    require(rewrite_fixture(duplicate_pid, sizeof(duplicate_pid) - 1, output, &output_length) != 0, "duplicate PID marker accepted");
    require(rewrite_fixture(changed_proc, sizeof(changed_proc) - 1, output, &output_length) != 0, "changed proc destination accepted");
    require(rewrite_fixture(external_pid, sizeof(external_pid) - 1, output, &output_length) != 0, "external PID namespace accepted");
    require(rewrite_fixture(capability, sizeof(capability) - 1, output, &output_length) != 0, "capability override accepted");
    require(rewrite_fixture(nested_args, sizeof(nested_args) - 1, output, &output_length) != 0, "nested argument file accepted");
    require(rewrite_fixture(missing_seccomp, sizeof(missing_seccomp) - 1, output, &output_length) != 0, "missing WebKit seccomp accepted");
    require(rewrite_fixture(unterminated, sizeof(unterminated) - 1, output, &output_length) != 0, "unterminated data accepted");

    puts("fireball bwrap argument policy passed");
    return 0;
}

#else

static int parse_fd(const char *value)
{
    char *end = NULL;
    errno = 0;
    long descriptor = strtol(value, &end, 10);
    if (errno != 0 || value[0] == '\0' || end == NULL || *end != '\0' || descriptor < 3 || descriptor > INT_MAX)
        return -1;
    return (int)descriptor;
}

static int write_all(int descriptor, const char *data, size_t length)
{
    size_t written = 0;
    while (written < length) {
        ssize_t result = write(descriptor, data + written, length - written);
        if (result < 0 && errno == EINTR)
            continue;
        if (result <= 0)
            return fail("failed to write rewritten argument file");
        written += (size_t)result;
    }
    return 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--version") == 0) {
        execv(FIREBALL_REAL_BWRAP, argv);
        perror("fireball-bwrap: exec real bubblewrap");
        return 125;
    }
    if (argc < 5 || strcmp(argv[1], "--args") != 0 || strcmp(argv[3], "--") != 0)
        return fail("only WebKit's sealed --args launch form is supported") == 0 ? 0 : 125;

    int source_fd = parse_fd(argv[2]);
    if (source_fd < 0)
        return fail("argument descriptor is invalid") == 0 ? 0 : 125;
    struct stat metadata;
    if (fstat(source_fd, &metadata) != 0 || !S_ISREG(metadata.st_mode)
        || metadata.st_size <= 0 || (uintmax_t)metadata.st_size > FIREBALL_MAX_ARGUMENT_BYTES)
        return fail("argument descriptor is not a bounded regular file") == 0 ? 0 : 125;
    int source_seals = fcntl(source_fd, F_GET_SEALS);
    const int required_seals = F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE | F_SEAL_SEAL;
    if (source_seals < 0 || (source_seals & required_seals) != required_seals)
        return fail("argument descriptor is not the sealed WebKit memfd") == 0 ? 0 : 125;

    size_t input_length = (size_t)metadata.st_size;
    char *input = malloc(input_length);
    char *output = malloc(input_length + 64);
    if (input == NULL || output == NULL)
        return fail("argument buffer allocation failed") == 0 ? 0 : 125;
    if (lseek(source_fd, 0, SEEK_SET) < 0)
        return fail("cannot rewind argument descriptor") == 0 ? 0 : 125;
    size_t consumed = 0;
    while (consumed < input_length) {
        ssize_t result = read(source_fd, input + consumed, input_length - consumed);
        if (result < 0 && errno == EINTR)
            continue;
        if (result <= 0)
            return fail("cannot read complete argument file") == 0 ? 0 : 125;
        consumed += (size_t)result;
    }

    size_t output_length = 0;
    if (rewrite_webkit_arguments(input, input_length, output, input_length + 64, &output_length) != 0)
        return 125;

    int rewritten_fd = memfd_create("fireball-bwrap-args", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (rewritten_fd < 0 || write_all(rewritten_fd, output, output_length) != 0
        || lseek(rewritten_fd, 0, SEEK_SET) < 0
        || fcntl(rewritten_fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE | F_SEAL_SEAL) < 0)
        return fail("cannot create sealed rewritten argument file") == 0 ? 0 : 125;
    int descriptor_flags = fcntl(rewritten_fd, F_GETFD);
    if (descriptor_flags < 0 || fcntl(rewritten_fd, F_SETFD, descriptor_flags & ~FD_CLOEXEC) < 0)
        return fail("cannot pass rewritten argument descriptor") == 0 ? 0 : 125;

    char descriptor_text[32];
    if (snprintf(descriptor_text, sizeof(descriptor_text), "%d", rewritten_fd) <= 0)
        return fail("cannot format rewritten argument descriptor") == 0 ? 0 : 125;
    argv[2] = descriptor_text;
    close(source_fd);
    free(input);
    free(output);
    execv(FIREBALL_REAL_BWRAP, argv);
    perror("fireball-bwrap: exec real bubblewrap");
    return 125;
}

#endif
