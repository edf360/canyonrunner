#include "state.h"

#include <string.h>

#include "mapping.h"

static SharedState g_state;

void state_init(void) {
  memset(&g_state, 0, sizeof(g_state));
  InitializeSRWLock(&g_state.lock);
  config_defaults(&g_state.cfg);
  g_state.seq = 0;
  g_state.cfg_epoch = 0;
}

SharedState *state_get(void) {
  return &g_state;
}

void state_set_input(const JoyRaw *raw, const JoyState *joy_processed,
                     int connected) {
  SharedState *s = state_get();
  AcquireSRWLockExclusive(&s->lock);
  s->raw = *raw;
  s->connected = connected;
  if (connected) {
    s->seq++;
    s->joy = *joy_processed;
    s->joy.seq = s->seq;
    s->joy.t_ms = GetTickCount64();
    s->joy.buttons = mapping_remap_buttons(raw->buttons, &s->cfg);
  }
  ReleaseSRWLockExclusive(&s->lock);
}

void state_set_caps(const JoyCaps *caps) {
  SharedState *s = state_get();
  AcquireSRWLockExclusive(&s->lock);
  s->caps = *caps;
  s->cfg_epoch++;  /* force info push to clients */
  ReleaseSRWLockExclusive(&s->lock);
}

void state_snapshot(JoyState *out) {
  SharedState *s = state_get();
  AcquireSRWLockShared(&s->lock);
  *out = s->joy;
  ReleaseSRWLockShared(&s->lock);
}

void state_raw_snapshot(JoyRaw *out, int *connected) {
  SharedState *s = state_get();
  AcquireSRWLockShared(&s->lock);
  *out = s->raw;
  if (connected) *connected = s->connected;
  ReleaseSRWLockShared(&s->lock);
}

void state_caps_snapshot(JoyCaps *out) {
  SharedState *s = state_get();
  AcquireSRWLockShared(&s->lock);
  *out = s->caps;
  ReleaseSRWLockShared(&s->lock);
}

void state_config_snapshot(AppConfig *out) {
  SharedState *s = state_get();
  AcquireSRWLockShared(&s->lock);
  *out = s->cfg;
  ReleaseSRWLockShared(&s->lock);
}

void state_config_set(const AppConfig *cfg) {
  SharedState *s = state_get();
  AcquireSRWLockExclusive(&s->lock);
  s->cfg = *cfg;
  s->cfg_epoch++;
  ReleaseSRWLockExclusive(&s->lock);
}

uint64_t state_config_epoch(void) {
  SharedState *s = state_get();
  AcquireSRWLockShared(&s->lock);
  uint64_t e = s->cfg_epoch;
  ReleaseSRWLockShared(&s->lock);
  return e;
}
