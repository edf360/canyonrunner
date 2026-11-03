/*
 * config.h - tunable model persisted to config.json.
 *
 * This is the data the native UI (microui) edits live. A single global
 * AppConfig is protected by the state rwlock and pushed to connected
 * browsers on change (plans section 5 / 7).
 */
#ifndef FSR_CONFIG_H
#define FSR_CONFIG_H

#define FSR_MAX_AXES     6    /* x, y, z, rx, ry, rz (joy axes 0..5)  */
#define FSR_MAX_BUTTONS  32   /* joy button bitmask width             */

/* Path of the persisted settings file (relative to the working directory so
 * the tray app can be launched from anywhere). */
#define CONFIG_PATH      "config.json"

typedef struct {
  float cmin;        /* calibration raw low  (mapped to -1) */
  float cmax;        /* calibration raw high (mapped to +1) */
  float deadzone;    /* 0..1, inner zone -> 0               */
  float gamma;       /* sensitivity curve exponent          */
  int   invert;      /* 1 -> flip sign                       */
  float smooth;      /* 0..1 low-pass alpha (0 = off)        */
} AxisCfg;

typedef struct {
  char   backend[16];   /* "auto"|"directinput"|"xinput"|"noop" */
  float  intensity;     /* 0..1 master strength                 */
  float  curve;         /* effect->magnitude curve (0..2)       */
} FfcCfg;

typedef struct {
  int     ws_port;      /* default 8765                         */
  int     poll_hz;      /* input sampling Hz, default 120       */
  float   hat_deadzone; /* 0..1 (for analog hat smoothing)      */
  AxisCfg axis[FSR_MAX_AXES];
  /* button_map[i] = bit position 0..31 to expose for physical
     button i (identity by default; lets the user remap).          */
  unsigned char button_map[FSR_MAX_BUTTONS];
  FfcCfg  ffb;
} AppConfig;

/* Fill cfg with factory defaults. */
void config_defaults(AppConfig *cfg);

/* Load config.json from path into cfg. Returns true on success.
 * On missing/invalid file, leaves cfg untouched (caller should seed
 * with config_defaults() first). */
int config_load(const char *path, AppConfig *cfg);

/* Persist cfg to path. Returns true on success. */
int config_save(const char *path, const AppConfig *cfg);

#endif /* FSR_CONFIG_H */
