#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯净阅读 —— 本地静态服务器（禁止缓存）

为什么不用 `python -m http.server`：
它不给响应加任何 Cache-Control，Safari 会按启发式规则自作主张地缓存。
结果就是手机上一直拿到旧版本的 js/css —— 改了代码却"刷新也没用"。
（注意：HTTP 访问下 Service Worker 不生效，所以缓存完全由浏览器 HTTP 缓存决定。）

这里给每个响应都加上 no-store，保证手机每次打开都是最新的代码。
"""

import http.server
import socketserver
import socket
import sys
import os


PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # 关键：禁止浏览器缓存
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # 防止某些浏览器把 .js 当别的类型处理
        super().end_headers()

    def guess_type(self, path):
        base, ext = os.path.splitext(str(path))
        ext = ext.lower()
        if ext == '.js' or ext == '.mjs':
            return 'text/javascript'
        if ext == '.json' or ext == '.webmanifest':
            return 'application/manifest+json'
        if ext == '.css':
            return 'text/css'
        if ext == '.svg':
            return 'image/svg+xml'
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # 只打印状态码和路径，别刷屏
        try:
            sys.stderr.write('  %s\n' % (fmt % args))
        except Exception:
            pass


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ip():
    """尽量猜出局域网 IP（不会真的发包）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()


def main():
    ip = lan_ip()
    print('=' * 42)
    print('  纯净阅读 - 本地服务器（已禁止缓存）')
    print('=' * 42)
    print()
    print('  电脑访问:  http://localhost:%d' % PORT)
    if ip:
        print('  手机访问:  http://%s:%d' % (ip, PORT))
    else:
        print('  手机访问:  请用 ipconfig 查看本机 IPv4 地址')
    print()
    print('  按 Ctrl+C 停止服务器')
    print('=' * 42)
    print(flush=True)

    try:
        with ReusableTCPServer(('0.0.0.0', PORT), NoCacheHandler) as httpd:
            httpd.serve_forever()
    except OSError as e:
        print()
        print('  [错误] 无法在端口 %d 上启动: %s' % (PORT, e))
        print('  可能是端口被占用，或防火墙拦截。')
        print()
        return 1
    except KeyboardInterrupt:
        print()
        print('  [已停止]')
    return 0


if __name__ == '__main__':
    sys.exit(main())