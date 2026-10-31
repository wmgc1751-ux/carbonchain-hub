#pragma once
#include "esp_err.h"
#include <stddef.h>
#include <stdbool.h>
typedef struct {
    const char *base_path;
    const char *partition_label;
    size_t max_files;
    bool format_if_mount_failed;
} esp_vfs_spiffs_conf_t;
esp_err_t esp_vfs_spiffs_register(const esp_vfs_spiffs_conf_t *conf);
esp_err_t esp_spiffs_info(const char *partition_label, size_t *total, size_t *used);

/* ⚠ fsync 是 POSIX（<unistd.h>），真机 newlib 有声明；MinGW 桌面侧也有，
 *   但 `-std=gnu11` 下若没显式 include unistd.h 就会"隐式声明"报错。
 *   ⚠⚠ 这里**不能**为了过检而把 fsync 声明成空宏 —— 本工程正是靠
 *   "写缓存后必须 fsync 才能掉电不丢"这条机制修过一个静默丢数据的缺陷
 *   （见 cc_hw_esp32.c#store_sync）：把它抹掉等于把红灯涂成绿灯。
 *   桩头只补**声明**（签名与 POSIX 一致：int fsync(int)），语义与真机完全同构。 */
int fsync(int fd);
