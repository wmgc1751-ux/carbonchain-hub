/* 桩头：esp_heap_caps.h（仅用于 PC 侧 -fsyntax-only 类型检查，不参与真机编译）
 *
 * ⚠ 为什么补这个文件：
 *   `cc_hw_esp32.c` 在做「离线缓存压紧」时用 PSRAM 一次性缓冲（memory 第 24 条），
 *   因此 include 了真 IDF 的 esp_heap_caps.h。而 tools/esp-stub/ 是 PC 侧
 *   `check-hw-syntax.mjs` 用的最小伪造头集，一直缺这一个 ⇒ 该套件从那天起
 *   就以 "No such file or directory" 失败（表现为 verify:all 里 hw 套件红）。
 *   症状具有欺骗性：报错停在**头文件**而不是代码，容易被误判成环境问题绕过。
 *
 * ⚠ 桩头的纪律：签名必须与真 IDF v5.x 一致（esp_heap_caps_malloc 返回 void*、
 *   size_t size、uint32_t caps；MALLOC_CAP_* 为位掩码常量），否则这个检查就
 *   只能验"能不能编过"，验不出"参数和真实 API 对不对" —— 那正是它存在的意义。
 */
#ifndef ESP_STUB_ESP_HEAP_CAPS_H
#define ESP_STUB_ESP_HEAP_CAPS_H

#include <stddef.h>
#include <stdint.h>

/* 能力位掩码（与 ESP-IDF v5.x esp_heap_caps.h 同值） */
#define MALLOC_CAP_EXEC             0x00000001
#define MALLOC_CAP_32BIT            0x00000002
#define MALLOC_CAP_8BIT             0x00000004
#define MALLOC_CAP_DMA              0x00000008
#define MALLOC_CAP_PID2             0x00000010
#define MALLOC_CAP_PID3             0x00000020
#define MALLOC_CAP_PID4             0x00000040
#define MALLOC_CAP_PID5             0x00000080
#define MALLOC_CAP_PID6             0x00000100
#define MALLOC_CAP_PID7             0x00000200
#define MALLOC_CAP_SPIRAM           0x00000400
#define MALLOC_CAP_INTERNAL         0x00000800
#define MALLOC_CAP_DEFAULT          0x00001000
#define MALLOC_CAP_IRAM_8BIT        0x00002000
#define MALLOC_CAP_RETENTION        0x00004000
#define MALLOC_CAP_RTCRAM           0x00008000
#define MALLOC_CAP_TCM              0x00010000
#define MALLOC_CAP_DMA_DESC_AHB     0x00020000
#define MALLOC_CAP_NO_EXEC          0x00040000

void *heap_caps_malloc(size_t size, uint32_t caps);
void *heap_caps_calloc(size_t n, size_t size, uint32_t caps);
void *heap_caps_realloc(void *ptr, size_t size, uint32_t caps);
void  heap_caps_free(void *ptr);
size_t heap_caps_get_free_size(uint32_t caps);
size_t heap_caps_get_largest_free_block(uint32_t caps);

#endif /* ESP_STUB_ESP_HEAP_CAPS_H */
