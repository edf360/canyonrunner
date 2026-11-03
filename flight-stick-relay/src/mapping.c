#include "mapping.h"

#include <math.h>
#include <string.h>

#define POV_CENTER 0xFFFFL

void mapping_smooth_reset(MapSmooth *s) {
  memset(s->last, 0, sizeof(s->last));
  s->initialised = 0;
}

static float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/* Normalize raw -> -1..1 using calibration, then shape with the per-axis cfg. */
static float shape_axis(long raw, const AxisCfg *a) {
  float span = a->cmax - a->cmin;
  if (span <= 1.0f) span = 1.0f;  /* guard bad calibration */
  float n = (float) raw;
  float v = (n - a->cmin) / span * 2.0f - 1.0f;
  v = clampf(v, -1.0f, 1.0f);

  float d = a->deadzone;
  if (d < 0) d = 0;
  if (d >= 1.0f) d = 0.999f;

  float av = fabsf(v);
  if (av <= d) {
    v = 0.0f;
  } else {
    av = (av - d) / (1.0f - d);       /* rescale outside deadzone -> 0..1 */
    float g = a->gamma;
    if (g < 0.05f) g = 0.05f;
    if (g != 1.0f) av = powf(av, g);  /* sensitivity curve */
    v = (v < 0.0f ? -1.0f : 1.0f) * clampf(av, 0.0f, 1.0f);
  }

  if (a->invert) v = -v;
  return v;
}

static void smooth_axis(float *out, float raw_v, const AxisCfg *a,
                        float *prev, int init) {
  float alpha = clampf(a->smooth, 0.0f, 1.0f);
  if (alpha <= 0.0f || !init) {
    *out = raw_v;
    *prev = raw_v;
  } else {
    float y = *prev + alpha * (raw_v - *prev);
    *out = y;
    *prev = y;
  }
}

void mapping_apply(const JoyRaw *raw, const AppConfig *cfg,
                   MapSmooth *smooth, JoyState *out) {
  if (!smooth->initialised) mapping_smooth_reset(smooth);

  for (int i = 0; i < FSR_MAX_AXES; i++) {
    float v = shape_axis(raw->axes[i], &cfg->axis[i]);
    float o;
    smooth_axis(&o, v, &cfg->axis[i], &smooth->last[i], 1);
    out->axes[i] = clampf(o, -1.0f, 1.0f);
  }

  /* hat (POV) -> x/y axes, degrees are 1/100th; 0xFFFF == centered */
  float hx = 0.0f, hy = 0.0f;
  if (raw->hat != POV_CENTER && raw->hat >= 0 && raw->hat <= 35900) {
    double deg = (double) raw->hat / 100.0;
    double rad = deg * 3.14159265358979 / 180.0;
    hx = (float) sin(rad);
    hy = (float) cos(rad);     /* +POV up => +y */
  }
  out->hatx = hx;
  out->haty = hy;
}

unsigned long mapping_remap_buttons(unsigned long raw, const AppConfig *cfg) {
  unsigned long out = 0;
  for (int i = 0; i < FSR_MAX_BUTTONS; i++) {
    if (raw & (1UL << i)) {
      int b = cfg->button_map[i];
      if (b >= 0 && b < FSR_MAX_BUTTONS) out |= (1UL << b);
    }
  }
  return out;
}
