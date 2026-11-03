/*
 * ui_gl.c - Win32 + WGL + OpenGL 1.1 fixed-function backend for microui.
 * Port of microui/demo/renderer.c with the SDL window replaced by a native
 * HWND + WGL context owned here.
 */
#include "ui_gl.h"

#include <stdio.h>
#include <string.h>
#include <GL/gl.h>
#include <wingdi.h>

/* atlas_texture / atlas[] / ATLAS_* come from the official demo atlas. */
#include "microui.h"
#include "atlas.inl"

#define BUFFER_SIZE 16384

static GLfloat  tex_buf[BUFFER_SIZE *  8];
static GLfloat  vert_buf[BUFFER_SIZE *  8];
static GLubyte  color_buf[BUFFER_SIZE * 16];
static GLuint   index_buf[BUFFER_SIZE *  6];

typedef int (APIENTRY *PFNwglSwapIntervalEXT)(int);

static int    g_w = 800;
static int    g_h = 600;
static int    g_buf_idx;
static HWND   g_hwnd;
static HDC    g_hdc;
static HGLRC  g_hglrc;
static GLuint g_tex;
static PFNwglSwapIntervalEXT g_wglSwapInterval;
static int    g_ready;

static void flush(void) {
  if (g_buf_idx == 0) return;

  glViewport(0, 0, g_w, g_h);
  glMatrixMode(GL_PROJECTION);
  glPushMatrix();
  glLoadIdentity();
  glOrtho(0.0f, g_w, g_h, 0.0f, -1.0f, +1.0f);
  glMatrixMode(GL_MODELVIEW);
  glPushMatrix();
  glLoadIdentity();

  glTexCoordPointer(2, GL_FLOAT, 0, tex_buf);
  glVertexPointer(2, GL_FLOAT, 0, vert_buf);
  glColorPointer(4, GL_UNSIGNED_BYTE, 0, color_buf);
  glDrawElements(GL_TRIANGLES, g_buf_idx * 6, GL_UNSIGNED_INT, index_buf);

  glMatrixMode(GL_MODELVIEW);
  glPopMatrix();
  glMatrixMode(GL_PROJECTION);
  glPopMatrix();

  g_buf_idx = 0;
}

static void push_quad(mu_Rect dst, mu_Rect src, mu_Color color) {
  if (g_buf_idx == BUFFER_SIZE) flush();

  int tv = g_buf_idx *  8;
  int ci = g_buf_idx * 16;
  int ei = g_buf_idx *  4;
  int ii = g_buf_idx *  6;
  g_buf_idx++;

  float x = src.x / (float) ATLAS_WIDTH;
  float y = src.y / (float) ATLAS_HEIGHT;
  float w = src.w / (float) ATLAS_WIDTH;
  float h = src.h / (float) ATLAS_HEIGHT;
  tex_buf[tv + 0] = x;     tex_buf[tv + 1] = y;
  tex_buf[tv + 2] = x + w; tex_buf[tv + 3] = y;
  tex_buf[tv + 4] = x;     tex_buf[tv + 5] = y + h;
  tex_buf[tv + 6] = x + w; tex_buf[tv + 7] = y + h;

  vert_buf[tv + 0] = dst.x;
  vert_buf[tv + 1] = dst.y;
  vert_buf[tv + 2] = dst.x + dst.w;
  vert_buf[tv + 3] = dst.y;
  vert_buf[tv + 4] = dst.x;
  vert_buf[tv + 5] = dst.y + dst.h;
  vert_buf[tv + 6] = dst.x + dst.w;
  vert_buf[tv + 7] = dst.y + dst.h;

  memcpy(color_buf + ci +  0, &color, 4);
  memcpy(color_buf + ci +  4, &color, 4);
  memcpy(color_buf + ci +  8, &color, 4);
  memcpy(color_buf + ci + 12, &color, 4);

  index_buf[ii + 0] = ei + 0;
  index_buf[ii + 1] = ei + 1;
  index_buf[ii + 2] = ei + 2;
  index_buf[ii + 3] = ei + 2;
  index_buf[ii + 4] = ei + 3;
  index_buf[ii + 5] = ei + 1;
}

static int choose_pixel_format(HDC hdc) {
  PIXELFORMATDESCRIPTOR pfd;
  memset(&pfd, 0, sizeof(pfd));
  pfd.nSize = sizeof(pfd);
  pfd.nVersion = 1;
  pfd.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
  pfd.iPixelType = PFD_TYPE_RGBA;
  pfd.cColorBits = 32;
  pfd.cDepthBits = 24;
  pfd.iLayerType = PFD_MAIN_PLANE;
  int pf = ChoosePixelFormat(hdc, &pfd);
  if (pf == 0) return 0;
  if (SetPixelFormat(hdc, pf, &pfd) == FALSE) return 0;
  return 1;
}

