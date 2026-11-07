/*
 * Windows: lists capture devices and reads every channel of one through WASAPI (shared mode), writing interleaved f32le frames to
 * stdout (see main/native-audio.ts). Chromium opens a USB interface with two channels at most, however many it has.
 *
 *   wasapicapture list                           one line per active capture device: "name<TAB>channels"
 *   wasapicapture capture <name> <max channels>  reads that device (its friendly name) at the format Windows has for it
 *
 * Shared mode gives the channels and rate the device is set to in Windows' sound settings (Recording → device → Properties →
 * Advanced); it must be 48000 Hz. A multichannel interface that only offers its channels through its own ASIO driver shows up
 * here with two channels, and then there is nothing more to read this way. stderr gets one line in the style of ffmpeg's
 * ("Stream #0:0: Audio: pcm_f32le, 48000 Hz, N channels") once reading has started, or a reason the device could not be read.
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <initguid.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <ksmedia.h>
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fail(const char* what) { fprintf(stderr, "%s\n", what); fflush(stderr); return 1; }

/* The friendly name of an endpoint as UTF-8 (caller frees), or NULL. */
static char* device_name(IMMDevice* dev) {
  IPropertyStore* props = NULL;
  PROPVARIANT v;
  char* out = NULL;
  PropVariantInit(&v);
  if (SUCCEEDED(IMMDevice_OpenPropertyStore(dev, STGM_READ, &props)) && SUCCEEDED(IPropertyStore_GetValue(props, &PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) {
    int n = WideCharToMultiByte(CP_UTF8, 0, v.pwszVal, -1, NULL, 0, NULL, NULL);
    out = malloc((size_t)n);
    if (out) WideCharToMultiByte(CP_UTF8, 0, v.pwszVal, -1, out, n, NULL, NULL);
  }
  PropVariantClear(&v);
  if (props) IPropertyStore_Release(props);
  return out;
}

/* The format Windows mixes this device at, to be freed with CoTaskMemFree. */
static WAVEFORMATEX* mix_format(IMMDevice* dev, IAudioClient** client) {
  WAVEFORMATEX* fmt = NULL;
  if (FAILED(IMMDevice_Activate(dev, &IID_IAudioClient, CLSCTX_ALL, NULL, (void**)client))) return NULL;
  if (FAILED(IAudioClient_GetMixFormat(*client, &fmt))) { IAudioClient_Release(*client); *client = NULL; return NULL; }
  return fmt;
}

static int is_float(const WAVEFORMATEX* f) {
  if (f->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) return 1;
  if (f->wFormatTag == WAVE_FORMAT_EXTENSIBLE) return IsEqualGUID(&((const WAVEFORMATEXTENSIBLE*)f)->SubFormat, &KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
  return 0;
}

static float sample_at(const BYTE* p, const WAVEFORMATEX* f, int isfloat) {
  if (isfloat) return *(const float*)p;
  switch (f->wBitsPerSample) {
    case 16: return (float)(*(const int16_t*)p) / 32768.0f;
    case 24: { int32_t v = (int32_t)((p[0] << 8) | (p[1] << 16) | ((uint32_t)p[2] << 24)); return (float)(v >> 8) / 8388608.0f; }
    case 32: return (float)(*(const int32_t*)p) / 2147483648.0f;
    default: return 0.0f;
  }
}

static int list_main(IMMDeviceEnumerator* en) {
  IMMDeviceCollection* coll = NULL;
  UINT count = 0;
  if (FAILED(IMMDeviceEnumerator_EnumAudioEndpoints(en, eCapture, DEVICE_STATE_ACTIVE, &coll))) return fail("The capture devices could not be listed");
  IMMDeviceCollection_GetCount(coll, &count);
  for (UINT i = 0; i < count; i++) {
    IMMDevice* dev = NULL;
    if (FAILED(IMMDeviceCollection_Item(coll, i, &dev))) continue;
    char* name = device_name(dev);
    IAudioClient* client = NULL;
    WAVEFORMATEX* fmt = mix_format(dev, &client);
    if (name && fmt) printf("%s\t%u\n", name, (unsigned)fmt->nChannels);
    if (fmt) CoTaskMemFree(fmt);
    if (client) IAudioClient_Release(client);
    free(name);
    IMMDevice_Release(dev);
  }
  IMMDeviceCollection_Release(coll);
  return 0;
}

static int capture_main(IMMDeviceEnumerator* en, const char* wanted, int maxOut) {
  IMMDeviceCollection* coll = NULL;
  UINT count = 0;
  IMMDevice* dev = NULL;
  if (FAILED(IMMDeviceEnumerator_EnumAudioEndpoints(en, eCapture, DEVICE_STATE_ACTIVE, &coll))) return fail("The capture devices could not be listed");
  IMMDeviceCollection_GetCount(coll, &count);
  for (UINT i = 0; i < count && !dev; i++) {
    IMMDevice* d = NULL;
    if (FAILED(IMMDeviceCollection_Item(coll, i, &d))) continue;
    char* name = device_name(d);
    if (name && !strcmp(name, wanted)) dev = d; else IMMDevice_Release(d);
    free(name);
  }
  IMMDeviceCollection_Release(coll);
  if (!dev) return fail("No capture device has that name");

  IAudioClient* client = NULL;
  WAVEFORMATEX* fmt = mix_format(dev, &client);
  if (!fmt) return fail("The device's format could not be read");
  if (fmt->nSamplesPerSec != 48000) { char m[160]; snprintf(m, sizeof m, "%s runs at %u Hz; set it to 48000 Hz in Windows' sound settings", wanted, (unsigned)fmt->nSamplesPerSec); return fail(m); }
  int isfloat = is_float(fmt);
  int channels = fmt->nChannels, out = channels < maxOut ? channels : maxOut, bytes = fmt->wBitsPerSample / 8;
  if (fmt->nBlockAlign != channels * bytes) return fail("The device uses a sample layout that cannot be read");

  HRESULT hr = IAudioClient_Initialize(client, AUDCLNT_SHAREMODE_SHARED, 0, 2000000 /* 200 ms */, 0, fmt, NULL);
  if (hr == E_ACCESSDENIED) return fail("Microphone access is off for desktop apps (Windows Settings → Privacy → Microphone)");
  if (FAILED(hr)) return fail("The device could not be opened (is another program using it exclusively?)");
  IAudioCaptureClient* cap = NULL;
  if (FAILED(IAudioClient_GetService(client, &IID_IAudioCaptureClient, (void**)&cap))) return fail("The capture service is not available");
  if (FAILED(IAudioClient_Start(client))) return fail("The device could not be started");

  _setmode(_fileno(stdout), _O_BINARY);
  fprintf(stderr, "Stream #0:0: Audio: pcm_f32le, 48000 Hz, %d channels\n", out); fflush(stderr);

  float* buf = NULL;
  size_t cap_frames = 0;
  for (;;) {
    Sleep(5);
    UINT32 packet = 0;
    while (SUCCEEDED(IAudioCaptureClient_GetNextPacketSize(cap, &packet)) && packet > 0) {
      BYTE* data = NULL;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(IAudioCaptureClient_GetBuffer(cap, &data, &frames, &flags, NULL, NULL))) return fail("The device stopped delivering audio");
      if (frames > cap_frames) { free(buf); cap_frames = frames; buf = malloc(cap_frames * (size_t)out * sizeof(float)); if (!buf) return fail("out of memory"); }
      for (UINT32 i = 0; i < frames; i++)
        for (int c = 0; c < out; c++)
          buf[(size_t)i * out + c] = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.0f : sample_at(data + ((size_t)i * channels + c) * bytes, fmt, isfloat);
      IAudioCaptureClient_ReleaseBuffer(cap, frames);
      size_t total = (size_t)frames * out * sizeof(float), done = 0;
      while (done < total) { size_t w = fwrite((char*)buf + done, 1, total - done, stdout); if (w == 0) return 0; done += w; } /* the app closed the pipe */
      fflush(stdout);
    }
  }
}

int main(int argc, char** argv) {
  if (argc < 2) return fail("usage: wasapicapture list | capture <name> <max channels>");
  if (FAILED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) return fail("COM could not start");
  IMMDeviceEnumerator* en = NULL;
  if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator, (void**)&en))) return fail("The audio system is not available");
  if (!strcmp(argv[1], "list")) return list_main(en);
  if (!strcmp(argv[1], "capture") && argc == 4 && atoi(argv[3]) > 0) return capture_main(en, argv[2], atoi(argv[3]));
  return fail("usage: wasapicapture list | capture <name> <max channels>");
}
