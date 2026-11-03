/*
 * ffb_backends.c - backend constructors.
 *
 * XInput backend (real, rumble-only):
 *   Target device: HORI Flight Stick EX for Xbox 360
 *   ("Xbox 360用 ホリ フライトスティック EX"). It exposes its vibration
 *   motor through the XInput bus, not DirectInput FF (vib/README.md diagnosis:
 *   DirectInput
 *   GetEffects() reports 0 effects on this stick; XInputSetState succeeds).
 *   Only the RIGHT motor is wired, so output is a single channel: the left
 *   motor value is always 0 (plans section 12.6).
 *
 *   xinput1_4.dll is loaded at runtime (LoadLibrary/GetProcAddress) so the
 *   relay still builds and runs on systems without the XInput runtime; if the
 *   dll or a connected controller is missing we return NULL and ffb.c falls
 *   back to noop.
 *
 * DirectInput8 FF backend: intentionally not implemented (returns NULL);
 * "auto" therefore resolves to xinput -> noop.
 */
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <windows.h>

#include "ffb.h"

/* FfbBackend *ffb_backend_directinput_create(void) declared in ffb.c - keep
   the DI backend as a stub: no device is probed, NULL forces fallthrough. */
FfbBackend *ffb_backend_directinput_create(void) {
  return NULL;
}

/* --- XInput (xinput1_4.dll) -------------------------------------------------
 * Layouts mirror the documented XINPUT_* structs so we do not depend on
 * <xinput.h> being present or correct in the toolchain. */
#define XI_MAX_USERS 4
#define XI_ERROR_SUCCESS 0

typedef struct {
  WORD  wButtons;
  BYTE  bLeftTrigger;
  BYTE  bRightTrigger;
  SHORT sThumbLX;
  SHORT sThumbLY;
  SHORT sThumbRX;
  SHORT sThumbRY;
} XiGamepad;

typedef struct {
  DWORD     dwPacketNumber;
  XiGamepad Gamepad;
} XiState;

typedef struct {
  WORD wLeftMotorSpeed;
  WORD wRightMotorSpeed;
} XiVibration;

typedef DWORD(WINAPI *XiGetStateFn)(DWORD, XiState *);
typedef DWORD(WINAPI *XiSetStateFn)(DWORD, const XiVibration *);

static HMODULE      xi_lib      = NULL;
static XiGetStateFn xi_get_state = NULL;
static XiSetStateFn xi_set_state = NULL;
static int          xi_user      = -1; /* bound controller index, -1 = none */

static int xi_init(const FfcCfg *cfg) {
  (void) cfg;
  if (xi_lib) return xi_user >= 0; /* re-init after a backend switch */

  xi_lib = LoadLibraryA("xinput1_4.dll");
  if (!xi_lib) return 0;
  xi_get_state =
      (XiGetStateFn) (void *) GetProcAddress(xi_lib, "XInputGetState");
  xi_set_state =
      (XiSetStateFn) (void *) GetProcAddress(xi_lib, "XInputSetState");
  if (!xi_get_state || !xi_set_state) goto fail;

  /* Probe 0..3 for a connected device (same strategy as the vib/ test app:
     XInputGetState returning ERROR_SUCCESS means "connected"). */
  for (DWORD i = 0; i < XI_MAX_USERS; i++) {
    XiState st;
    if (xi_get_state(i, &st) == XI_ERROR_SUCCESS) {
      xi_user = (int) i;
      printf("[ffb/xinput] controller on index %u\n", (unsigned) i);
      return 1;
    }
  }

fail:
  FreeLibrary(xi_lib);
  xi_lib = NULL;
  xi_get_state = NULL;
  xi_set_state = NULL;
  xi_user = -1;
  return 0;
}

static void xi_set_motors(WORD left, WORD right) {
  if (!xi_set_state || xi_user < 0) return;
  XiVibration v;
  v.wLeftMotorSpeed = left;
  v.wRightMotorSpeed = right;
  DWORD rc = xi_set_state((DWORD) xi_user, &v);
  /* Log at each on/off edge (ffb_update() calls stop_all every idle frame,
     so logging every call would spam). Confirms commands reach the device. */
  static DWORD last_logged = 0xFFFFFFFFu;
  static int   was_on      = 0;
  int on = (left || right);
  if (on != was_on || rc != last_logged) {
    printf("[ffb/xinput] XInputSetState rc=0x%08lx (left=%u right=%u)\n",
           (unsigned long) rc, (unsigned) left, (unsigned) right);
    was_on = on;
  }
  last_logged = rc;
}

/* magnitude arrives 0..1 with master intensity already applied (ffb.c).
   The stick has a single (right) motor, so all energy goes there. */
static int xi_play(const char *effect, float magnitude,
                   uint32_t duration_ms, int axis) {
  (void) effect; (void) duration_ms; (void) axis;
  if (xi_user < 0) return 0;
  if (magnitude < 0.f) magnitude = 0.f;
  if (magnitude > 1.f) magnitude = 1.f;
  WORD mag = (WORD) (magnitude * 65535.0f + 0.5f);
  xi_set_motors(0, mag);
  return 1;
}

static void xi_stop_all(void) { xi_set_motors(0, 0); }

static void xi_set_config(const FfcCfg *cfg) { (void) cfg; }

static void xi_shutdown(void) {
  xi_stop_all();
  if (xi_lib) {
    FreeLibrary(xi_lib);
    xi_lib = NULL;
  }
  xi_get_state = NULL;
  xi_set_state = NULL;
  xi_user = -1;
}

static FfbBackend g_xinput = {
  "xinput", FFB_BACKEND_XINPUT,
  xi_init, xi_set_config, xi_play, xi_stop_all, xi_shutdown
};

FfbBackend *ffb_backend_xinput_create(void) {
  FfbBackend *be = calloc(1, sizeof *be);
  if (be) *be = g_xinput;
  return be;
}
