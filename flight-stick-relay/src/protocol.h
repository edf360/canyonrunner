/*
 * protocol.h - shared WebSocket message protocol (single source of truth).
 *
 * Transport: ws://localhost:<port>. All messages are JSON text frames with a
 * string discriminator in field "t". See plans/flight-stick-relay.md section 3.
 */
#ifndef FSR_PROTOCOL_H
#define FSR_PROTOCOL_H

/* --- message "t" values ---------------------------------------------------- */
/* game -> app */
#define MSG_FF     "ff"     /* vibration / FFB request            */
#define MSG_CFGGET "cfg.get"
#define MSG_CFGSET "cfg.set"
#define MSG_PING   "ping"

/* app -> game */
#define MSG_STATE  "state"  /* joystick state (axes/hat/buttons)  */
#define MSG_INFO   "info"   /* device capabilities                */
#define MSG_HELLO  "hello"  /* connection + device presence flag  */
#define MSG_CFG    "cfg"    /* full or partial config push        */
#define MSG_PONG   "pong"

/* FFB effect kinds understood by the app. Maps to backend curves. */
#define FF_IMPACT "impact"
#define FF_STALL  "stall"
#define FF_WARN   "warning"
#define FF_RUMBLE "rumble"

/* Field paths used with mongoose mg_json_get_* (JSONPath-like). */
#define J_T          "$.t"
#define J_EFFECT     "$.effect"
#define J_INTENSITY  "$.intensity"
#define J_DURATION   "$.duration_ms"
#define J_AXIS       "$.axis"
#define J_CFG_KEY    "$.key"
#define J_CFG_VALUE  "$.value"

#endif /* FSR_PROTOCOL_H */
