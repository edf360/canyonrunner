/*
 * mapping.h - raw -> processed axis/button/hat transformation pipeline.
 *
 * Pure functions: given raw joy values and an AxisCfg, produce -1..1.
 * Stateless smoothing keeps per-axis filter state in a caller-owned array so
 * the mapping itself stays testable.
 */
#ifndef FSR_MAPPING_H
#define FSR_MAPPING_H

#include <stdint.h>

#include "config.h"
#include "state.h"

/* Persistent smoothing state for one input pass. */
typedef struct {
  float last[FSR_MAX_AXES];
  int   initialised;
} MapSmooth;

void mapping_smooth_reset(MapSmooth *s);

/* Transform one raw sample into a processed JoyState using cfg.
 * Advances *smooth for low-pass filtering. */
void mapping_apply(const JoyRaw *raw, const AppConfig *cfg,
                   MapSmooth *smooth, JoyState *out);

/* Map a physical button bitmask through cfg->button_map into output bits. */
unsigned long mapping_remap_buttons(unsigned long raw, const AppConfig *cfg);

#endif /* FSR_MAPPING_H */
