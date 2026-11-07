/*
 * Sends raw frames over NDI (and, for tests, receives one). Used by main/ndi.ts.
 *
 *   ndisend send <library> <source name> <width> <height> <fps> [audio]
 *                         reads BGRA frames from stdin, one NDI source per process; with `audio`, also interleaved stereo
 *                         f32 samples at 48 kHz from file descriptor 3 (macOS and Linux)
 *   ndisend receive <library> <name part> <milliseconds>           prints the size and centre pixel of the last frame received
 *
 * NDI's library is loaded at run time (nothing of it is linked or bundled here) and only the few calls and structs needed are
 * declared below, copied from the field order of NDI's Processing.NDI.* headers. stderr gets "READY" once sending can begin
 * or "ERROR <reason>"; the program ends when stdin does.
 */
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#define LOAD(path) ((void*)LoadLibraryA(path))
#define SYM(lib, name) ((void*)GetProcAddress((HMODULE)(lib), name))
#else
#include <dlfcn.h>
#include <pthread.h>
#include <unistd.h>
#define LOAD(path) dlopen(path, RTLD_NOW | RTLD_LOCAL)
#define SYM(lib, name) dlsym(lib, name)
#endif

#define FOURCC(a, b, c, d) ((uint32_t)(uint8_t)(a) | ((uint32_t)(uint8_t)(b) << 8) | ((uint32_t)(uint8_t)(c) << 16) | ((uint32_t)(uint8_t)(d) << 24))

typedef struct { const char* p_ndi_name; const char* p_groups; bool clock_video; bool clock_audio; } send_create_t;
typedef struct {
  int xres, yres;
  uint32_t FourCC;
  int frame_rate_N, frame_rate_D;
  float picture_aspect_ratio;
  int frame_format_type; /* 1 = progressive */
  int64_t timecode;
  uint8_t* p_data;
  int line_stride_in_bytes;
  const char* p_metadata;
  int64_t timestamp;
} video_frame_t;
typedef struct {
  int sample_rate, no_channels, no_samples;
  int64_t timecode;
  float* p_data; /* planar: all samples of channel 0, then channel 1 */
  int channel_stride_in_bytes;
  const char* p_metadata;
  int64_t timestamp;
} audio_frame_t;
typedef struct { const char* p_ndi_name; const char* p_url_address; } source_t;
typedef struct { bool show_local_sources; const char* p_groups; const char* p_extra_ips; } find_create_t;
typedef struct { source_t source_to_connect_to; int color_format; int bandwidth; bool allow_video_fields; const char* p_ndi_recv_name; } recv_create_t;

static bool (*ndi_initialize)(void);
static void (*ndi_destroy)(void);
static void* (*send_create)(const send_create_t*);
static void (*send_video)(void*, const video_frame_t*);
static void (*send_audio)(void*, const audio_frame_t*);
static void (*send_destroy)(void*);
static void* (*find_create)(const find_create_t*);
static bool (*find_wait)(void*, uint32_t);
static const source_t* (*find_sources)(void*, uint32_t*);
static void (*find_destroy)(void*);
static void* (*recv_create)(const recv_create_t*);
static int (*recv_capture)(void*, video_frame_t*, void*, void*, uint32_t);
static void (*recv_free_video)(void*, const video_frame_t*);
static void (*recv_free_audio)(void*, const audio_frame_t*);
static void (*recv_destroy)(void*);

static int fail(const char* what) { fprintf(stderr, "ERROR %s\n", what); fflush(stderr); return 1; }

