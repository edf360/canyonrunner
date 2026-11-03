#include "ws_server.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ffb.h"
#include "protocol.h"
#include "state.h"

#define STATE_INTERVAL_MS 8

static uint64_t g_last_cfg_epoch = 0;

/* --- outgoing JSON -------------------------------------------------------- */
static void send_json(struct mg_connection *c, const char *fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  mg_ws_send(c, buf, strlen(buf), WEBSOCKET_OP_TEXT);
}

static void send_state(struct mg_connection *c, const JoyState *s) {
  char buf[512];
  int n = snprintf(buf, sizeof(buf),
      "{\"t\":\"state\",\"seq\":%llu,\"t_ms\":%llu,"
      "\"axes\":[%.4f,%.4f,%.4f,%.4f,%.4f,%.4f],"
      "\"hatx\":%.4f,\"haty\":%.4f,\"buttons\":%lu}",
      (unsigned long long) s->seq, (unsigned long long) s->t_ms,
      s->axes[0], s->axes[1], s->axes[2], s->axes[3], s->axes[4], s->axes[5],
      s->hatx, s->haty, (unsigned long) s->buttons);
  if (n > 0) mg_ws_send(c, buf, (size_t) n, WEBSOCKET_OP_TEXT);
}

static void send_caps(struct mg_connection *c, const JoyCaps *cap, int connected) {
  JoyCaps tmp = *cap;
  char name[96] = {0};
  /* strip chars that would break JSON (device names are ASCII, but be safe) */
  size_t j = 0;
  for (size_t i = 0; tmp.name[i] && j < sizeof(name) - 1; i++) {
    char ch = tmp.name[i];
    if (ch == '"' || ch == '\\') name[j++] = '_';
    else name[j++] = ch;
  }
  send_json(c,
      "{\"t\":\"hello\",\"connected\":%s,\"caps\":{\"present\":%s,\"axes\":%d,"
      "\"buttons\":%d,\"hat\":%s,\"ffb\":%s,\"backend\":\"%s\",\"name\":\"%s\"}}",
      connected ? "true" : "false",
      tmp.present ? "true" : "false",
      tmp.axes, tmp.buttons,
      tmp.has_hat ? "true" : "false",
      tmp.has_ffb ? "true" : "false",
      ffb_backend_name(), name);
}

static void send_cfg(struct mg_connection *c, const AppConfig *cfg) {
  /* Sized for FSR_MAX_AXES axis objects (~90B each) plus the surrounding
     header/footer. Generous to avoid truncation that would corrupt JSON. */
  char buf[2048];
  char axes[1024];
  axes[0] = '\0';
  int off = 0;
  for (int i = 0; i < FSR_MAX_AXES; i++) {
    int w = snprintf(axes + off, sizeof(axes) - off,
                     "%s{\"deadzone\":%.4f,\"gamma\":%.4f,\"invert\":%d,"
                     "\"smooth\":%.4f,\"cmin\":%.2f,\"cmax\":%.2f}",
                     (i == 0) ? "" : ",",
                     cfg->axis[i].deadzone, cfg->axis[i].gamma,
                     cfg->axis[i].invert, cfg->axis[i].smooth,
                     cfg->axis[i].cmin, cfg->axis[i].cmax);
    if (w < 0 || off + w >= (int) sizeof(axes)) { off = off > 0 ? off - 1 : 0; break; }
    off += w;
  }
  int n = snprintf(buf, sizeof(buf),
      "{\"t\":\"cfg\",\"ws_port\":%d,\"poll_hz\":%d,\"hat_deadzone\":%.4f,"
      "\"axis\":[%s],\"ffb\":{\"backend\":\"%s\",\"intensity\":%.4f,"
      "\"curve\":%.4f}}",
      cfg->ws_port, cfg->poll_hz, cfg->hat_deadzone, axes,
      cfg->ffb.backend, cfg->ffb.intensity, cfg->ffb.curve);
  if (n > 0) mg_ws_send(c, buf, (size_t) n, WEBSOCKET_OP_TEXT);
}

/* --- incoming ------------------------------------------------------------- */
static void apply_cfg_kv(AppConfig *cfg, const char *key, double num,
                         const char *strval) {
  /* Keys mirror config.json JSONPath minus the leading "$.": e.g.
     axis[0].deadzone, ffb.intensity, ffb.backend, ws_port, poll_hz. */
  int ax = -1;
  char sub[32] = {0};
  if (sscanf(key, "axis[%d].%31[^\n]", &ax, sub) == 2 &&
      ax >= 0 && ax < FSR_MAX_AXES) {
    AxisCfg *a = &cfg->axis[ax];
    if (!strcmp(sub, "deadzone")) a->deadzone = (float) num;
    else if (!strcmp(sub, "gamma")) a->gamma = (float) num;
    else if (!strcmp(sub, "invert")) a->invert = (int) num;
    else if (!strcmp(sub, "smooth")) a->smooth = (float) num;
    else if (!strcmp(sub, "cmin")) a->cmin = (float) num;
    else if (!strcmp(sub, "cmax")) a->cmax = (float) num;
  } else if (!strcmp(key, "hat_deadzone")) cfg->hat_deadzone = (float) num;
  else if (!strcmp(key, "ws_port")) cfg->ws_port = (int) num;
  else if (!strcmp(key, "poll_hz")) cfg->poll_hz = (int) num;
  else if (!strcmp(key, "ffb.intensity")) cfg->ffb.intensity = (float) num;
  else if (!strcmp(key, "ffb.curve")) cfg->ffb.curve = (float) num;
  else if (!strcmp(key, "ffb.backend") && strval) {
    strncpy(cfg->ffb.backend, strval, sizeof(cfg->ffb.backend) - 1);
    cfg->ffb.backend[sizeof(cfg->ffb.backend) - 1] = '\0';
  }
}

