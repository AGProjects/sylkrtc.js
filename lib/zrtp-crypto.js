'use strict';

export function buf2hex(buf) {
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

export function hex2buf(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return arr;
}

export async function sha256(data) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function hkdf(sharedSecret, salt, info, lengthBytes) {
    const baseKey = await crypto.subtle.importKey(
        'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
        baseKey,
        lengthBytes * 8
    );
    return new Uint8Array(bits);
}

export async function deriveSessionKeys(sharedSecret, rs1, continuityState) {
    const perCallSalt = (continuityState === 'verified' && rs1) ? rs1 : new Uint8Array(32);
    const zeros = new Uint8Array(32);

    const [audioCallerKey, audioCalleeKey, audioCallerSalt, audioCalleeSalt, sasBytes, nextRs1] = await Promise.all([
        hkdf(sharedSecret, perCallSalt, 'sylk-e2ee/v1/audio-caller-to-callee',      16),
        hkdf(sharedSecret, perCallSalt, 'sylk-e2ee/v1/audio-callee-to-caller',      16),
        hkdf(sharedSecret, perCallSalt, 'sylk-e2ee/v1/audio-caller-to-callee-salt',  8),
        hkdf(sharedSecret, perCallSalt, 'sylk-e2ee/v1/audio-callee-to-caller-salt',  8),
        hkdf(sharedSecret, perCallSalt, 'sylk-zrtp/v1/sas',                          8),
        hkdf(sharedSecret, zeros,       'sylk-zrtp/v2/next-rs1',                    32),
    ]);

    return { audioCallerKey, audioCalleeKey, audioCallerSalt, audioCalleeSalt, sasBytes, nextRs1 };
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SAS_EMOJIS = [
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼',
    '🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔',
    '🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐗',
    '🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜',
];

export function deriveSAS(sasBytes) {
    const letters = Array.from(sasBytes.slice(0, 4)).map(b => BASE32[b & 0x1f]).join('');
    const emojis  = Array.from(sasBytes.slice(4, 8)).map(b => SAS_EMOJIS[b & 0x1f]).join('');
    return `${letters} ${emojis}`;
}
