#include "input.h"

#include <windows.h>
#include <mmsystem.h>
#include <stdio.h>
#include <string.h>

#include "mapping.h"

/* Map joyGetPosEx fields into our axes[] order:
 * 0=X 1=Y 2=Z 3=R(rx) 4=U(ry) 5=V(rz) */
static void read_sample(JOYINFOEX *ji, JoyRaw *raw) {
  raw->axes[0] = (long) ji->dwXpos;
  raw->axes[1] = (long) ji->dwYpos;
  raw->axes[2] = (long) ji->dwZpos;
  raw->axes[3] = (long) ji->dwRpos;
  raw->axes[4] = (long) ji->dwUpos;
  raw->axes[5] = (long) ji->dwVpos;
  raw->buttons = (unsigned long) ji->dwButtons;
  raw->hat = (long) ji->dwPOV;   /* 0xFFFF == centered */
}

static UINT g_joyid = 0;
static HANDLE g_thread = NULL;
static volatile LONG g_stop = 0;

int input_probe(JoyCaps *caps_out) {
  JoyCaps caps;
  memset(&caps, 0, sizeof(caps));
  UINT ndev = joyGetNumDevs();

  for (UINT id = 0; id < ndev; id++) {
    JOYINFOEX ji;
    memset(&ji, 0, sizeof(ji));
    ji.dwSize = sizeof(ji);
    ji.dwFlags = JOY_RETURNALL;
    MMRESULT mr = joyGetPosEx(id, &ji);
    if (mr != JOYERR_NOERROR) continue;

    JOYCAPSW jc;
    if (joyGetDevCapsW(id, &jc, sizeof(jc)) != JOYERR_NOERROR) continue;

    g_joyid = id;
    caps.present = 1;
    caps.buttons = (int) jc.wNumButtons;
    /* Count every axis MMJOY reports as present. This FlightStick exposes
       six axes: X/Y (the cross) plus Z / R(X-twist) / U(Y-twist) / V(Z-twist).
       JOYCAPS_HASU and JOYCAPS_HASV MUST be counted here -- when they were
       missed, caps.axes came out as 4, and the input thread's "zero-fill the
       absent axes" pass (for i=caps.axes..FSR_MAX_AXES) then forced the U and
       V axes to 0, so the Y-twist / Z-twist controls never reached the game. */
    caps.axes = 2; /* X,Y */
    if (jc.wCaps & JOYCAPS_HASZ) caps.axes++;   /* Z  */
    if (jc.wCaps & JOYCAPS_HASR) caps.axes++;   /* R = X-twist */
    if (jc.wCaps & JOYCAPS_HASU) caps.axes++;   /* U = Y-twist */
    if (jc.wCaps & JOYCAPS_HASV) caps.axes++;   /* V = Z-twist */
    if (caps.axes > FSR_MAX_AXES) caps.axes = FSR_MAX_AXES;
    caps.has_hat = (jc.wCaps & JOYCAPS_HASPOV) ? 1 : 0;
    /* FFB capability is decided by the DirectInput probe in ffb.c and
       patched into caps via state_set_caps(); MMJOY has no FFB flag. */
    caps.has_ffb = 0;
#ifdef UNICODE
    WideCharToMultiByte(CP_UTF8, 0, jc.szPname, -1, caps.name,
                        sizeof(caps.name), NULL, NULL);
#else
    strncpy(caps.name, jc.szPname, sizeof(caps.name) - 1);
#endif
    if (caps_out) *caps_out = caps;
    state_set_caps(&caps);
    printf("[input] device %u: '%s' axes=%d buttons=%d hat=%d ffb=%d\n",
           id, caps.name, caps.axes, caps.buttons, caps.has_hat, caps.has_ffb);
    return 1;
  }

  caps.present = 0;
  if (caps_out) *caps_out = caps;
  state_set_caps(&caps);
  printf("[input] no joystick device found\n");
  return 0;
}

static DWORD WINAPI input_thread(LPVOID param) {
  (void) param;
  MapSmooth smooth;
  mapping_smooth_reset(&smooth);

  DWORD period = 1000 / 120;
  while (!g_stop) {
    AppConfig cfg;
    state_config_snapshot(&cfg);
    if (cfg.poll_hz < 10) cfg.poll_hz = 10;
    if (cfg.poll_hz > 1000) cfg.poll_hz = 1000;
    period = 1000 / (DWORD) cfg.poll_hz;
    if (period < 1) period = 1;

    JOYINFOEX ji;
    memset(&ji, 0, sizeof(ji));
    ji.dwSize = sizeof(ji);
    ji.dwFlags = JOY_RETURNALL;

    JoyRaw raw;
    memset(&raw, 0, sizeof(raw));
    MMRESULT mr = joyGetPosEx(g_joyid, &ji);
    int connected = (mr == JOYERR_NOERROR);

    JoyState processed;
    memset(&processed, 0, sizeof(processed));
    if (connected) {
      read_sample(&ji, &raw);
      mapping_apply(&raw, &cfg, &smooth, &processed);

      /* Zero axes beyond the device's real count so the game sees 0, not the
         calibrated value of an absent axis. */
      JoyCaps caps;
      state_caps_snapshot(&caps);
      for (int i = caps.axes; i < FSR_MAX_AXES; i++) processed.axes[i] = 0.0f;
      if (!caps.has_hat) { processed.hatx = 0.0f; processed.haty = 0.0f; }
    }

    state_set_input(&raw, &processed, connected);
    Sleep(period);
  }
  return 0;
}

int input_start(void) {
  g_stop = 0;
  g_thread = CreateThread(NULL, 0, input_thread, NULL, 0, NULL);
  return g_thread ? 0 : 1;
}

void input_stop(void) {
  g_stop = 1;
  if (g_thread) {
    WaitForSingleObject(g_thread, 2000);
    CloseHandle(g_thread);
    g_thread = NULL;
  }
}
