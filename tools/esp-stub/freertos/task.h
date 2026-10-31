#pragma once
#include "freertos/FreeRTOS.h"

void vTaskDelay(TickType_t ticks);

/* 任务句柄与栈水位（真 IDF v5.x：freertos/task.h）
 * ⚠ uxTaskGetStackHighWaterMark 传 NULL 表示"当前任务"，返回值单位是 StackType_t。
 *   xTaskGetCurrentTaskHandle() 返回 TaskHandle_t（指针）——桩头若写成整数，
 *   `!= NULL` 就会报"指针与整数比较"，那是桩头的错、不是固件的错。 */
TaskHandle_t xTaskGetCurrentTaskHandle(void);
UBaseType_t  uxTaskGetStackHighWaterMark(TaskHandle_t handle);
