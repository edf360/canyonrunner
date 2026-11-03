/*
 * ui.c - Win32 + microui control panel with taskbar-tray residency.
 *
 * Owns the application main loop: pumps Win32 messages, the mongoose web
 * server, and force-feedback decay every frame. The settings widgets edit a
 * local AppConfig and push it to the shared state on change (live apply);
 * "Save" persists to config.json.
 */
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>
#include <string.h>

#include "microui.h"

#include "mongoose.h"

#include "config.h"
#include "ffb.h"
#include "input.h"
#include "state.h"
#include "ui.h"
#include "ui_gl.h"
#include "ws_server.h"

#define WM_APP_TRAY (WM_APP + 1)
#define TRAY_UID    1

#define MENU_TRAY_SHOW 1001
#define MENU_TRAY_EXIT 1002
#define MENU_TRAY_SAVE 1003

static const wchar_t *WIN_CLASS = L"FlightStickRelayWnd";
static const wchar_t *WIN_TITLE = L"Flight Stick Relay";

static mu_Context g_ctx;
static AppConfig  g_cfg;
static HICON      g_icon;
static HWND       g_hwnd;
static int        g_w = 760;
static int        g_h = 560;
static int        g_visible = 1;
static int        g_quit = 0;
static int        g_drag = 0;

static char g_log[4096];
static int  g_log_pos = 0;

/* forward */
static void ui_add_log(const char *msg);

/* microui 2.02 has no style push/pop, so temporarily recolor the text colour
 * for a single label. Used to flag the no-rumble (ffb=0) state. */
static void label_colored(mu_Context *ctx, const char *s, mu_Color c) {
  mu_Color old = ctx->style->colors[MU_COLOR_TEXT];
  ctx->style->colors[MU_COLOR_TEXT] = c;
  mu_label(ctx, s);
  ctx->style->colors[MU_COLOR_TEXT] = old;
}

static void ui_add_log(const char *msg) {
  int n = (int) strlen(msg);
  if (n > 0 && g_log_pos < (int) sizeof(g_log) - 2) {
    if (g_log_pos > 0) g_log[g_log_pos++] = '\n';
    memcpy(g_log + g_log_pos, msg, n);
    g_log_pos += n;
    g_log[g_log_pos] = '\0';
  }
}

/* ---- microui font metric callbacks ------------------------------------ */
static int text_width(mu_Font font, const char *text, int len) {
  (void) font;
  if (len == -1) len = (int) strlen(text);
  return uigl_text_width(text, len);
}
static int text_height(mu_Font font) { (void) font; return uigl_text_height(); }

/* ---- tray -------------------------------------------------------------- */
static void tray_add(HWND hwnd) {
  NOTIFYICONDATAW nid;
  memset(&nid, 0, sizeof(nid));
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = TRAY_UID;
  nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  nid.uCallbackMessage = WM_APP_TRAY;
  nid.hIcon = g_icon;
  lstrcpynW(nid.szTip, WIN_TITLE, ARRAYSIZE(nid.szTip));
  Shell_NotifyIconW(NIM_ADD, &nid);
}
static void tray_remove(HWND hwnd) {
  NOTIFYICONDATAW nid;
  memset(&nid, 0, sizeof(nid));
  nid.cbSize = sizeof(nid);
  nid.hWnd = hwnd;
  nid.uID = TRAY_UID;
  Shell_NotifyIconW(NIM_DELETE, &nid);
}
static void show_window(HWND hwnd) {
  g_visible = 1;
  ShowWindow(hwnd, SW_SHOW);
  SetForegroundWindow(hwnd);
}
static void hide_window(HWND hwnd) { g_visible = 0; ShowWindow(hwnd, SW_HIDE); }

static void tray_menu(HWND hwnd) {
  POINT p; GetCursorPos(&p);
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING, MENU_TRAY_SHOW, L"表示");
  AppendMenuW(m, MF_STRING, MENU_TRAY_SAVE, L"設定を保存");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, MENU_TRAY_EXIT, L"終了");
  SetForegroundWindow(hwnd);
  TrackPopupMenu(m, TPM_RIGHTBUTTON, p.x, p.y, 0, hwnd, NULL);
  DestroyMenu(m);
}

