/**
 * A minimal zip writer for the demo tenant's Word and PowerPoint files:
 * entries are stored, not compressed, which every zip reader accepts. It
 * exists so the fixtures need no dependency; it is not a general zip tool.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = (CRC_TABLE[(crc ^ (bytes[index] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

export const storedZip = (files: Record<string, string>): Uint8Array => {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, text]) => ({ name: encoder.encode(name), data: encoder.encode(text) }));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 0, true); // stored
    local.setUint16(12, 0x21, true); // 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, entry.name.length, true);
    chunks.push(new Uint8Array(local.buffer), entry.name, entry.data);
    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true);
    record.setUint16(4, 20, true);
    record.setUint16(6, 20, true);
    record.setUint16(14, 0x21, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, entry.data.length, true);
    record.setUint32(24, entry.data.length, true);
    record.setUint16(28, entry.name.length, true);
    record.setUint32(42, offset, true);
    central.push(new Uint8Array(record.buffer), entry.name);
    offset += 30 + entry.name.length + entry.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
