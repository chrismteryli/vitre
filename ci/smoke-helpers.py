#!/usr/bin/env python3
"""Small helpers for ci/smoke-test.sh (plain Python 3, no extra packages). Change nothing.

    smoke-helpers.py scan-log LOG EXTENSIONS_TXT
        Lists every "JS ERROR" and CRITICAL record in a gnome-shell log (the message and its stack lines) and says whose it is. Exit status 1
        when a record comes from a Vitre extension (a folder named vitre-*@vitre-desktop). Records from the bundled third-party extensions
        (the other ids in EXTENSIONS_TXT) and from GNOME Shell or the environment (no system bus in a container) are listed but do not fail.
    smoke-helpers.py png FILE
        Reads a PNG written by the shell and prints its size and how many distinct colours it has. Exit status 1 when the file is not a
        readable PNG; the output says "verdict=flat" when the picture is a single colour (the shell drew nothing).
"""
import re
import struct
import sys
import zlib

# A record starts at a "JS ERROR" line (GJS: an uncaught exception) or at a CRITICAL line (GNOME Shell logs a failing extension's
# enable() as "GNOME Shell-CRITICAL **: ...: Extension <uuid>: Error: ..."). Its stack trace follows, possibly after a blank line.
HEADER = re.compile(r'JS ERROR|-CRITICAL \*\*')
FRAME = re.compile(r'^\s*\S*@\S+:\d+:\d+\s*$|^\s+\S|^Stack trace')


def scan_log(log_path, ext_path):
    third_party = [ln.strip() for ln in open(ext_path, encoding='utf-8') if ln.strip() and not ln.strip().endswith('@vitre-desktop')]
    lines = open(log_path, encoding='utf-8', errors='replace').read().splitlines()
    records = []
    i = 0
    while i < len(lines):
        if HEADER.search(lines[i]):
            rec = [lines[i]]
            i += 1
            while i < len(lines):
                if lines[i].strip() == '':
                    j = i
                    while j < len(lines) and lines[j].strip() == '':
                        j += 1
                    if j < len(lines) and lines[j].startswith('Stack trace') and not HEADER.search(lines[j]):
                        i = j
                        continue
                    break
                if HEADER.search(lines[i]) or not FRAME.match(lines[i]):
                    break
                rec.append(lines[i])
                i += 1
            records.append(rec)
        else:
            i += 1
    vitre, other, shell = [], [], []
    for rec in records:
        text = '\n'.join(rec)
        if re.search(r'vitre-[a-z-]+@vitre-desktop|extensions/vitre-', text):
            vitre.append(rec)
        elif any(u in text for u in third_party):
            other.append(rec)
        else:
            shell.append(rec)
    n_js = sum(1 for r in records if 'JS ERROR' in r[0])
    print(f'gnome-shell log: {len(lines)} lines, {len(records)} error records ({n_js} "JS ERROR", {len(records) - n_js} CRITICAL): '
          f'{len(vitre)} from Vitre extensions, {len(other)} from bundled third-party extensions, {len(shell)} from GNOME Shell or the environment')
    for title, group in (('VITRE', vitre), ('THIRD-PARTY', other), ('ELSEWHERE', shell)):
        for rec in group[:20]:
            print(f'--- error from {title}:')
            for ln in rec[:12]:
                print('    ' + ln[:300])
        if len(group) > 20:
            print(f'--- ... and {len(group) - 20} more from {title}')
    return 1 if vitre else 0


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else (b if pb <= pc else c)


def png_stats(path):
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        print(f'{path}: not a PNG ({len(data)} bytes)')
        return 1
    pos, idat, ihdr = 8, [], None
    while pos + 8 <= len(data):
        length, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat.append(body)
        pos += 12 + length
    if not ihdr or not idat:
        print(f'{path}: PNG without image data')
        return 1
    width, height, depth, ctype, _comp, _filt, interlace = ihdr
    if depth != 8 or ctype not in (2, 6) or interlace:
        print(f'{path}: PNG {width}x{height} (colour type {ctype}, depth {depth}); not analysed')
        return 0
    bpp = 3 if ctype == 2 else 4
    raw = zlib.decompress(b''.join(idat))
    stride = width * bpp
    prev = bytearray(stride)
    colours = set()
    for y in range(height):
        base = y * (stride + 1)
        ftype = raw[base]
        row = bytearray(raw[base + 1:base + 1 + stride])
        if ftype == 1:
            for x in range(bpp, stride):
                row[x] = (row[x] + row[x - bpp]) & 255
        elif ftype == 2:
            for x in range(stride):
                row[x] = (row[x] + prev[x]) & 255
        elif ftype == 3:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + ((left + prev[x]) >> 1)) & 255
        elif ftype == 4:
            for x in range(stride):
                left = row[x - bpp] if x >= bpp else 0
                upleft = prev[x - bpp] if x >= bpp else 0
                row[x] = (row[x] + paeth(left, prev[x], upleft)) & 255
        prev = row
        if y % 4 == 0 and len(colours) < 5000:
            for x in range(0, stride, bpp * 3):
                colours.add(bytes(row[x:x + 3]))
    verdict = 'verdict=flat (a single colour: the shell drew nothing)' if len(colours) <= 1 else 'verdict=varied'
    print(f'{path}: PNG {width}x{height}, {len(data)} bytes, {len(colours)}{"+" if len(colours) >= 5000 else ""} distinct colours sampled, {verdict}')
    return 0


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == 'scan-log':
        sys.exit(scan_log(sys.argv[2], sys.argv[3]))
    if len(sys.argv) == 3 and sys.argv[1] == 'png':
        sys.exit(png_stats(sys.argv[2]))
    print(__doc__)
    sys.exit(2)