/* ---- settings <-> state ----------------------------------------------- */
static void commit(const char *what) {
  state_config_set(&g_cfg);
  if (what) ui_add_log(what);
}

/* ---- settings window --------------------------------------------------- */
static void settings_window(void) {
  mu_Context *ctx = &g_ctx;
  if (!mu_begin_window(ctx, "Settings", mu_rect(16, 16, 380, 540))) return;

  /* Give the scroll panel an explicit row that fills the window body and
     leaves ~34px for the Save/Reset row below. microui sizes a panel from the
     current layout row, so this MUST come *before* mu_begin_panel -- if the
     first row is set inside the panel it collapses to zero and every control
     within it is clipped away (only the buttons after mu_end_panel show). */
  mu_layout_row(ctx, 1, (int[]) { -1 }, -34);
  mu_begin_panel(ctx, "settings_scroll");
  mu_layout_row(ctx, 2, (int[]) { 96, -1 }, 0);

  /* global */
  if (mu_header_ex(ctx, "Global", MU_OPT_EXPANDED)) {
    float wsport = (float) g_cfg.ws_port;
    float hz = (float) g_cfg.poll_hz;
    mu_label(ctx, "WS port:");
    if (mu_number_ex(ctx, &wsport, 1, "%.0f", MU_OPT_ALIGNCENTER)) {
      g_cfg.ws_port = (int) wsport; commit("ws_port (reconnect)");
    }
    mu_label(ctx, "Poll Hz:");
    if (mu_number_ex(ctx, &hz, 5, "%.0f", MU_OPT_ALIGNCENTER)) {
      g_cfg.poll_hz = (int) hz; if (g_cfg.poll_hz < 10) g_cfg.poll_hz = 10;
      if (g_cfg.poll_hz > 1000) g_cfg.poll_hz = 1000;
      commit("poll_hz");
    }
    mu_label(ctx, "Hat dead:");
    if (mu_slider_ex(ctx, &g_cfg.hat_deadzone, 0.f, 0.9f, 0.f, MU_SLIDER_FMT,
                     MU_OPT_ALIGNCENTER))
      commit("hat_deadzone");
  }

  /* axes */
  if (mu_header_ex(ctx, "Axes", MU_OPT_EXPANDED)) {
    for (int i = 0; i < FSR_MAX_AXES; i++) {
      AxisCfg *a = &g_cfg.axis[i];
      char lbl[24];
      snprintf(lbl, sizeof(lbl), "Axis %d", i);
      if (mu_begin_treenode_ex(ctx, lbl, i == 0 ? MU_OPT_EXPANDED : 0)) {
        mu_layout_row(ctx, 2, (int[]) { 70, -1 }, 0);
        mu_label(ctx, "dead:");
        mu_slider_ex(ctx, &a->deadzone, 0.f, 0.5f, 0.f, MU_SLIDER_FMT,
                     MU_OPT_ALIGNCENTER);
        mu_label(ctx, "gamma:");
        mu_slider_ex(ctx, &a->gamma, 0.1f, 3.f, 0.f, MU_SLIDER_FMT,
                     MU_OPT_ALIGNCENTER);
        mu_label(ctx, "smooth:");
        mu_slider_ex(ctx, &a->smooth, 0.f, 0.99f, 0.f, MU_SLIDER_FMT,
                     MU_OPT_ALIGNCENTER);
        mu_layout_row(ctx, 2, (int[]) { 70, -1 }, 0);
        int inv = a->invert;
        mu_label(ctx, "invert:");
        if (mu_checkbox(ctx, (a->invert ? "yes" : "no"), &inv)) {
          a->invert = inv; commit("invert");
        }
        mu_label(ctx, "raw min:");
        mu_number_ex(ctx, &a->cmin, 10, "%.0f", MU_OPT_ALIGNCENTER);
        mu_label(ctx, "raw max:");
        mu_number_ex(ctx, &a->cmax, 10, "%.0f", MU_OPT_ALIGNCENTER);
        mu_layout_row(ctx, 1, (int[]) { -1 }, 0);
        if (mu_button(ctx, "Capture range (move now)")) {
          /* seed calibration from the current raw sample (centre +/- margin) */
          int conn; JoyRaw raw; state_raw_snapshot(&raw, &conn);
          long c = raw.axes[i];
          a->cmin = (float) (c - 2000);
          a->cmax = (float) (c + 2000);
          if (a->cmax <= a->cmin + 1) { a->cmin = 0; a->cmax = 65535; }
          commit("axis range");
        }
        mu_end_treenode(ctx);
      }
    }
  }

  /* ffb */
  if (mu_header_ex(ctx, "Force Feedback", MU_OPT_EXPANDED)) {
    JoyCaps caps; state_caps_snapshot(&caps);
    if (!caps.has_ffb) {
      label_colored(ctx,
        "! This stick reports no force-feedback/rumble,",
        mu_color(255, 193, 7, 255));
      label_colored(ctx,
        "so vibration cannot play. Backend runs as 'noop'.",
        mu_color(255, 193, 7, 255));
    }
    mu_layout_row(ctx, 2, (int[]) { 78, -1 }, 0);
    mu_label(ctx, "backend:");
    if (mu_button(ctx,
                  (g_cfg.ffb.backend[0] ? g_cfg.ffb.backend : "auto")))
      mu_open_popup(ctx, "backend_popup");
    if (mu_begin_popup(ctx, "backend_popup")) {
      /* "directinput" is intentionally absent: no DI FF backend is
         implemented (the Flight Stick EX reports 0 FF effects). */
      const char *opts[] = { "auto", "xinput", "noop", NULL };
      for (int i = 0; opts[i]; i++)
        if (mu_button(ctx, opts[i])) {
          strncpy(g_cfg.ffb.backend, opts[i], sizeof(g_cfg.ffb.backend) - 1);
          g_cfg.ffb.backend[sizeof(g_cfg.ffb.backend) - 1] = '\0';
          commit("ffb backend");
        }
      mu_end_popup(ctx);
    }
    mu_label(ctx, "intensity:");
    if (mu_slider_ex(ctx, &g_cfg.ffb.intensity, 0.f, 1.f, 0.f, MU_SLIDER_FMT,
                     MU_OPT_ALIGNCENTER))
      commit("ffb intensity");
    mu_label(ctx, "curve:");
    if (mu_slider_ex(ctx, &g_cfg.ffb.curve, 0.1f, 3.f, 0.f, MU_SLIDER_FMT,
                     MU_OPT_ALIGNCENTER))
      commit("ffb curve");
  }

  mu_end_panel(ctx);

  mu_layout_row(ctx, 2, (int[]) { -1, -1 }, 0);
  if (mu_button(ctx, "Save to config.json")) {
    if (config_save(CONFIG_PATH, &g_cfg)) ui_add_log("saved");
    else ui_add_log("SAVE FAILED");
  }
  if (mu_button(ctx, "Reset defaults")) {
    config_defaults(&g_cfg);
    commit("defaults");
  }
  mu_end_window(ctx);
}