static int load(const char* path, bool receiving) {
  void* lib = LOAD(path);
  if (!lib) return fail("the NDI library could not be loaded");
  *(void**)&ndi_initialize = SYM(lib, "NDIlib_initialize");
  *(void**)&ndi_destroy = SYM(lib, "NDIlib_destroy");
  *(void**)&send_create = SYM(lib, "NDIlib_send_create");
  *(void**)&send_video = SYM(lib, "NDIlib_send_send_video_v2");
  *(void**)&send_audio = SYM(lib, "NDIlib_send_send_audio_v2");
  *(void**)&send_destroy = SYM(lib, "NDIlib_send_destroy");
  if (!ndi_initialize || !send_create || !send_video || !send_destroy) return fail("the NDI library lacks the sending functions");
  if (receiving) {
    *(void**)&find_create = SYM(lib, "NDIlib_find_create_v2");
    *(void**)&find_wait = SYM(lib, "NDIlib_find_wait_for_sources");
    *(void**)&find_sources = SYM(lib, "NDIlib_find_get_current_sources");
    *(void**)&find_destroy = SYM(lib, "NDIlib_find_destroy");
    *(void**)&recv_create = SYM(lib, "NDIlib_recv_create_v3");
    *(void**)&recv_capture = SYM(lib, "NDIlib_recv_capture_v2");
    *(void**)&recv_free_video = SYM(lib, "NDIlib_recv_free_video_v2");
    *(void**)&recv_free_audio = SYM(lib, "NDIlib_recv_free_audio_v2");
    *(void**)&recv_destroy = SYM(lib, "NDIlib_recv_destroy");
    if (!find_create || !find_wait || !find_sources || !find_destroy || !recv_create || !recv_capture || !recv_free_video || !recv_free_audio || !recv_destroy) return fail("the NDI library lacks the receiving functions");
  }
  if (!ndi_initialize()) return fail("NDI cannot run on this computer (unsupported CPU)");
  return 0;
}

#ifndef _WIN32
#define AUDIO_RATE 48000
#define AUDIO_FD 3
/* Reads interleaved stereo from fd 3 and sends it as NDI audio. NDI allows audio and video to be sent from different threads. */
static void* audio_thread(void* sender) {
  enum { CHUNK = 4096 }; /* frames per read at most */
  static float in[CHUNK * 2], planar[CHUNK * 2];
  size_t have = 0; /* bytes of a partial frame carried over */
  for (;;) {
    ssize_t n = read(AUDIO_FD, (char*)in + have, sizeof in - have);
    if (n <= 0) return NULL;
    size_t bytes = have + (size_t)n;
    size_t frames = bytes / 8;
    for (size_t i = 0; i < frames; i++) { planar[i] = in[i * 2]; planar[frames + i] = in[i * 2 + 1]; }
    have = bytes - frames * 8;
    if (have) memmove(in, (char*)in + frames * 8, have);
    if (!frames) continue;
    audio_frame_t a;
    memset(&a, 0, sizeof a);
    a.sample_rate = AUDIO_RATE; a.no_channels = 2; a.no_samples = (int)frames; a.timecode = INT64_MAX;
    a.p_data = planar; a.channel_stride_in_bytes = (int)(frames * sizeof(float));
    send_audio(sender, &a);
  }
}
#endif

static int send_main(char** a, bool audio) {
  const char* name = a[3];
  int width = atoi(a[4]), height = atoi(a[5]), fps = atoi(a[6]);
  if (width < 16 || height < 16 || fps < 1) return fail("bad size or frame rate");
  if (load(a[2], false)) return 1;
  send_create_t create = { name, NULL, false, false }; /* the caller paces the frames */
  void* sender = send_create(&create);
  if (!sender) return fail("the NDI sender could not be created");
  size_t bytes = (size_t)width * height * 4;
  uint8_t* buf = malloc(bytes);
  if (!buf) return fail("out of memory");
  video_frame_t frame;
  memset(&frame, 0, sizeof frame);
  frame.xres = width; frame.yres = height; frame.FourCC = FOURCC('B', 'G', 'R', 'A');
  frame.frame_rate_N = fps; frame.frame_rate_D = 1; frame.picture_aspect_ratio = (float)width / height;
  frame.frame_format_type = 1; frame.timecode = INT64_MAX; /* let NDI make the timecode */
  frame.p_data = buf; frame.line_stride_in_bytes = width * 4;
#ifndef _WIN32
  if (audio) {
    if (!send_audio) return fail("the NDI library lacks the audio functions");
    pthread_t t;
    if (pthread_create(&t, NULL, audio_thread, sender)) return fail("the audio thread could not start");
    pthread_detach(t);
  }
#else
  if (audio) return fail("sound is not supported on Windows yet");
#endif
  fprintf(stderr, "READY\n"); fflush(stderr);
  for (;;) {
    size_t got = 0;
    while (got < bytes) {
      size_t n = fread(buf + got, 1, bytes - got, stdin);
      if (n == 0) goto done;
      got += n;
    }
    send_video(sender, &frame);
  }
done:
#ifndef _WIN32
  if (audio) { close(AUDIO_FD); usleep(100000); } /* let the audio thread leave before the sender goes */
#endif
  send_destroy(sender);
  if (ndi_destroy) ndi_destroy();
  free(buf);
  return 0;
}

