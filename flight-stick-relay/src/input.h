/*
 * input.h - joystick polling thread + capability probe.
 */
#ifndef FSR_INPUT_H
#define FSR_INPUT_H

#include "state.h"

/* Probe available devices, pick the first responding joystick, publish caps
 * via state_set_caps(). Returns 1 if a device was found. */
int  input_probe(JoyCaps *caps_out);

/* Start the polling thread (samples at cfg->poll_hz). Returns 0 on success. */
int  input_start(void);

/* Ask the thread to stop and join it. */
void input_stop(void);

#endif /* FSR_INPUT_H */