/* ---- device status / live window -------------------------------------- */
static void status_window(void) {
  mu_Context *ctx = &g_ctx;
  if (!mu_begin_window(ctx, "Device", mu_rect(410, 16, 320, 400))) return;

  JoyCaps caps; state_caps_snapshot(&caps);
  JoyState joy; state_snapshot(&joy);

  char b[192];
  snprintf(b, sizeof(b), "name: %.40s", caps.name[0] ? caps.name : "(none)");
  mu_label(ctx, b);
  snprintf(b, sizeof(b), "present:%d ffb:%d backend:%s", caps.present,
           caps.has_ffb, ffb_backend_name());
  if (caps.has_ffb) {
    mu_label(ctx, b);
  } else {
    label_colored(ctx, b, mu_color(255, 193, 7, 255)); /* amber: no rumble */
    label_colored(ctx, "! Vibration not supported by this device",
                  mu_color(255, 193, 7, 255));
  }
  snprintf(b, sizeof(b), "axes:%d buttons:%d hat:%d", caps.axes, caps.buttons,
           caps.has_hat);
  mu_label(ctx, b);

  mu_label(ctx, "live (calib -1..1)");
  mu_layout_row(ctx, 2, (int[]) { 48, -1 }, 0);
  for (int i = 0; i < caps.axes && i < FSR_MAX_AXES; i++) {
    snprintf(b, sizeof(b), "axis%d", i);
    mu_label(ctx, b);
    mu_Rect r = mu_layout_next(ctx);
    /* bar background + fill centred at the midpoint */
    mu_draw_rect(ctx, r, mu_color(40, 44, 52, 255));
    float v = joy.axes[i];
    int half = (int) (v * r.w / 2.f);
    mu_Rect fill = (half >= 0)
        ? mu_rect(r.x + r.w / 2, r.y, half, r.h)
        : mu_rect(r.x + r.w / 2 + half, r.y, -half, r.h);
    mu_draw_rect(ctx, fill, mu_color(47, 129, 247, 255));
  }
  /* hat (D-pad / POV) as two bars so it is visible like the axes */
  mu_layout_row(ctx, 2, (int[]) { 48, -1 }, 0);
  const char *hat_lbl[2] = { "hat.x", "hat.y" };
  float hat_val[2] = { joy.hatx, joy.haty };
  for (int h = 0; h < 2; h++) {
    mu_label(ctx, hat_lbl[h]);
    mu_Rect r = mu_layout_next(ctx);
    mu_draw_rect(ctx, r, mu_color(40, 44, 52, 255));
    int half = (int) (hat_val[h] * r.w / 2.f);
    mu_Rect fill = (half >= 0)
        ? mu_rect(r.x + r.w / 2, r.y, half, r.h)
        : mu_rect(r.x + r.w / 2 + half, r.y, -half, r.h);
    mu_draw_rect(ctx, fill, mu_color(186, 114, 247, 255));
  }

  snprintf(b, sizeof(b), "buttons (%d)", caps.buttons);
  mu_label(ctx, b);
  /* buttons grid, lit when the bitmask bit is set */
  mu_layout_row(ctx, 8, (int[]) { 30, 30, 30, 30, 30, 30, 30, -1 }, 0);
  for (int i = 0; i < caps.buttons && i < FSR_MAX_BUTTONS; i++) {
    int on = (joy.buttons >> i) & 1u;
    mu_draw_rect(ctx, mu_layout_next(ctx),
                 on ? mu_color(248, 81, 73, 255) : mu_color(48, 54, 61, 255));
  }

  mu_end_window(ctx);
}

