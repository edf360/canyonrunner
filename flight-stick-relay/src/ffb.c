/*
 * ffb.c - force-feedback backend management.
 *
 * This file holds the backend selection + a small active-effect table that
 * decays duration-limited effects each ffb_update(). The actual device output
 * is provided by one of the backends:
 *   - backend_noop       : always available (no sound/vibration)
 *   - backend_xinput     : rumble for XInput-capable pads (loaded at runtime)
 *   - backend_directinput: real FFB via DirectInput8 (loaded at runtime)
 *
 * The DirectInput8 backend is intentionally isolated: it is COM and is created
 * only when probing succeeds, so unsupported devices degrade to noop.
 */
#include "ffb.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "state.h"

/* --- noop backend --------------------------------------------------------- */
static int  noop_init(const FfcCfg *cfg) { (void) cfg; return 1; }
static void noop_set_config(const FfcCfg *cfg) { (void) cfg; }
static int  noop_play(const char *e, float m, uint32_t d, int a) {
  (void) e; (void) m; (void) d; (void) a; return 0;
}
static void noop_stop(void) {}
static void noop_shutdown(void) {}

static FfbBackend g_noop = {
  "noop", FFB_BACKEND_NOOP,
  noop_init, noop_set_config, noop_play, noop_stop, noop_shutdown
};

/* DirectInput8 + XInput backends are provided in ffb_backend_dinput.c and
   ffb_backend_xinput.c and exposed via these constructors. */
FfbBackend *ffb_backend_directinput_create(void);
FfbBackend *ffb_backend_xinput_create(void);
/* Stubs are compiled in if the real backend is unavailable; the build links
   whichever translation units exist. */

/* --- active effect table -------------------------------------------------- */
typedef struct {
  int      used;
  float    mag;
  uint64_t until;     /* GetTickCount64 ms */
  int      axis;
} Active;

#define MAX_ACTIVE 8
static Active g_active[MAX_ACTIVE];

static FfbBackend *g_be = &g_noop;
static FfcCfg      g_cfg;
static FfbBackendKind g_kind = FFB_BACKEND_NOOP;

static int g_be_di_owned = 0;   /* did we allocate the DI backend? */
static int g_be_xi_owned = 0;

static void pick(const char *want) {
  FfbBackend *di = ffb_backend_directinput_create();
  FfbBackend *xi = ffb_backend_xinput_create();
  int try_di = (!strcmp(want, "auto") || !strcmp(want, "directinput"));
  int try_xi = (!strcmp(want, "auto") || !strcmp(want, "xinput"));

  if (try_di && di && di->init(&g_cfg)) {
    g_be = di; g_kind = FFB_BACKEND_DIRECTINPUT; g_be_di_owned = 1;
    if (xi && xi->shutdown) xi->shutdown();
    else if (xi) free(xi);
    return;
  }
  if (try_xi && xi && xi->init(&g_cfg)) {
    g_be = xi; g_kind = FFB_BACKEND_XINPUT; g_be_xi_owned = 1;
    if (di && di->shutdown) di->shutdown();
    else if (di) free(di);
    return;
  }
  /* fallback noop */
  if (di && di->shutdown) di->shutdown(); else if (di) free(di);
  if (xi && xi->shutdown) xi->shutdown(); else if (xi) free(xi);
  g_be = &g_noop; g_kind = FFB_BACKEND_NOOP;
}

FfbBackendKind ffb_startup(const AppConfig *cfg) {
  memset(g_active, 0, sizeof(g_active));
  g_cfg = cfg->ffb;
  pick(g_cfg.backend);
  printf("[ffb] backend = %s (want '%s')\n", g_be->name, g_cfg.backend);
  /* patch has_ffb into caps so clients learn the truth */
  SharedState *s = state_get();
  AcquireSRWLockExclusive(&s->lock);
  s->caps.has_ffb = (g_kind == FFB_BACKEND_DIRECTINPUT ||
                     g_kind == FFB_BACKEND_XINPUT) ? 1 : 0;
  s->cfg_epoch++;
  ReleaseSRWLockExclusive(&s->lock);
  return g_kind;
}

void ffb_set_config(const FfcCfg *cfg) {
  g_cfg = *cfg;
  if (g_be->set_config) g_be->set_config(&g_cfg);
  /* backend switch requested? */
  if (g_be->kind && strcmp(g_be->name, cfg->backend) != 0) {
    char want[16]; strncpy(want, cfg->backend, sizeof(want) - 1);
    /* tear current, re-pick */
    if (g_be == &g_noop) {
      /* noop: pick() reassigns; ensure noop not freed */
      FfbBackend keep = g_noop; (void) keep;
    } else {
      if (g_be->shutdown) g_be->shutdown();
      if (g_be_di_owned) free(g_be);
      else if (g_be_xi_owned) free(g_be);
      g_be = &g_noop; g_kind = FFB_BACKEND_NOOP;
      g_be_di_owned = g_be_xi_owned = 0;
    }
    if (strcmp(want, "noop") == 0) {
      g_be = &g_noop; g_kind = FFB_BACKEND_NOOP;
    } else {
      pick(want);
    }
  }
}

int ffb_play(const char *effect, float intensity, uint32_t duration_ms, int axis) {
  float mag = intensity;
  if (mag < 0) mag = 0;
  if (mag > 1) mag = 1;
  mag *= g_cfg.intensity;
  if (mag <= 0.0f) return 0;

  /* record in active table for decay + device output */
  for (int i = 0; i < MAX_ACTIVE; i++) {
    if (!g_active[i].used) {
      g_active[i].used = 1;
      g_active[i].mag = mag;
      g_active[i].until = GetTickCount64() + (duration_ms ? duration_ms : 200);
      g_active[i].axis = axis;
      break;
    }
  }
  int real = g_be->play(effect, mag, duration_ms, axis);
  if (g_kind == FFB_BACKEND_NOOP && mag > 0.0f) {
    /* log once-ish to confirm events reached the app */
    static uint64_t last_log = 0;
    uint64_t now = GetTickCount64();
    if (now - last_log > 500) {
      printf("[ffb] (noop) effect=%s mag=%.2f dur=%ums axis=%d\n",
             effect ? effect : "?", mag, duration_ms, axis);
      last_log = now;
    }
  }
  return real;
}

void ffb_update(void) {
  uint64_t now = GetTickCount64();
  int any = 0;
  for (int i = 0; i < MAX_ACTIVE; i++) {
    if (g_active[i].used) {
      if (now >= g_active[i].until) g_active[i].used = 0;
      else any = 1;
    }
  }
  if (!any) g_be->stop_all();
}

void ffb_stop_all(void) {
  memset(g_active, 0, sizeof(g_active));
  g_be->stop_all();
}

void ffb_shutdown(void) {
  if (g_be == &g_noop) return;
  if (g_be->shutdown) g_be->shutdown();
  if (g_be_di_owned || g_be_xi_owned) free(g_be);
  g_be = &g_noop; g_kind = FFB_BACKEND_NOOP;
  g_be_di_owned = g_be_xi_owned = 0;
}

const char *ffb_backend_name(void) { return g_be ? g_be->name : "noop"; }
