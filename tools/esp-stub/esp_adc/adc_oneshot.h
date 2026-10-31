#pragma once
#include "esp_err.h"
#include <stdint.h>
typedef struct adc_oneshot_unit_ctx *adc_oneshot_unit_handle_t;
typedef enum { ADC_UNIT_1 = 1, ADC_UNIT_2 = 2 } adc_unit_t;
typedef enum { ADC_CHANNEL_0 = 0, ADC_CHANNEL_1, ADC_CHANNEL_2, ADC_CHANNEL_3, ADC_CHANNEL_4 } adc_channel_t;
typedef enum { ADC_ATTEN_DB_0 = 0, ADC_ATTEN_DB_2_5, ADC_ATTEN_DB_6, ADC_ATTEN_DB_11, ADC_ATTEN_DB_12 = ADC_ATTEN_DB_11 } adc_atten_t;
typedef enum { ADC_BITWIDTH_DEFAULT = 0 } adc_bitwidth_t;
typedef enum { ADC_ULP_MODE_DISABLE = 0 } adc_ulp_mode_t;
typedef struct { adc_unit_t unit_id; adc_ulp_mode_t ulp_mode; } adc_oneshot_unit_init_cfg_t;
typedef struct { adc_atten_t atten; adc_bitwidth_t bitwidth; } adc_oneshot_chan_cfg_t;
esp_err_t adc_oneshot_new_unit(const adc_oneshot_unit_init_cfg_t *cfg, adc_oneshot_unit_handle_t *out);
esp_err_t adc_oneshot_config_channel(adc_oneshot_unit_handle_t h, adc_channel_t ch, const adc_oneshot_chan_cfg_t *cfg);
esp_err_t adc_oneshot_read(adc_oneshot_unit_handle_t h, adc_channel_t ch, int *out);