/* ---- log window -------------------------------------------------------- */
static void log_window(void) {
  mu_Context *ctx = &g_ctx;
  if (!mu_begin_window(ctx, "Log", mu_rect(410, 426, 320, 180))) return;
  mu_layout_row(ctx, 1, (int[]) { -1 }, -1);
  mu_begin_panel(ctx, "log_panel");
  mu_text(ctx, g_log[0] ? g_log : "(no events yet)");
  mu_Container *pnl = mu_get_container(ctx, "log_panel");
  if (pnl) pnl->scroll.y = pnl->content_size.y;
  mu_end_panel(ctx);
  mu_end_window(ctx);
}

/* ---- frame ------------------------------------------------------------- */
static void process_frame(void) {
  mu_begin(&g_ctx);
  status_window();
  settings_window();
  log_window();
  mu_end(&g_ctx);
}

static void render_frame(void) {
  uigl_begin_frame(mu_color(36, 39, 45, 255));
  mu_Command *cmd = NULL;
  while (mu_next_command(&g_ctx, &cmd)) {
    switch (cmd->type) {
      case MU_COMMAND_TEXT: uigl_draw_text(cmd->text.str, cmd->text.pos, cmd->text.color); break;
      case MU_COMMAND_RECT: uigl_draw_rect(cmd->rect.rect, cmd->rect.color); break;
      case MU_COMMAND_ICON: uigl_draw_icon(cmd->icon.id, cmd->icon.rect, cmd->icon.color); break;
      case MU_COMMAND_CLIP: uigl_set_clip(cmd->clip.rect); break;
      default: break;
    }
  }
  uigl_end_frame();
}

