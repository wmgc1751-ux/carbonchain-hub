#pragma once
#include "esp_err.h"
#include <stdint.h>
#include <stdbool.h>
typedef struct esp_netif_obj *esp_netif_t;

/* ---- IP 信息（真 IDF v5.x：esp_netif_types.h）----
 * ⚠ ip_event_got_ip_t 在真 IDF 里**不是**只有 ip_info 一个字段，
 *   但本工程只读 `g->ip_info.ip`，桩头保留该字段即可满足语法/类型检查。 */
/* ⚠ 真 IDF 里 esp_ip4_addr_t 是含 `uint32_t addr` 的联合体（可 .addr / u32 / 4×u8）。
 *   桩头必须保留这一层：固件写的是 `g->ip_info.ip.addr`，
 *   若把 ip 拍平成 uint32_t，PC 侧检查就**验不出真机上的字段结构**。 */
typedef union {
    uint32_t addr;
    uint8_t  u8[4];
    uint32_t u32;
} esp_ip4_addr_t;

typedef struct {
    esp_ip4_addr_t ip;
    esp_ip4_addr_t netmask;
    esp_ip4_addr_t gw;
} esp_netif_ip_info_t;

typedef struct {
    esp_netif_ip_info_t ip_info;
    bool ip_changed;
} ip_event_got_ip_t;

esp_err_t esp_netif_init(void);
esp_netif_t *esp_netif_create_default_wifi_sta(void);
esp_netif_t *esp_netif_get_handle_from_ifkey(const char *if_key);
esp_err_t esp_netif_get_ip_info(esp_netif_t *netif, esp_netif_ip_info_t *ip_info);