static double now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000.0 + t.tv_nsec / 1e6; }

static int receive_main(char** a) {
  const char* part = a[3];
  double until = now_ms() + atof(a[4]);
  if (load(a[2], true)) return 1;
  find_create_t fc = { true, NULL, NULL };
  void* finder = find_create(&fc);
  if (!finder) return fail("NDI discovery could not start");
  source_t found; bool have = false;
  while (!have && now_ms() < until) {
    find_wait(finder, 500);
    uint32_t n = 0;
    const source_t* list = find_sources(finder, &n);
    for (uint32_t i = 0; i < n && !have; i++) if (strstr(list[i].p_ndi_name, part)) { found = list[i]; have = true; }
  }
  if (!have) { find_destroy(finder); return fail("no such NDI source found"); }
  recv_create_t rc;
  memset(&rc, 0, sizeof rc);
  rc.source_to_connect_to = found; rc.color_format = 0 /* BGRX or BGRA */; rc.bandwidth = 100 /* highest */; rc.p_ndi_recv_name = "ndisend test";
  void* receiver = recv_create(&rc);
  if (!receiver) return fail("NDI receiver could not be created");
  int frames = 0, w = 0, h = 0; uint8_t px[4] = {0, 0, 0, 0};
  long samples = 0, crossings = 0; float peak = 0, prev = 0; int rate = 0, channels = 0, longest_gap = 0; double last_audio = 0;
  while (now_ms() < until) {
    video_frame_t f;
    audio_frame_t au;
    memset(&f, 0, sizeof f);
    memset(&au, 0, sizeof au);
    int got = recv_capture(receiver, &f, &au, NULL, 200);
    if (got == 2) { /* 2 = audio; channel 0 is read for its level and pitch */
      double t = now_ms();
      if (last_audio && t - last_audio > longest_gap) longest_gap = (int)(t - last_audio);
      last_audio = t;
      rate = au.sample_rate; channels = au.no_channels;
      for (int i = 0; i < au.no_samples; i++) {
        float v = au.p_data[i];
        if (v > peak) peak = v; else if (-v > peak) peak = -v;
        if ((prev < 0) != (v < 0)) crossings++;
        prev = v;
      }
      samples += au.no_samples;
      recv_free_audio(receiver, &au);
    }
    if (got == 1) { /* 1 = video */
      frames++; w = f.xres; h = f.yres;
      const uint8_t* p = f.p_data + (size_t)(f.yres / 2) * f.line_stride_in_bytes + (size_t)(f.xres / 2) * 4;
      memcpy(px, p, 4);
      recv_free_video(receiver, &f);
    }
  }
  /* frames, size, B G R A of the centre; then audio: samples, channels, rate, peak in thousandths, frequency in Hz (from zero crossings), longest wait between audio blocks in ms */
  printf("%d %d %d %u %u %u %u %ld %d %d %d %ld %d\n", frames, w, h, px[0], px[1], px[2], px[3], samples, channels, rate, (int)(peak * 1000), rate && samples ? (long)(crossings / 2.0 / ((double)samples / rate)) : 0, longest_gap);
  recv_destroy(receiver);
  find_destroy(finder);
  return frames > 0 ? 0 : fail("no video frame arrived");
}

int main(int argc, char** argv) {
  if ((argc == 7 || (argc == 8 && !strcmp(argv[7], "audio"))) && !strcmp(argv[1], "send")) return send_main(argv, argc == 8);
  if (argc == 5 && !strcmp(argv[1], "receive")) return receive_main(argv);
  return fail("usage: ndisend send <library> <name> <width> <height> <fps> [audio] | ndisend receive <library> <name part> <ms>");
}