/* ---- winproc ----------------------------------------------------------- */
static void on_size(void) {
  RECT rc; GetClientRect(g_hwnd, &rc);
  g_w = rc.right - rc.left;
  g_h = rc.bottom - rc.top;
  uigl_resize(g_w, g_h);
}

static LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CREATE:
      g_hwnd = hwnd;
      return 0;
    case WM_SIZE:
      if (!g_visible) return 0;
      on_size();
      return 0;
    case WM_ERASEBKGND:
      return 1; /* we paint via GL */
    case WM_CLOSE:
      /* "X" hides to the tray instead of exiting; restore via tray icon.
       * Quit with the tray menu's "Exit". */
      hide_window(hwnd);
      return 0;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;

    case WM_LBUTTONDOWN:
      g_drag = 1; SetCapture(hwnd);
      mu_input_mousedown(&g_ctx, (short) LOWORD(lp), (short) HIWORD(lp),
                         MU_MOUSE_LEFT);
      return 0;
    case WM_LBUTTONUP:
      g_drag = 0; ReleaseCapture();
      mu_input_mouseup(&g_ctx, (short) LOWORD(lp), (short) HIWORD(lp),
                       MU_MOUSE_LEFT);
      return 0;
    case WM_RBUTTONDOWN:
      mu_input_mousedown(&g_ctx, (short) LOWORD(lp), (short) HIWORD(lp),
                         MU_MOUSE_RIGHT);
      return 0;
    case WM_RBUTTONUP:
      mu_input_mouseup(&g_ctx, (short) LOWORD(lp), (short) HIWORD(lp),
                       MU_MOUSE_RIGHT);
      return 0;
    case WM_MBUTTONDOWN:
      mu_input_mousedown(&g_ctx, (short) LOWORD(lp), (short) HIWORD(lp),
                         MU_MOUSE_MIDDLE);
      return 0;
    case WM_MBUTTONUP:
      mu_input_mouseup(&g_ctx, (short) LOWORD(lp), (short) HIWORD(lp),
                       MU_MOUSE_MIDDLE);
      return 0;
    case WM_MOUSEMOVE:
      mu_input_mousemove(&g_ctx, (short) LOWORD(lp), (short) HIWORD(lp));
      return 0;
    case WM_MOUSEWHEEL: {
      int delta = GET_WHEEL_DELTA_WPARAM(wp);
      mu_input_scroll(&g_ctx, 0, -(delta / 120) * 30);
      return 0;
    }
    case WM_KEYDOWN:
      switch (wp) {
        case VK_SHIFT: case VK_LSHIFT: case VK_RSHIFT:
          mu_input_keydown(&g_ctx, MU_KEY_SHIFT); break;
        case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL:
          mu_input_keydown(&g_ctx, MU_KEY_CTRL); break;
        case VK_MENU: case VK_LMENU: case VK_RMENU:
          mu_input_keydown(&g_ctx, MU_KEY_ALT); break;
        case VK_BACK: mu_input_keydown(&g_ctx, MU_KEY_BACKSPACE); break;
        case VK_RETURN: mu_input_keydown(&g_ctx, MU_KEY_RETURN); break;
        default: break;
      }
      return 0;
    case WM_KEYUP:
      switch (wp) {
        case VK_SHIFT: case VK_LSHIFT: case VK_RSHIFT:
          mu_input_keyup(&g_ctx, MU_KEY_SHIFT); break;
        case VK_CONTROL: case VK_LCONTROL: case VK_RCONTROL:
          mu_input_keyup(&g_ctx, MU_KEY_CTRL); break;
        case VK_MENU: case VK_LMENU: case VK_RMENU:
          mu_input_keyup(&g_ctx, MU_KEY_ALT); break;
        case VK_BACK: mu_input_keyup(&g_ctx, MU_KEY_BACKSPACE); break;
        case VK_RETURN: mu_input_keyup(&g_ctx, MU_KEY_RETURN); break;
        default: break;
      }
      return 0;
    case WM_CHAR: {
      char c = (char)(wp & 0xFF);
      char s[2] = { c, 0 };
      if (c >= 32) mu_input_text(&g_ctx, s);
      return 0;
    }

    case WM_APP_TRAY:
      switch (LOWORD(lp)) {
        case WM_LBUTTONDBLCLK: show_window(hwnd); break;
        case WM_RBUTTONUP: tray_menu(hwnd); break;
        default: break;
      }
      return 0;
    case WM_COMMAND:
      switch (LOWORD(wp)) {
        case MENU_TRAY_SHOW: show_window(hwnd); break;
        case MENU_TRAY_SAVE: config_save(CONFIG_PATH, &g_cfg); ui_add_log("saved"); break;
        case MENU_TRAY_EXIT:
          g_quit = 1;
          DestroyWindow(hwnd);
          break;
        default: break;
      }
      return 0;
    default:
      return DefWindowProcW(hwnd, msg, wp, lp);
  }
}

