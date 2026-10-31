#pragma once
#include "esp_err.h"
#include "freertos/FreeRTOS.h"
#include <stdint.h>
#include <stddef.h>
typedef int uart_port_t;
#define UART_NUM_1 ((uart_port_t)1)
#define UART_PIN_NO_CHANGE (-1)
typedef enum { UART_DATA_5_BITS = 0, UART_DATA_6_BITS, UART_DATA_7_BITS, UART_DATA_8_BITS } uart_word_length_t;
typedef enum { UART_PARITY_DISABLE = 0, UART_PARITY_EVEN, UART_PARITY_ODD } uart_parity_t;
typedef enum { UART_STOP_BITS_1 = 1, UART_STOP_BITS_2 = 2, UART_STOP_BITS_1_5 = 3 } uart_stop_bits_t;
typedef enum { UART_HW_FLOWCTRL_DISABLE = 0 } uart_hw_flowcontrol_t;
typedef enum { UART_SCLK_DEFAULT = 3 } uart_sclk_t;
typedef struct {
    int baud_rate;
    uart_word_length_t data_bits;
    uart_parity_t parity;
    uart_stop_bits_t stop_bits;
    uart_hw_flowcontrol_t flow_ctrl;
    uint8_t rx_flow_ctrl_thresh;
    uart_sclk_t source_clk;
} uart_config_t;
esp_err_t uart_param_config(uart_port_t port, const uart_config_t *cfg);
esp_err_t uart_set_pin(uart_port_t port, int tx, int rx, int rts, int cts);
esp_err_t uart_driver_install(uart_port_t port, int rx_buf, int tx_buf, int evt_size, void *queue, int flags);
int uart_write_bytes(uart_port_t port, const void *buf, size_t len);
int uart_read_bytes(uart_port_t port, void *buf, uint32_t len, TickType_t ticks);
esp_err_t uart_flush_input(uart_port_t port);
