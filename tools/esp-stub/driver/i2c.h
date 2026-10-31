#pragma once
#include "esp_err.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
typedef int i2c_port_t;
typedef enum { I2C_MODE_SLAVE = 0, I2C_MODE_MASTER } i2c_mode_t;
#define I2C_NUM_0 ((i2c_port_t)0)
#define I2C_NUM_1 ((i2c_port_t)1)

/* 命令链接（真 IDF：i2c_cmd_handle_t 是不透明句柄，各 i2c_master_* 均返回 esp_err_t） */
typedef void *i2c_cmd_handle_t;
#define I2C_MASTER_WRITE 0   /* 方向位：主机写 */
#define I2C_MASTER_READ  1   /* 方向位：主机读 */
#define I2C_MASTER_ACK   ((bool)0)
#define I2C_MASTER_NACK  ((bool)1)
#define I2C_MASTER_LAST_NACK ((bool)1)

i2c_cmd_handle_t i2c_cmd_link_create(void);
void             i2c_cmd_link_delete(i2c_cmd_handle_t cmd);
esp_err_t i2c_master_start(i2c_cmd_handle_t cmd);
esp_err_t i2c_master_stop(i2c_cmd_handle_t cmd);
esp_err_t i2c_master_write_byte(i2c_cmd_handle_t cmd, uint8_t data, bool ack_en);
esp_err_t i2c_master_write(i2c_cmd_handle_t cmd, const uint8_t *data, size_t len, bool ack_en);
esp_err_t i2c_master_read_byte(i2c_cmd_handle_t cmd, uint8_t *data, int ack);
esp_err_t i2c_master_read(i2c_cmd_handle_t cmd, uint8_t *data, size_t len, int ack);
esp_err_t i2c_master_cmd_begin(i2c_port_t port, i2c_cmd_handle_t cmd, TickType_t ticks);
typedef struct {
    i2c_mode_t mode;
    int sda_io_num;
    int scl_io_num;
    gpio_pullup_t sda_pullup_en;
    gpio_pullup_t scl_pullup_en;
    union { uint32_t clk_speed; } master;
} i2c_config_t;
esp_err_t i2c_param_config(i2c_port_t port, const i2c_config_t *cfg);
esp_err_t i2c_driver_install(i2c_port_t port, i2c_mode_t mode, size_t slv_rx, size_t slv_tx, int flags);
esp_err_t i2c_master_write_read_device(i2c_port_t port, uint8_t addr,
    const uint8_t *wr, size_t wrsize, uint8_t *rd, size_t rdsize, TickType_t ticks);
esp_err_t i2c_master_write_to_device(i2c_port_t port, uint8_t addr,
    const uint8_t *wr, size_t size, TickType_t ticks);
