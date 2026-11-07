/*
 * Reads every input channel of an ALSA capture device and writes interleaved f32le frames to stdout (see main/native-audio.ts).
 * Chromium opens a USB interface with two channels at most, however many it has, so a multichannel mixer (a Behringer WING)
 * is read here instead. libasound is loaded at run time, so nothing needs the ALSA development files to build.
 *
 *   alsacapture <card id | alsa device> <max channels> [channels]
 *
 * A plain card id (the name in /proc/asound/cards, e.g. WING) opens hw:CARD=<id>; a name with a colon, or "null", is taken as an
 * ALSA device as it is. The optional third argument asks for that many channels instead of everything the device offers (for tests
 * with the "null" device). stderr gets one line in the style of ffmpeg's ("Stream #0:0: Audio: pcm_f32le, 48000 Hz, N channels")
 * once reading has started, or a reason the device could not be read.
 */
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct snd_pcm snd_pcm_t;
typedef struct snd_pcm_hw_params snd_pcm_hw_params_t;
typedef unsigned long snd_pcm_uframes_t;
typedef long snd_pcm_sframes_t;
enum { PCM_CAPTURE = 1, ACCESS_RW_INTERLEAVED = 3, FORMAT_S16_LE = 2, FORMAT_S32_LE = 10, FORMAT_FLOAT_LE = 14 };

static int (*pcm_open)(snd_pcm_t**, const char*, int, int);
static int (*pcm_close)(snd_pcm_t*);
static int (*pcm_prepare)(snd_pcm_t*);
static int (*pcm_start)(snd_pcm_t*);
static int (*pcm_recover)(snd_pcm_t*, int, int);
static snd_pcm_sframes_t (*pcm_readi)(snd_pcm_t*, void*, snd_pcm_uframes_t);
static int (*hw_malloc)(snd_pcm_hw_params_t**);
static void (*hw_free)(snd_pcm_hw_params_t*);
static int (*hw_any)(snd_pcm_t*, snd_pcm_hw_params_t*);
static int (*hw_set_access)(snd_pcm_t*, snd_pcm_hw_params_t*, int);
static int (*hw_set_format)(snd_pcm_t*, snd_pcm_hw_params_t*, int);
static int (*hw_set_rate_near)(snd_pcm_t*, snd_pcm_hw_params_t*, unsigned*, int*);
static int (*hw_get_channels_max)(const snd_pcm_hw_params_t*, unsigned*);
static int (*hw_set_channels)(snd_pcm_t*, snd_pcm_hw_params_t*, unsigned);
static int (*hw_set_period_near)(snd_pcm_t*, snd_pcm_hw_params_t*, snd_pcm_uframes_t*, int*);
static int (*hw_set_buffer_near)(snd_pcm_t*, snd_pcm_hw_params_t*, snd_pcm_uframes_t*);
static int (*hw_apply)(snd_pcm_t*, snd_pcm_hw_params_t*);
static const char* (*str_error)(int);

static int fail(const char* what) { fprintf(stderr, "%s\n", what); return 1; }

static int load(void) {
  void* lib = dlopen("libasound.so.2", RTLD_NOW | RTLD_LOCAL);
  if (!lib) return fail("libasound (ALSA) is not installed");
#define L(var, name) do { *(void**)&(var) = dlsym(lib, name); if (!(var)) return fail("libasound lacks " name); } while (0)
  L(pcm_open, "snd_pcm_open"); L(pcm_close, "snd_pcm_close"); L(pcm_prepare, "snd_pcm_prepare"); L(pcm_start, "snd_pcm_start");
  L(pcm_recover, "snd_pcm_recover"); L(pcm_readi, "snd_pcm_readi"); L(hw_malloc, "snd_pcm_hw_params_malloc"); L(hw_free, "snd_pcm_hw_params_free");
  L(hw_any, "snd_pcm_hw_params_any"); L(hw_set_access, "snd_pcm_hw_params_set_access"); L(hw_set_format, "snd_pcm_hw_params_set_format");
  L(hw_set_rate_near, "snd_pcm_hw_params_set_rate_near"); L(hw_get_channels_max, "snd_pcm_hw_params_get_channels_max");
  L(hw_set_channels, "snd_pcm_hw_params_set_channels"); L(hw_set_period_near, "snd_pcm_hw_params_set_period_size_near");
  L(hw_set_buffer_near, "snd_pcm_hw_params_set_buffer_size_near"); L(hw_apply, "snd_pcm_hw_params"); L(str_error, "snd_strerror");
#undef L
  return 0;
}

