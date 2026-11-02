// tar.js: a tiny .tar.gz writer (ustar, regular files only) for run
// downloads. No dependencies.

import { gzipSync } from 'node:zlib';

function header(name, size, mtime) {
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) throw new Error(`tar: name too long: ${name}`);
  const b = Buffer.alloc(512, 0);
  nameBytes.copy(b, 0);
  b.write('0000600\0', 100, 'ascii');                                // mode
  b.write('0000000\0', 108, 'ascii');                                // uid
  b.write('0000000\0', 116, 'ascii');                                // gid
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');  // size
  b.write(`${Math.floor(mtime / 1000).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
  b.write('        ', 148, 'ascii');                                 // checksum placeholder
  b.write('0', 156, 'ascii');                                        // regular file
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of b) sum += byte;
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return b;
}

// tarGz packs [{ name, data (Buffer|string), mtime? }] into a gzipped tar.
export function tarGz(files) {
  const parts = [];
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    parts.push(header(file.name, data.length, file.mtime ?? Date.now()), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0)); // end of archive
  return gzipSync(Buffer.concat(parts));
}
