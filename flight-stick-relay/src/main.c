/*
 * flight_stick_relay - USB flight stick -> HTML flight game relay.
 *
 * Console/launch entry point. Wires together:
 *   config (config.json) -> state -> input thread -> ws_server (mongoose)
 * and the force-feedback backend. The native microui UI is added in ui.c
 * (milestone 7); until then this runs headless with console logging.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

#include "mongoose.h"

#include "config.h"
#include "ffb.h"
#include "input.h"
#include "state.h"
#include "ui.h"
#include "ws_server.h"

static BOOL WINAPI ctrl_handler(DWORD type) {
  (void) type;
  ui_request_quit();
  return TRUE;
}

int main(int argc, char **argv) {
  (void) argc; (void) argv;

  /* Unbuffered stdout so logs appear immediately even when redirected to a
     file (also useful when the tray app logs to a file). */
  setvbuf(stdout, NULL, _IONBF, 0);

  SetConsoleCtrlHandler(ctrl_handler, TRUE);
  printf("flight_stick_relay starting\n");

  /* 1. config: load persisted, seed defaults, persist if first run */
  state_init();
  AppConfig cfg;
  state_config_snapshot(&cfg);
  if (!config_load(CONFIG_PATH, &cfg)) {
    config_defaults(&cfg);
    config_save(CONFIG_PATH, &cfg);
    printf("[main] wrote default %s\n", CONFIG_PATH);
  }
  state_config_set(&cfg);

  /* 2. input: probe device + capabilities, publish caps */
  JoyCaps caps;
  if (!input_probe(&caps))
    printf("[main] WARNING: no joystick detected (still starting)\n");

  /* 3. ffb: choose backend based on config + device */
  ffb_startup(&cfg);

  /* 4. input thread (sampling) */
  if (input_start() != 0) {
    fprintf(stderr, "[main] failed to start input thread\n");
    return 2;
  }

  /* 5. ws server */
  struct mg_mgr mgr;
  mg_mgr_init(&mgr);
  if (ws_server_listen(&mgr, cfg.ws_port) != 0) {
    fprintf(stderr, "[main] failed to start ws server\n");
    input_stop();
    return 3;
  }

  printf("[main] running. Open game/index.html in a browser "
         "(it connects to ws://localhost:%d/ws)\n", cfg.ws_port);

  /* 6. UI + main loop (owns the message pump; pumps ws + ffb each frame) */
  int rc = ui_run(&mgr);

  printf("[main] shutting down\n");
  ffb_stop_all();
  ffb_shutdown();
  input_stop();
  mg_mgr_free(&mgr);
  state_config_snapshot(&cfg);
  config_save(CONFIG_PATH, &cfg);
  return rc;
}
