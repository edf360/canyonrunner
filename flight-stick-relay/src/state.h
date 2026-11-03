/*
 * state.h - thread-safe shared state between input thread and consumers.
 *
 * Writer:  exactly one input thread (input.c) samples the joystick and calls
 *          state_set_input(). Raw values are calibrated/mapped into processed.
 * Readers: ws poll loop (ws_server.c) and UI (ui.c) call state_snapshot().
 *
 * The shared block is protected by a single Windows SRWLOCK. The input thread
 * may run at poll_hz without holding the lock while sampling.
 */
#ifndef FSR_STATE_H
#define FSR_STATE_H

#include <windows.h>
#include <stdint.h>

#include "config.h"

/* Raw device sample (pre-mapping). Units are joyGetPosEx raw ranges. */
typedef struct {
  long     axes[FSR_MAX_AXES];
  unsigned long buttons;   /* 32-bit button bitmask */
  long     hat;            /* POV value (0..35999) or -1 = centered */
} JoyRaw;

/* Post-mapping sample handed to the game. axes are -1..1. */
typedef struct {
  float    axes[FSR_MAX_AXES];
  unsigned long buttons;
  float    hatx, haty;     /* hat decomposed to -1..1 axes */
  uint64_t seq;
  uint64_t t_ms;
} JoyState;

/* Detected device capabilities. */
typedef struct {
  int  present;
  int  axes;               /* count of usable axes from caps */
  int  buttons;
  int  has_hat;
  int  has_ffb;
  char name[64];
} JoyCaps;

typedef struct {
  SRWLOCK        lock;
  JoyState       joy;      /* latest processed sample */
  JoyRaw         raw;      /* latest raw sample (for calib UI) */
  int            connected;/* joyGetPosEx OK */
  uint64_t       seq;
  uint64_t       cfg_epoch;/* bumped on every config change */
  JoyCaps        caps;
  AppConfig      cfg;      /* live config, edited by UI */
} SharedState;

/* Initialise the singleton (seeds cfg defaults, clears state). */
void  state_init(void);

/* Access the singleton (do not hold the lock outside the helpers below). */
SharedState *state_get(void);

/* Writer helpers (input thread).
 * joy_processed carries mapped axes/hat (from mapping_apply). buttons/seq/t_ms
 * are stamped by state_set_input from raw + caps + clock. */
void  state_set_input(const JoyRaw *raw, const JoyState *joy_processed,
                      int connected);
/* Publish detected capabilities (called at startup / on reconnect). */
void  state_set_caps(const JoyCaps *caps);

/* Reader helpers. Copy under shared read lock. */
void  state_snapshot(JoyState *out);
void  state_raw_snapshot(JoyRaw *out, int *connected);
void  state_caps_snapshot(JoyCaps *out);
void  state_config_snapshot(AppConfig *out);

/* Config mutation (UI thread). Copies in + notifies ws to push cfg. */
void  state_config_set(const AppConfig *cfg);
/* Returns a monotonically increasing config epoch to detect changes. */
uint64_t state_config_epoch(void);

#endif /* FSR_STATE_H */