static int write_all(const void* data, size_t bytes) {
  const char* p = data;
  while (bytes) {
    ssize_t w = write(1, p, bytes);
    if (w < 0) { if (errno == EINTR) continue; return -1; } /* the app closed the pipe */
    p += w; bytes -= (size_t)w;
  }
  return 0;
}

int main(int argc, char** argv) {
  if (argc < 3) return fail("usage: alsacapture <card id | alsa device> <max channels> [channels]");
  int maxOut = atoi(argv[2]);
  unsigned forced = argc > 3 ? (unsigned)atoi(argv[3]) : 0;
  if (maxOut < 1) return fail("bad channel limit");
  if (load()) return 1;
  signal(SIGPIPE, SIG_IGN);

  char device[256];
  if (strchr(argv[1], ':') || !strcmp(argv[1], "null")) snprintf(device, sizeof device, "%s", argv[1]);
  else snprintf(device, sizeof device, "hw:CARD=%s", argv[1]);

  snd_pcm_t* pcm = NULL;
  int err = pcm_open(&pcm, device, PCM_CAPTURE, 0);
  if (err < 0) return fail(err == -EBUSY ? "The sound card is in use by another program (PulseAudio or PipeWire may be holding it)" : str_error(err));

  snd_pcm_hw_params_t* hw = NULL;
  hw_malloc(&hw);
  hw_any(pcm, hw);
  if (hw_set_access(pcm, hw, ACCESS_RW_INTERLEAVED) < 0) return fail("The device cannot deliver interleaved samples");
  int format = FORMAT_FLOAT_LE;
  if (hw_set_format(pcm, hw, FORMAT_FLOAT_LE) < 0) {
    format = FORMAT_S32_LE;
    if (hw_set_format(pcm, hw, FORMAT_S32_LE) < 0) { format = FORMAT_S16_LE; if (hw_set_format(pcm, hw, FORMAT_S16_LE) < 0) return fail("The device offers no sample format that can be read"); }
  }
  unsigned rate = 48000;
  hw_set_rate_near(pcm, hw, &rate, NULL);
  if (rate != 48000) { char m[120]; snprintf(m, sizeof m, "%s runs at %u Hz; it must be 48000 Hz", argv[1], rate); return fail(m); }
  unsigned channels = forced;
  if (!channels) hw_get_channels_max(hw, &channels);
  if (channels < 1 || channels > 256) return fail("The device reports no usable channel count");
  if (hw_set_channels(pcm, hw, channels) < 0) return fail("The device would not open with all its channels");
  snd_pcm_uframes_t period = 480, buffer = 48000 / 2; /* 10 ms periods, half a second of buffer to ride out a slow reader */
  hw_set_period_near(pcm, hw, &period, NULL);
  hw_set_buffer_near(pcm, hw, &buffer);
  err = hw_apply(pcm, hw);
  if (err < 0) return fail(str_error(err));
  hw_free(hw);
  if ((err = pcm_prepare(pcm)) < 0 || (err = pcm_start(pcm)) < 0) return fail(str_error(err));

  unsigned out = channels < (unsigned)maxOut ? channels : (unsigned)maxOut;
  size_t sample = format == FORMAT_S16_LE ? 2 : 4;
  size_t frames = period > 0 ? period : 480;
  void* in = malloc(frames * channels * sample);
  float* res = malloc(frames * out * sizeof(float));
  if (!in || !res) return fail("out of memory");
  fprintf(stderr, "Stream #0:0: Audio: pcm_f32le, 48000 Hz, %u channels\n", out); fflush(stderr);

  for (;;) {
    snd_pcm_sframes_t n = pcm_readi(pcm, in, frames);
    if (n < 0) { if (pcm_recover(pcm, (int)n, 1) < 0) return fail("The device stopped delivering audio"); continue; } /* an overrun is dropped samples, then reading goes on */
    if (n == 0) continue;
    for (snd_pcm_sframes_t i = 0; i < n; i++) {
      for (unsigned c = 0; c < out; c++) {
        size_t k = (size_t)i * channels + c;
        float v;
        if (format == FORMAT_FLOAT_LE) v = ((const float*)in)[k];
        else if (format == FORMAT_S32_LE) v = (float)((const int32_t*)in)[k] / 2147483648.0f;
        else v = (float)((const int16_t*)in)[k] / 32768.0f;
        res[(size_t)i * out + c] = v;
      }
    }
    if (write_all(res, (size_t)n * out * sizeof(float)) < 0) break;
  }
  pcm_close(pcm);
  return 0;
}
