'use strict';

const FRAME_HEADER_BYTE = 0x11;
const UNENCRYPTED_PREFIX = { audio: 0, video: 3 };

function buildIV(salt, counter) {
    const iv = new Uint8Array(12);
    iv.set(salt, 0);
    new DataView(iv.buffer).setUint32(8, counter, false);
    return iv;
}

// Single shared key/salt per direction - audio and video reuse the same
// ZRTP-derived key/salt (see docs/encryption/zrtp/Readme.md "Key schedule").
// The frame counter is per-direction, not per-kind, by design: as long as
// it only ever increments (monotonic, never reset per track), reusing it
// across audio+video frames on the same key cannot produce a repeated IV.
// `kind`/`prefix` matter only for picking the correct unencrypted RTP prefix.
let sendKey  = null;
let recvKey  = null;
let sendSalt = null;
let recvSalt = null;
let sendCounter = 0;
let recvAeadOk  = 0;
let recvStrict  = false;

let sendVideoPrefix = null;
let recvVideoPrefix = null;

function makeSenderTransform(kind) {
    return new TransformStream({
        async transform(frame, controller) {
            const prefix = kind === 'audio' ? 0 : sendVideoPrefix;
            if (!sendKey || prefix === null) {
                controller.enqueue(frame);
                return;
            }
            const frameData = new Uint8Array(frame.data);
            const ctrBytes  = new Uint8Array(4);
            new DataView(ctrBytes.buffer).setUint32(0, sendCounter, false);
            const aad = new Uint8Array([FRAME_HEADER_BYTE, ...ctrBytes]);
            try {
                const ciphertext = await crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv: buildIV(sendSalt, sendCounter++), additionalData: aad },
                    sendKey,
                    frameData.slice(prefix)
                );
                const out = new Uint8Array(prefix + 1 + 4 + ciphertext.byteLength);
                out.set(frameData.slice(0, prefix), 0);
                out[prefix] = FRAME_HEADER_BYTE;
                out.set(ctrBytes, prefix + 1);
                out.set(new Uint8Array(ciphertext), prefix + 5);
                frame.data = out.buffer;
                controller.enqueue(frame);
            } catch(err) {
                console.error('[zrtp-worker] encrypt error', err);
            }
        }
    });
}

function makeReceiverTransform(kind) {
    return new TransformStream({
        async transform(frame, controller) {
            const prefix = kind === 'audio' ? 0 : recvVideoPrefix;
            if (!recvKey || prefix === null) {
                controller.enqueue(frame);
                return;
            }
            try {
                const frameData = new Uint8Array(frame.data);
                if (frameData.length < prefix + 5) {
                    throw new Error('frame too short for zrtp header');
                }
                const header    = frameData[prefix];
                const ctrBytes  = frameData.slice(prefix + 1, prefix + 5);
                const counter   = new DataView(ctrBytes.buffer, ctrBytes.byteOffset).getUint32(0, false);
                const aad       = new Uint8Array([header, ...ctrBytes]);
                const plaintext = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: buildIV(recvSalt, counter), additionalData: aad },
                    recvKey,
                    frameData.slice(prefix + 5)
                );
                if (++recvAeadOk >= 5) recvStrict = true;
                const out = new Uint8Array(prefix + plaintext.byteLength);
                out.set(frameData.slice(0, prefix), 0);
                out.set(new Uint8Array(plaintext), prefix);
                frame.data = out.buffer;
                controller.enqueue(frame);
            } catch {
                if (!recvStrict) controller.enqueue(frame);
            }
        }
    });
}

self.onmessage = async ({ data }) => {
    const { type } = data;

    if (type === 'set-send-key') {
        sendKey  = await crypto.subtle.importKey('raw', new Uint8Array(data.key), { name: 'AES-GCM' }, false, ['encrypt']);
        sendSalt = new Uint8Array(data.salt);
        return;
    }

    if (type === 'set-recv-key') {
        recvKey  = await crypto.subtle.importKey('raw', new Uint8Array(data.key), { name: 'AES-GCM' }, false, ['decrypt']);
        recvSalt = new Uint8Array(data.salt);
        return;
    }

    if (type === 'set-video-send-prefix') { sendVideoPrefix = data.prefix; return; }
    if (type === 'set-video-recv-prefix') { recvVideoPrefix = data.prefix; return; }

    const { kind, readable, writable } = data;

    if (type === 'install-sender') {
        readable.pipeThrough(makeSenderTransform(kind)).pipeTo(writable);
    }

    if (type === 'install-receiver') {
        readable.pipeThrough(makeReceiverTransform(kind)).pipeTo(writable);
    }
};

self.onrtctransform = (event) => {
    const transformer = event.transformer;
    const { type, kind } = transformer.options;

    if (type === 'install-sender') {
        transformer.readable.pipeThrough(makeSenderTransform(kind)).pipeTo(transformer.writable);
    } else if (type === 'install-receiver') {
        transformer.readable.pipeThrough(makeReceiverTransform(kind)).pipeTo(transformer.writable);
    }
};
