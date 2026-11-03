/*
 * ffb.h - force-feedback / rumble backend abstraction.
 *
 * The backend is owned by the main thread (DirectInput8 is apartment-threaded
 * COM; we CoInitialize with APARTMENTTHREADED on main). ws handlers run on the
 * same thread, so an "ff" message can call ffb_play() directly.
 *
 * Duration-limited effects are decayed by the main loop calling ffb_update()
 * each poll; the active set is small (one slot per axis is enough for a stick).
 */
#ifndef FSR_FFB_H
#define FSR_FFB_H

#include <stdint.h>

#include "config.h"

typedef enum {
  FFB_BACKEND_NONE = 0,
  FFB_BACKEND_DIRECTINPUT,
  FFB_BACKEND_XINPUT,
  FFB_BACKEND_NOOP
} FfbBackendKind;

/* Backend vtable. All optional except play/stop. */
typedef struct FfbBackend {
  const char *name;
  FfbBackendKind kind;
  int   (*init)(const FfcCfg *cfg);
  void  (*set_config)(const FfcCfg *cfg);
  /* magnitude: 0..1 after master intensity applied by caller.
     axis: which axis to push along, or -1 for global rumble. */
  int   (*play)(const char *effect, float magnitude,
                uint32_t duration_ms, int axis);
  void  (*stop_all)(void);
  void  (*shutdown)(void);
} FfbBackend;

/* Lifecycle. Probe + create a backend given the desired cfg.
 * Returns the chosen backend kind. Safe to call once at startup.
 * cfg->ffb.backend: "auto" tries directinput then xinput then noop. */
FfbBackendKind ffb_startup(const AppConfig *cfg);

/* Update the active effect set (decay durations) and refresh the device.
 * Call from the main loop each poll. */
void ffb_update(void);

/* Request an effect. Returns true if it reached a real device (not noop). */
int ffb_play(const char *effect, float intensity,
             uint32_t duration_ms, int axis);

/* Stop all output immediately. */
void ffb_stop_all(void);

/* Tear down the active backend. */
void ffb_shutdown(void);

/* Apply a new master config (intensity/curve). */
void ffb_set_config(const FfcCfg *cfg);

const char *ffb_backend_name(void);

#endif /* FSR_FFB_H */