static void handle_ws_msg(struct mg_connection *c, struct mg_ws_message *wm) {
  struct mg_str s = wm->data;
  char *type = mg_json_get_str(s, J_T);
  if (!type) return;

  if (!strcmp(type, MSG_FF)) {
    char *eff = mg_json_get_str(s, J_EFFECT);
    double intensity = 1.0, dur = 200.0;
    mg_json_get_num(s, J_INTENSITY, &intensity);
    mg_json_get_num(s, J_DURATION, &dur);
    int axis = -1;
    char *axs = mg_json_get_str(s, J_AXIS);
    if (axs) {
      if (!strcmp(axs, "x")) axis = 1;      /* Y axis */
      else if (!strcmp(axs, "y")) axis = 0; /* X axis */
      else if (!strcmp(axs, "z")) axis = 2;
      free(axs);
    }
    ffb_play(eff ? eff : FF_RUMBLE, (float) intensity, (uint32_t) dur, axis);
    free(eff);
  } else if (!strcmp(type, MSG_PING)) {
    send_json(c, "{\"t\":\"pong\"}");
  } else if (!strcmp(type, MSG_CFGGET)) {
    AppConfig cfg; state_config_snapshot(&cfg);
    send_cfg(c, &cfg);
  } else if (!strcmp(type, MSG_CFGSET)) {
    char *key = mg_json_get_str(s, J_CFG_KEY);
    if (key) {
      AppConfig cfg; state_config_snapshot(&cfg);
      double num = 0;
      int has_num = mg_json_get_num(s, J_CFG_VALUE, &num);
      char *strv = has_num ? NULL : mg_json_get_str(s, J_CFG_VALUE);
      apply_cfg_kv(&cfg, key, num, strv);
      state_config_set(&cfg);
      if (strv) free(strv);
      free(key);
    }
  }
  free(type);
}

static void ev_handler(struct mg_connection *c, int ev, void *ev_data) {
  if (ev == MG_EV_HTTP_MSG) {
    struct mg_http_message *hm = (struct mg_http_message *) ev_data;
    if (mg_match(hm->uri, mg_str("/ws"), NULL)) {
      mg_ws_upgrade(c, hm, NULL);
    } else {
      struct mg_http_serve_opts opts;
      memset(&opts, 0, sizeof(opts));
      opts.root_dir = "./game";
      mg_http_serve_dir(c, hm, &opts);
    }
  } else if (ev == MG_EV_WS_OPEN) {
    JoyCaps cap; state_caps_snapshot(&cap);
    int connected = 0;
    JoyRaw raw; state_raw_snapshot(&raw, &connected);
    (void) raw;
    send_caps(c, &cap, connected);
    AppConfig cfg; state_config_snapshot(&cfg);
    send_cfg(c, &cfg);
  } else if (ev == MG_EV_WS_MSG) {
    handle_ws_msg(c, (struct mg_ws_message *) ev_data);
  }
}

int ws_server_listen(struct mg_mgr *mgr, int port) {
  char url[64];
  snprintf(url, sizeof(url), "http://0.0.0.0:%d", port);
  if (mg_http_listen(mgr, url, ev_handler, NULL) == NULL) {
    fprintf(stderr, "[ws] failed to listen on %s\n", url);
    return 1;
  }
  printf("[ws] listening on ws://localhost:%d/ws (game: http://localhost:%d/)\n",
         port, port);
  g_last_cfg_epoch = state_config_epoch();
  return 0;
}

void ws_server_poll(struct mg_mgr *mgr, uint64_t now_ms) {
  (void) now_ms;
  static uint64_t last_state = 0;
  int send_states = (now_ms - last_state) >= STATE_INTERVAL_MS;

  uint64_t epoch = state_config_epoch();
  int cfg_changed = (epoch != g_last_cfg_epoch);

  JoyState js; state_snapshot(&js);
  AppConfig cfg; state_config_snapshot(&cfg);

  for (struct mg_connection *c = mgr->conns; c != NULL; c = c->next) {
    if (!c->is_websocket || c->is_listening) continue;
    if (send_states) send_state(c, &js);
    if (cfg_changed) send_cfg(c, &cfg);
  }
  if (send_states) last_state = now_ms;
  if (cfg_changed) g_last_cfg_epoch = epoch;
}