int uigl_create(HWND hwnd) {
  g_hwnd = hwnd;
  g_hdc = GetDC(hwnd);

  RECT rc; GetClientRect(hwnd, &rc);
  g_w = rc.right - rc.left;
  g_h = rc.bottom - rc.top;

  if (!choose_pixel_format(g_hdc)) { fprintf(stderr, "[ui_gl] pixel format\n"); return 1; }

  g_hglrc = wglCreateContext(g_hdc);
  if (!g_hglrc) { fprintf(stderr, "[ui_gl] wglCreateContext\n"); return 2; }
  if (!wglMakeCurrent(g_hdc, g_hglrc)) {
    fprintf(stderr, "[ui_gl] wglMakeCurrent\n"); return 3;
  }

  /* optional vsync if the extension is present */
  g_wglSwapInterval =
      (PFNwglSwapIntervalEXT)(void *)wglGetProcAddress("wglSwapIntervalEXT");
  if (g_wglSwapInterval) g_wglSwapInterval(1);

  glEnable(GL_BLEND);
  glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
  glDisable(GL_CULL_FACE);
  glDisable(GL_DEPTH_TEST);
  glEnable(GL_SCISSOR_TEST);
  glEnable(GL_TEXTURE_2D);
  glEnableClientState(GL_VERTEX_ARRAY);
  glEnableClientState(GL_TEXTURE_COORD_ARRAY);
  glEnableClientState(GL_COLOR_ARRAY);

  glGenTextures(1, &g_tex);
  glBindTexture(GL_TEXTURE_2D, g_tex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_ALPHA, ATLAS_WIDTH, ATLAS_HEIGHT, 0,
               GL_ALPHA, GL_UNSIGNED_BYTE, atlas_texture);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);

  g_buf_idx = 0;
  g_ready = 1;
  printf("[ui_gl] GL %s\n", (const char *)glGetString(GL_VERSION));
  return 0;
}

void uigl_resize(int width, int height) {
  if (width <= 0 || height <= 0) return;
  g_w = width;
  g_h = height;
}

int uigl_width(void) { return g_w; }
int uigl_height(void) { return g_h; }

void uigl_begin_frame(mu_Color clear) {
  if (!g_ready) return;
  flush();
  glViewport(0, 0, g_w, g_h);
  glScissor(0, 0, g_w, g_h);   /* default clip = whole client area */
  glClearColor(clear.r / 255., clear.g / 255., clear.b / 255., clear.a / 255.);
  glClear(GL_COLOR_BUFFER_BIT);
}

void uigl_draw_rect(mu_Rect rect, mu_Color color) {
  push_quad(rect, atlas[ATLAS_WHITE], color);
}

void uigl_draw_text(const char *text, mu_Vec2 pos, mu_Color color) {
  mu_Rect dst = { pos.x, pos.y, 0, 0 };
  for (const char *p = text; *p; p++) {
    if ((*p & 0xc0) == 0x80) continue;   /* skip UTF-8 continuation bytes */
    int chr = mu_min((unsigned char)*p, 127);
    mu_Rect src = atlas[ATLAS_FONT + chr];
    dst.w = src.w;
    dst.h = src.h;
    push_quad(dst, src, color);
    dst.x += dst.w;
  }
}

void uigl_draw_icon(int id, mu_Rect rect, mu_Color color) {
  mu_Rect src = atlas[id];
  int x = rect.x + (rect.w - src.w) / 2;
  int y = rect.y + (rect.h - src.h) / 2;
  push_quad(mu_rect(x, y, src.w, src.h), src, color);
}

void uigl_set_clip(mu_Rect rect) {
  flush();
  glScissor(rect.x, g_h - (rect.y + rect.h), rect.w, rect.h);
}

void uigl_end_frame(void) {
  if (!g_ready) return;
  flush();
  glFlush();
  SwapBuffers(g_hdc);
}

void uigl_destroy(void) {
  if (g_hglrc) { wglMakeCurrent(NULL, NULL); wglDeleteContext(g_hglrc); g_hglrc = NULL; }
  if (g_hdc && g_hwnd) { ReleaseDC(g_hwnd, g_hdc); g_hdc = NULL; }
  g_ready = 0;
}

int uigl_text_width(const char *text, int len) {
  int res = 0;
  for (const char *p = text; *p && len--; p++) {
    if ((*p & 0xc0) == 0x80) continue;
    int chr = mu_min((unsigned char)*p, 127);
    res += atlas[ATLAS_FONT + chr].w;
  }
  return res;
}

int uigl_text_height(void) { return 18; }
