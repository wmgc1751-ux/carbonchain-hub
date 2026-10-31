#pragma once
#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>
typedef unsigned int socklen_t;
struct sockaddr { short sa_family; char sa_data[14]; };
struct sockaddr_in { short sin_family; unsigned short sin_port; unsigned int sin_addr; char sin_zero[8]; };
#define AF_INET 2
#define SOCK_STREAM 1
#define SOL_SOCKET 0xFFFF
#define SO_RCVTIMEO 20
#define SO_SNDTIMEO 21
#define MSG_PEEK 2
#define MSG_DONTWAIT 0x80
int socket(int domain, int type, int protocol);
int connect(int s, const struct sockaddr *addr, socklen_t len);
ssize_t send(int s, const void *buf, size_t len, int flags);
ssize_t recv(int s, void *buf, size_t len, int flags);
int close(int fd);
int setsockopt(int s, int level, int opt, const void *val, socklen_t len);
unsigned short htons(unsigned short v);
int inet_pton(int af, const char *src, void *dst);
