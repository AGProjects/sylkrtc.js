'use strict';

// Split large outgoing messages into 4KB plaintext pieces, each encrypted
// independently and prefixed with an invisible marker for reassembly.
// Marker format matches sylk-mobile for cross-client compatibility.

const MAX_TEXT_MESSAGE_BYTES = 4096;
const CHUNK_MARKER_BUDGET_BYTES = 160;
const MAX_CHUNK_TOTAL = 10000;
const REASSEMBLY_TIMEOUT_MS = 30000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8ByteLength(str) {
    return encoder.encode(str).length;
}

// Back off a byte offset to the nearest UTF-8 character boundary.
function charBoundary(bytes, offset) {
    while (offset > 0 && (bytes[offset] & 0xc0) === 0x80) offset--;
    return offset;
}

// Split into pieces <= maxBytes, preferring word boundaries.
function splitTextByBytes(str, maxBytes) {
    const bytes = encoder.encode(str);
    const pieces = [];
    let start = 0;
    while (start < bytes.length) {
        let end = charBoundary(bytes, Math.min(start + maxBytes, bytes.length));
        if (end < bytes.length) {
            const slice = decoder.decode(bytes.subarray(start, end));
            const wsIdx = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'),
                slice.lastIndexOf('\t'), slice.lastIndexOf('\r'));
            if (wsIdx > 0) end = start + encoder.encode(slice.slice(0, wsIdx + 1)).length;
        }
        pieces.push(decoder.decode(bytes.subarray(start, end)));
        start = end;
    }
    return pieces;
}

// Split HTML at top-level element boundaries, never inside a tag.
// hardMax guards against a single oversized element exceeding the wire limit.
function splitHtmlByBytes(str, maxBytes, hardMax) {
    hardMax = hardMax || Math.floor((49 * 1024) / 1.4);
    const chars = Array.from(str);
    const pieces = [];
    let start = 0, i = 0, bytes = 0, depth = 0, inTag = false, tagStart = -1;
    let blockSafe = -1, tagSafe = -1, textSafe = -1;
    const flush = (end) => {
        pieces.push(chars.slice(start, end).join(''));
        start = end; i = end; bytes = 0; depth = 0; inTag = false;
        blockSafe = -1; tagSafe = -1; textSafe = -1;
    };
    while (i < chars.length) {
        const ch = chars[i];
        bytes += utf8ByteLength(ch);
        if (ch === '<') { inTag = true; tagStart = i; }
        else if (ch === '>') {
            inTag = false;
            tagSafe = i + 1;
            const tag = chars.slice(tagStart, i + 1).join('');
            if (tag.startsWith('<!--') || /\/\s*>$/.test(tag)
                || /^<\s*(br|hr|img|input|meta|link|source|area|base|col|embed|param|track|wbr)\b/i.test(tag)) {
                // void / self-closing / comment: no depth change
            } else if (/^<\s*\//.test(tag)) {
                if (depth > 0) depth -= 1;
            } else {
                depth += 1;
            }
            if (depth === 0) blockSafe = i + 1;
            if (depth === 0 && bytes >= maxBytes) { flush(i + 1); continue; }
        } else if (!inTag && ' \n\t\r'.includes(ch)) {
            textSafe = i + 1;
            if (depth === 0) blockSafe = i + 1;
        }
        if (bytes >= hardMax) {
            const cut = blockSafe > start ? blockSafe
                : (tagSafe > start ? tagSafe
                : (textSafe > start ? textSafe : -1));
            if (cut > start) { flush(cut); continue; }
        }
        i++;
    }
    if (start < chars.length) pieces.push(chars.slice(start).join(''));
    return pieces;
}

// Marker: zero-width characters, wire format shared with sylk-mobile.
// frame open = U+2060 U+2061, frame close = U+2061 U+2060
// bit 0 = U+200B, bit 1 = U+200C, field separator = U+200D
const ZW = { FOPEN: '\u2060\u2061', FCLOSE: '\u2061\u2060', ZERO: '\u200B', ONE: '\u200C', SEP: '\u200D' };

function intToZWBits(n) {
    return n.toString(2).split('').map(b => (b === '1' ? ZW.ONE : ZW.ZERO)).join('');
}

function encodeChunkMarker(gid, idx, total) {
    return ZW.FOPEN + intToZWBits(gid) + ZW.SEP + intToZWBits(idx) + ZW.SEP + intToZWBits(total) + ZW.FCLOSE;
}

// Returns { gid, idx, total, body } or null if text doesn't start with a valid marker.
function parseChunkMarker(text) {
    if (typeof text !== 'string' || !text.startsWith(ZW.FOPEN)) return null;
    const closeAt = text.indexOf(ZW.FCLOSE, ZW.FOPEN.length);
    if (closeAt === -1) return null;
    const fields = text.slice(ZW.FOPEN.length, closeAt).split(ZW.SEP);
    if (fields.length !== 3) return null;
    const dec = (zw) => {
        if (zw.length === 0) return NaN;
        let bits = '';
        for (const c of zw) {
            if (c === ZW.ONE) bits += '1';
            else if (c === ZW.ZERO) bits += '0';
            else return NaN;
        }
        return parseInt(bits, 2);
    };
    const gid = dec(fields[0]), idx = dec(fields[1]), total = dec(fields[2]);
    if ([gid, idx, total].some(Number.isNaN)) return null;
    if (total < 1 || total > MAX_CHUNK_TOTAL || idx < 0 || idx >= total) return null;
    return { gid, idx, total, body: text.slice(closeAt + ZW.FCLOSE.length) };
}

// Returns marker-prefixed plaintext pieces ready to encrypt+send, or null if no split needed.
function chunkPlaintextForSend(content, contentType) {
    if ((contentType !== 'text/plain' && contentType !== 'text/html') || typeof content !== 'string') return null;
    if (utf8ByteLength(content) <= MAX_TEXT_MESSAGE_BYTES) return null;
    const parts = contentType === 'text/html'
        ? splitHtmlByBytes(content, MAX_TEXT_MESSAGE_BYTES)
        : splitTextByBytes(content, MAX_TEXT_MESSAGE_BYTES - CHUNK_MARKER_BUDGET_BYTES);
    const gid = Math.floor(Math.random() * 0x1000000);
    return parts.map((p, i) => encodeChunkMarker(gid, i, parts.length) + p);
}

// Buffers incoming pieces keyed by sender+gid. Returns null when content
// isn't a chunk piece, { done: false } while waiting, { done: true, body, chunkIds }
// when all pieces have arrived. Drops incomplete groups after REASSEMBLY_TIMEOUT_MS.
class ChunkReassembler {
    constructor() {
        this._groups = new Map();
    }

    add(sender, content, messageId) {
        const parsed = parseChunkMarker(content);
        if (!parsed) return null;
        const { gid, idx, total, body } = parsed;
        const key = `${sender}:${gid}`;
        let group = this._groups.get(key);
        if (!group) {
            group = { total, parts: new Array(total), ids: new Array(total), have: 0, timer: null };
            group.timer = setTimeout(() => this._groups.delete(key), REASSEMBLY_TIMEOUT_MS);
            this._groups.set(key, group);
        }
        if (group.parts[idx] === undefined) {
            group.parts[idx] = body;
            group.ids[idx] = messageId;
            group.have += 1;
        }
        if (group.have < group.total) return { done: false };
        clearTimeout(group.timer);
        this._groups.delete(key);
        return { done: true, body: group.parts.join(''), chunkIds: group.ids };
    }
}

export { chunkPlaintextForSend, ChunkReassembler };

