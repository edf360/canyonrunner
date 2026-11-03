#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "mongoose.h"

void config_defaults(AppConfig *cfg) {
  memset(cfg, 0, sizeof(*cfg));
  cfg->ws_port      = 8765;
  cfg->poll_hz      = 120;
  cfg->hat_deadzone = 0.20f;

  for (int i = 0; i < FSR_MAX_AXES; i++) {
    cfg->axis[i].cmin     = 0.0f;
    cfg->axis[i].cmax     = 65535.0f;
    cfg->axis[i].deadzone = 0.06f;
    cfg->axis[i].gamma    = 1.0f;
    cfg->axis[i].invert   = 0;
    cfg->axis[i].smooth   = 0.0f;
  }
  for (int i = 0; i < FSR_MAX_BUTTONS; i++)
    cfg->button_map[i] = (unsigned char) i;

  strcpy(cfg->ffb.backend, "auto");
  cfg->ffb.intensity = 1.0f;
  cfg->ffb.curve     = 1.0f;
}

/* helpers --------------------------------------------------------------- */
static void load_num(struct mg_str j, const char *path, float *dst) {
  double v;
  if (mg_json_get_num(j, path, &v)) *dst = (float) v;
}
static void load_int(struct mg_str j, const char *path, int *dst) {
  double v;
  if (mg_json_get_num(j, path, &v)) *dst = (int) v;
}

int config_load(const char *path, AppConfig *cfg) {
  FILE *f = fopen(path, "rb");
  if (!f) return 0;
  fseek(f, 0, SEEK_END);
  long sz = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (sz <= 0) { fclose(f); return 0; }

  char *buf = (char *) malloc((size_t) sz + 1);
  if (!buf) { fclose(f); return 0; }
  size_t rd = fread(buf, 1, (size_t) sz, f);
  fclose(f);
  buf[rd] = '\0';

  struct mg_str j = mg_str_n(buf, (long) rd);

  load_int(j, "$.ws_port", &cfg->ws_port);
  load_int(j, "$.poll_hz", &cfg->poll_hz);
  load_num(j, "$.hat_deadzone", &cfg->hat_deadzone);

  char pathbuf[64];
  for (int i = 0; i < FSR_MAX_AXES; i++) {
    AxisCfg *a = &cfg->axis[i];
    snprintf(pathbuf, sizeof(pathbuf), "$.axis[%d].cmin", i);     load_num(j, pathbuf, &a->cmin);
    snprintf(pathbuf, sizeof(pathbuf), "$.axis[%d].cmax", i);     load_num(j, pathbuf, &a->cmax);
    snprintf(pathbuf, sizeof(pathbuf), "$.axis[%d].deadzone", i); load_num(j, pathbuf, &a->deadzone);
    snprintf(pathbuf, sizeof(pathbuf), "$.axis[%d].gamma", i);    load_num(j, pathbuf, &a->gamma);
    snprintf(pathbuf, sizeof(pathbuf), "$.axis[%d].invert", i);   load_int(j, pathbuf, &a->invert);
    snprintf(pathbuf, sizeof(pathbuf), "$.axis[%d].smooth", i);   load_num(j, pathbuf, &a->smooth);
  }

  double iv;
  if (mg_json_get_num(j, "$.ffb.intensity", &iv)) cfg->ffb.intensity = (float) iv;
  double cv;
  if (mg_json_get_num(j, "$.ffb.curve", &cv)) cfg->ffb.curve = (float) cv;
  char *bk = mg_json_get_str(j, "$.ffb.backend");
  if (bk) {
    strncpy(cfg->ffb.backend, bk, sizeof(cfg->ffb.backend) - 1);
    cfg->ffb.backend[sizeof(cfg->ffb.backend) - 1] = '\0';
    free(bk);
  }

  free(buf);
  return 1;
}

int config_save(const char *path, const AppConfig *cfg) {
  FILE *f = fopen(path, "wb");
  if (!f) return 0;
  fprintf(f, "{\n  \"ws_port\": %d,\n  \"poll_hz\": %d,\n  \"hat_deadzone\": %.4f,\n",
          cfg->ws_port, cfg->poll_hz, cfg->hat_deadzone);
  fprintf(f, "  \"axis\": [\n");
  for (int i = 0; i < FSR_MAX_AXES; i++) {
    const AxisCfg *a = &cfg->axis[i];
    fprintf(f, "    {\"cmin\": %.2f, \"cmax\": %.2f, \"deadzone\": %.4f, "
               "\"gamma\": %.4f, \"invert\": %d, \"smooth\": %.4f}%s\n",
            a->cmin, a->cmax, a->deadzone, a->gamma, a->invert, a->smooth,
            (i == FSR_MAX_AXES - 1) ? "" : ",");
  }
  fprintf(f, "  ],\n");
  fprintf(f, "  \"ffb\": {\"backend\": \"%s\", \"intensity\": %.4f, \"curve\": %.4f}\n",
          cfg->ffb.backend, cfg->ffb.intensity, cfg->ffb.curve);
  fprintf(f, "}\n");
  fclose(f);
  return 1;
}
