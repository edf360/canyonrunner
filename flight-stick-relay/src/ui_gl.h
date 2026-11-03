/*
 * ui_gl.h - tiny OpenGL fixed-function backend for microui (Win32 + WGL).
 *
 * Port of microui/demo/renderer.c away from SDL: the window/HDC/HGLRC are
 * owned here and driven by ui.c. Coordinates are top-left origin (the ortho
 * flip matches microui's command space).
 */
#ifndef FSR_UI_GL_H
#define FSR_UI_GL_H

#include <windows.h>

#include "microui.h"

/* Create a WGL context for the given window and upload the font atlas.
 * Returns 0 on success. */
int  uigl_create(HWND hwnd);

/* Set the client size (used by projection/scissor). Call on WM_SIZE. */
void uigl_resize(int width, int height);

int  uigl_width(void);
int  uigl_height(void);

void uigl_begin_frame(mu_Color clear);
void uigl_draw_rect(mu_Rect rect, mu_Color color);
void uigl_draw_text(const char *text, mu_Vec2 pos, mu_Color color);
void uigl_draw_icon(int id, mu_Rect rect, mu_Color color);
void uigl_set_clip(mu_Rect rect);
void uigl_end_frame(void);
void uigl_destroy(void);

/* Font metrics for microui callbacks. */
int  uigl_text_width(const char *text, int len);
int  uigl_text_height(void);

#endif /* FSR_UI_GL_H */
