/*
 * Sends DMX512 frames through a USB serial adapter with no controller of its own (the Enttec Open DMX USB and its FTDI clones).
 * Used by main/dmx.ts.
 *
 *   dmxsend <device> [raw]
 *
 * stdin: the 512 slots of a universe, in blocks of 512 bytes, whenever they change. The newest block is sent again about 30 times
 * a second, since fixtures expect a steady signal. Nothing is sent before the first block arrives (so no stray darkness at start-up).
 * stderr: "READY" once the line is set up, or "ERROR <reason>". The program ends when stdin does.
 *
 * Open DMX has no chip that makes the signal: each frame is a break (line held low), a mark, the start code 0 and the slots at
 * 250000 baud, 8 data bits, 2 stop bits, all produced here. The timings below are minimums; a host that is a little late only
 * sends a longer break, which fixtures accept. `raw` is for tests: the device is an ordinary file that always holds the latest
 * frame (start code and slots), with no line setup.
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <termios.h>
/* From IOKit/serial/ioss.h, declared here so nothing but libc is needed. */
#define IOSSIOSPEED _IOW('T', 2, speed_t)
#elif defined(__linux__)
#include <asm/termbits.h> /* struct termios2: an arbitrary baud rate; not mixed with <termios.h>, which defines the same names */
#endif

#define SLOTS 512
#define FRAME_MS 33
#define BREAK_US 120
#define MARK_US 16

static int fd = -1;
static int raw_mode = 0;
static uint8_t frame[SLOTS + 1]; /* start code 0, then the slots */

static void fail(const char* what) {
  fprintf(stderr, "ERROR %s: %s\n", what, strerror(errno));
  exit(1);
}

static long now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (long)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}

static void line_setup(void) {
#ifdef __APPLE__
  struct termios t;
  if (tcgetattr(fd, &t) != 0) fail("tcgetattr");
  cfmakeraw(&t);
  t.c_cflag &= ~(PARENB | CRTSCTS | CSIZE);
  t.c_cflag |= CS8 | CSTOPB | CLOCAL | CREAD;
  if (tcsetattr(fd, TCSANOW, &t) != 0) fail("tcsetattr");
  speed_t speed = 250000;
  if (ioctl(fd, IOSSIOSPEED, &speed) != 0) fail("the driver does not accept 250000 baud");
#elif defined(__linux__)
  struct termios2 t;
  if (ioctl(fd, TCGETS2, &t) != 0) fail("TCGETS2");
  t.c_iflag = 0;
  t.c_oflag = 0;
  t.c_lflag = 0;
  t.c_cflag &= ~(CBAUD | CSIZE | PARENB | CRTSCTS);
  t.c_cflag |= BOTHER | CS8 | CSTOPB | CLOCAL | CREAD;
  t.c_ispeed = 250000;
  t.c_ospeed = 250000;
  if (ioctl(fd, TCSETS2, &t) != 0) fail("the driver does not accept 250000 baud");
#else
  fail("this platform is not supported");
#endif
}

static void drain(void) {
#ifdef __APPLE__
  tcdrain(fd);
#else
  ioctl(fd, TCSBRK, 1);
#endif
}

static void send_frame(void) {
  if (raw_mode) {
    if (pwrite(fd, frame, sizeof frame, 0) != (ssize_t)sizeof frame) fail("write");
    return;
  }
  if (ioctl(fd, TIOCSBRK, 0) != 0) fail("the driver does not support a break");
  usleep(BREAK_US);
  ioctl(fd, TIOCCBRK, 0);
  usleep(MARK_US);
  size_t done = 0;
  while (done < sizeof frame) {
    ssize_t n = write(fd, frame + done, sizeof frame - done);
    if (n < 0) {
      if (errno == EINTR) continue;
      fail("write");
    }
    done += (size_t)n;
  }
  drain();
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "ERROR usage: dmxsend <device> [raw]\n");
    return 2;
  }
  signal(SIGPIPE, SIG_IGN);
  raw_mode = argc > 2 && strcmp(argv[2], "raw") == 0;
  fd = raw_mode ? open(argv[1], O_WRONLY | O_CREAT | O_TRUNC, 0644) : open(argv[1], O_RDWR | O_NOCTTY);
  if (fd < 0) fail("cannot open the interface");
  if (!raw_mode) line_setup();
  fprintf(stderr, "READY\n");
  fflush(stderr);

  uint8_t in[SLOTS];
  size_t have = 0;
  int started = 0;
  long next = 0;
  for (;;) {
    long wait = started ? next - now_ms() : -1;
    if (started && wait < 0) wait = 0;
    struct pollfd p = { .fd = 0, .events = POLLIN };
    int r = poll(&p, 1, (int)wait);
    if (r < 0 && errno != EINTR) fail("poll");
    if (r > 0 && (p.revents & (POLLIN | POLLHUP))) {
      ssize_t n = read(0, in + have, SLOTS - have);
      if (n == 0) break; /* stdin closed: done */
      if (n < 0 && errno != EINTR && errno != EAGAIN) break;
      if (n > 0) have += (size_t)n;
      if (have == SLOTS) {
        memcpy(frame + 1, in, SLOTS);
        have = 0;
        if (!started) { started = 1; next = now_ms(); }
      }
    }
    if (started && now_ms() >= next) {
      send_frame();
      next += FRAME_MS;
      if (next < now_ms()) next = now_ms() + FRAME_MS; /* far behind (the machine slept): do not rush to catch up */
    }
  }
  return 0;
}
