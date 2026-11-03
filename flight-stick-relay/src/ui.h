/*
 * ui.h - native Win32 + microui control panel (taskbar tray resident).
 *
 * Drives the main event loop: pumps Win32 messages, the mongoose ws server,
 * and the force-feedback decay each frame. The window can be closed to the
 * system tray; double-click the tray icon to restore it.
 */
#ifndef FSR_UI_H
#define FSR_UI_H

#include "mongoose.h"

struct mg_mgr;

/* Create the window + GL context and run the main loop until the app quits
 * (tray menu "Exit"). Returns 0 normally. */
int ui_run(struct mg_mgr *mgr);

/* Ask the running ui_run() loop to exit (from Ctrl+C handler). */
void ui_request_quit(void);

#endif /* FSR_UI_H */
