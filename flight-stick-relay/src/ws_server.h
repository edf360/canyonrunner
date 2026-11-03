/*
 * ws_server.h - mongoose-based WebSocket relay for the HTML game.
 *
 * Single event loop (run on the main thread). Browsers connect to
 * ws://localhost:<port>/ws. Also serves game/index.html over http so the
 * demo client can be opened from the same listener.
 */
#ifndef FSR_WS_SERVER_H
#define FSR_WS_SERVER_H

#include "mongoose.h"

/* Start listening on cfg->ws_port (http + ws upgrade at /ws).
 * Returns 0 on success. */
int  ws_server_listen(struct mg_mgr *mgr, int port);

/* Periodic tick: pushes latest joystick state to all connected clients and
 * pushes config if it changed. Call from the main loop each poll. */
void ws_server_poll(struct mg_mgr *mgr, uint64_t now_ms);

#endif /* FSR_WS_SERVER_H */
