/* ESP-IDF v5.x 桩头（仅 API 签名，供 PC 语法检查；实现不存在） */
#pragma once
#include <stdint.h>
#include <stddef.h>
typedef uint32_t TickType_t;
typedef uint32_t BaseType_t;
typedef uint64_t UBaseType_t;
/* ⚠ StackType_t 在真 IDF 上是 uint8_t（栈按字节计量）。
 *   uxTaskGetStackHighWaterMark 返回的是"剩余栈深（以 StackType_t 为单位）"，
 *   所以 `hw * sizeof(StackType_t)` 才是字节数 —— 桩头这里必须与真 IDF 同义，
 *   否则 PC 侧语法检查会把"栈余量算错"这类真问题放过。 */
typedef uint8_t StackType_t;
typedef void *TaskHandle_t;
#define pdMS_TO_TICKS(ms) ((TickType_t)(ms))
#define pdTRUE  1
#define pdFALSE 0
