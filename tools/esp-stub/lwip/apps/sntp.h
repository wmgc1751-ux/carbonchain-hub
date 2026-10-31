#pragma once
#define SNTP_OPMODE_POLL 0
void sntp_setoperatingmode(int mode);
void sntp_setservername(int idx, const char *server);
void sntp_init(void);
