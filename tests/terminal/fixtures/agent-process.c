#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* Keep the real executable name and argv visible to ps, including native Codex names. */
static void json_string(FILE *stream, const char *value) {
    fputc('"', stream);
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        if (*p == '"' || *p == '\\') fprintf(stream, "\\%c", *p);
        else if (*p < 0x20) fprintf(stream, "\\u%04x", *p);
        else fputc(*p, stream);
    }
    fputc('"', stream);
}

int main(int argc, char **argv) {
    const char *log_path = getenv("D4_AGENT_ARGS_LOG");
    if (log_path && *log_path) {
        FILE *log = fopen(log_path, "a");
        if (!log) return 2;
        fputs("{\"argv\":[", log);
        for (int i = 0; i < argc; i++) {
            if (i) fputc(',', log);
            json_string(log, argv[i]);
        }
        fputs("]}\n", log);
        fclose(log);
    }
    puts("D4_AGENT_READY");
    fflush(stdout);
    const char *lifetime = getenv("D4_AGENT_LIFETIME_SECONDS");
    unsigned int seconds = lifetime ? (unsigned int)atoi(lifetime) : 10;
    if (seconds == 0 || seconds > 120) seconds = 10;
    sleep(seconds);
    return 0;
}
