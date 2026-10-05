#!/usr/bin/env python3
"""A minimal static file server WITH HTTP Range support.

Python's built-in `python -m http.server` ignores Range headers, so LinkUnzip cannot use it.
This is a stand-in for `caddy file-server` when Caddy is not installed. It is slower than Caddy
(fine for rehearsals and testing, not for a speed demo).

    python tools/range_server.py <folder> [port]        # default port 8080
    linkunzip inspect http://localhost:8080/demo.zip

Options (env vars, to rehearse failure handling):
    DROP_EVERY=N   cut every Nth ranged response in half (simulates a flaky connection)
    MBPS=N         limit each connection to about N MB/s (makes progress easy to watch and record)
"""

import http.server
import os
import re
import socketserver
import sys
import threading
import time

CHUNK = 1 << 20
DROP_EVERY = int(os.environ.get("DROP_EVERY", "0"))
MBPS = float(os.environ.get("MBPS", "0"))
_counter = 0
_counter_lock = threading.Lock()


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the console readable while recording
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        global _counter
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            return super().do_GET()

        size = os.path.getsize(path)
        start, end, status = 0, size - 1, 200
        header = self.headers.get("Range")
        if header:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
            if not m or (m.group(1) == "" and m.group(2) == ""):
                self.send_error(400, "bad Range header")
                return
            if m.group(1) == "":  # suffix range: last N bytes
                start, end = max(0, size - int(m.group(2))), size - 1
            else:
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206

        length = end - start + 1
        cut_at = None
        if status == 206 and DROP_EVERY:
            with _counter_lock:
                _counter += 1
                if _counter % DROP_EVERY == 0 and length > 2 * CHUNK:
                    cut_at = length // 2

        self.send_response(status)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("ETag", f'"{size:x}-{int(os.path.getmtime(path)):x}"')
        self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(path)))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length if cut_at is None else cut_at
                while left > 0:
                    data = f.read(min(CHUNK, left))
                    if not data:
                        break
                    self.wfile.write(data)
                    left -= len(data)
                    if MBPS:
                        time.sleep(len(data) / (MBPS * 1_000_000))
            if cut_at is not None:
                self.close_connection = True
                self.connection.close()  # abort mid-body, like a network drop
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    folder = sys.argv[1] if len(sys.argv) > 1 else "."
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 8080
    os.chdir(folder)
    print(f"Serving {os.getcwd()} on http://localhost:{port}/  (Range requests supported)", flush=True)
    try:
        Server(("", port), RangeHandler).serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
