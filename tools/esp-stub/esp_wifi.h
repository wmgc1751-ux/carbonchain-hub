#pragma once
#include "esp_err.h"
#include "esp_event.h"
#include <stdint.h>
#include <string.h>
typedef struct { int dummy; } wifi_init_config_t;
#define WIFI_INIT_CONFIG_DEFAULT() { .dummy = 0 }
typedef enum { WIFI_MODE_NULL = 0, WIFI_MODE_STA, WIFI_MODE_AP } wifi_mode_t;
typedef enum { WIFI_IF_STA = 0, WIFI_IF_AP } wifi_interface_t;
typedef enum { WIFI_EVENT_STA_START = 0, WIFI_EVENT_STA_DISCONNECTED = 3 } wifi_event_id_t;
typedef struct { uint8_t ssid[32]; uint8_t password[64]; } wifi_sta_config_t;
typedef struct { union { wifi_sta_config_t sta; }; } wifi_config_t;

/* ---- 扫描（真 IDF v5.x：esp_wifi_types.h）---- */
typedef struct {
    uint8_t *ssid;
    uint8_t *bssid;
    uint8_t  channel;
    bool     show_hidden;
    /* 真结构还有 scan_type / scan_time，桩头只留本工程用得到的字段 */
} wifi_scan_config_t;

typedef enum {
    WIFI_AUTH_OPEN = 0,
    WIFI_AUTH_WEP,
    WIFI_AUTH_WPA_PSK,
    WIFI_AUTH_WPA2_PSK,
    WIFI_AUTH_WPA_WPA2_PSK,
    WIFI_AUTH_WPA2_ENTERPRISE,
    WIFI_AUTH_WPA3_PSK,
    WIFI_AUTH_WPA2_WPA3_PSK,
    WIFI_AUTH_WAPI_PSK,
    WIFI_AUTH_MAX
} wifi_auth_mode_t;

typedef struct {
    uint8_t bssid[6];
    uint8_t ssid[33];
    uint8_t primary;
    uint8_t second;
    int8_t  rssi;
    wifi_auth_mode_t authmode;
} wifi_ap_record_t;

esp_err_t esp_wifi_scan_start(const wifi_scan_config_t *config, bool block);
esp_err_t esp_wifi_scan_stop(void);
esp_err_t esp_wifi_scan_get_ap_num(uint16_t *number);
esp_err_t esp_wifi_scan_get_ap_records(uint16_t *number, wifi_ap_record_t *ap_records);

/* ---- 事件负载（真 IDF：esp_event 的事件结构体）---- */
typedef struct { uint8_t ssid[33]; uint8_t ssid_len; uint8_t bssid[6];
                 uint8_t reason; uint8_t rssi; } wifi_event_sta_disconnected_t;

esp_err_t esp_wifi_init(const wifi_init_config_t *cfg);
esp_err_t esp_wifi_set_mode(wifi_mode_t mode);
esp_err_t esp_wifi_set_config(wifi_interface_t ifs, wifi_config_t *cfg);
esp_err_t esp_wifi_start(void);
esp_err_t esp_wifi_connect(void);