/* ---- run --------------------------------------------------------------- */
int ui_run(struct mg_mgr *mgr) {
  g_icon = LoadIconW(NULL, IDI_APPLICATION);

  state_config_snapshot(&g_cfg); /* main.c already seeded config.json */
  ui_add_log("UI ready");

  WNDCLASSEXW wc;
  memset(&wc, 0, sizeof(wc));
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = wnd_proc;
  wc.hInstance = GetModuleHandleW(NULL);
  wc.hCursor = LoadCursorW(NULL, (LPCWSTR) IDC_ARROW);
  wc.hbrBackground = (HBRUSH) GetStockObject(BLACK_BRUSH);
  wc.lpszClassName = WIN_CLASS;
  wc.hIcon = g_icon;
  wc.hIconSm = g_icon;
  if (!RegisterClassExW(&wc)) { fprintf(stderr, "[ui] RegisterClass failed\n"); return 1; }

  g_hwnd = CreateWindowExW(
      0, WIN_CLASS, WIN_TITLE, WS_OVERLAPPEDWINDOW,
      CW_USEDEFAULT, CW_USEDEFAULT, g_w, g_h, NULL, NULL,
      GetModuleHandleW(NULL), NULL);
  if (!g_hwnd) { fprintf(stderr, "[ui] CreateWindow failed\n"); return 2; }

  if (uigl_create(g_hwnd) != 0) { fprintf(stderr, "[ui] GL init failed\n"); return 3; }
  on_size();

  mu_init(&g_ctx);
  g_ctx.text_width = text_width;
  g_ctx.text_height = text_height;

  tray_add(g_hwnd);
  ShowWindow(g_hwnd, SW_SHOW);
  UpdateWindow(g_hwnd);

  MSG msg;
  int have_msg = 0;
  while (!g_quit) {
    while (have_msg || PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) {
      have_msg = 1;
      if (msg.message == WM_QUIT) { g_quit = 1; break; }
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
      have_msg = 0;
    }
    if (g_quit) break;

    /* pump network + ffb even when the window is hidden */
    mg_mgr_poll(mgr, 1);
    ws_server_poll(mgr, GetTickCount64());
    ffb_update();

    if (g_visible) {
      process_frame();
      render_frame();
    } else {
      Sleep(50); /* idle while in tray */
    }
  }

  tray_remove(g_hwnd);
  uigl_destroy();
  return 0;
}

void ui_request_quit(void) { g_quit = 1; }
