#pragma once
#include "esp_err.h"
#include <stddef.h>
#include <stdint.h>
typedef uint32_t nvs_handle_t;
typedef enum { NVS_READONLY = 0, NVS_READWRITE } nvs_open_mode_t;
esp_err_t nvs_open(const char *ns, nvs_open_mode_t mode, nvs_handle_t *out);
esp_err_t nvs_get_blob(nvs_handle_t h, const char *key, void *out, size_t *len);
esp_err_t nvs_set_blob(nvs_handle_t h, const char *key, const void *val, size_t len);
esp_err_t nvs_get_u32(nvs_handle_t h, const char *key, uint32_t *out);
esp_err_t nvs_set_u32(nvs_handle_t h, const char *key, uint32_t val);
/* u8 变体（真 IDF v5.x 有 nvs_get_u8/nvs_set_u8；桩头缺了就会"隐式声明"）
 * ⚠ 用途：NVS 相位标志回读校验（自检与残留状态无关那条机制），不能省。 */
esp_err_t nvs_get_u8(nvs_handle_t h, const char *key, uint8_t *out);
esp_err_t nvs_set_u8(nvs_handle_t h, const char *key, uint8_t val);
esp_err_t nvs_get_i32(nvs_handle_t h, const char *key, int32_t *out);
esp_err_t nvs_set_i32(nvs_handle_t h, const char *key, int32_t val);
esp_err_t nvs_commit(nvs_handle_t h);
void nvs_close(nvs_handle_t h);
