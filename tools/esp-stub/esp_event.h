#pragma once
#include "esp_err.h"
#include <stdint.h>
typedef const char *esp_event_base_t;
#define ESP_EVENT_ANY_ID (-1)
#define WIFI_EVENT   ((esp_event_base_t)"WIFI_EVENT")
#define IP_EVENT     ((esp_event_base_t)"IP_EVENT")
#define IP_EVENT_STA_GOT_IP 0
esp_err_t esp_event_loop_create_default(void);
esp_err_t esp_event_handler_instance_register(esp_event_base_t base, int32_t id,
    void (*handler)(void *, esp_event_base_t, int32_t, void *), void *arg, void **instance);
