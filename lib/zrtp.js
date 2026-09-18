'use strict';

import debug from 'debug';
import nacl from 'tweetnacl';
import { EventEmitter } from 'events';
import { buf2hex, hex2buf, sha256, deriveSessionKeys, deriveSAS } from './zrtp-crypto';

const DEBUG = debug('sylkrtc:Zrtp');

const CONTENT_TYPE   = 'application/sylk-zrtp-negotiation';
const VERSION        = 3;
const SUITE          = 'AES-128-GCM';
const ACTIVITY_TICKS = 5;

export const ENCRYPTION_MODES = ['sdes', 'zrtp_optional', 'zrtp_mandatory'];
export const ENCRYPTION_MODE_DEFAULT = 'sdes';

// Video prefix depends on the negotiated codec (different packetizers
// need different amounts of plaintext header). H264 is intentionally
// excluded - its STAP-A multi-NAL packetizer is incompatible with the
// fixed-prefix encryption scheme, so video E2E is skipped for it.
const VIDEO_PREFIX_BY_CODEC = { VP8: 3, VP9: 3, AV1: 1 };

// How many times / how often to retry a getStats()-based codec lookup.
// Stats entries for outbound/inbound-rtp only appear once real frames
// have actually been encoded/decoded, which can lag a moment behind the
// handshake reaching key-agreed.
const CODEC_LOOKUP_ATTEMPTS = 6;
const CODEC_LOOKUP_INTERVAL_MS = 300;

const SUPPORTS_INSERTABLE_STREAMS = typeof RTCRtpSender !== 'undefined' &&
    typeof RTCRtpSender.prototype.createEncodedStreams === 'function';
const SUPPORTS_SCRIPT_TRANSFORM = typeof RTCRtpScriptTransform !== 'undefined';

// Canonical JSON: keys sorted lexicographically at every depth, no
// whitespace. Must byte-match the peer's signer/verifier (see
// docs/encryption/zrtp/Readme.md "Canonical JSON").
function canonicalize(value) {
    if (Array.isArray(value)) {
        return '[' + value.map(canonicalize).join(',') + ']';
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
    }
    return JSON.stringify(value);
}


class ZrtpSession extends EventEmitter {
    static MANDATORY_TIMEOUT_MS = 6000;

    constructor(call) {
        super();
        this._call         = call;
        this._state        = 'idle';
        this._keyPair      = null;
        this._peerPub      = null;
        this._peerDeviceId = null;
        this._peerRsIdHex  = null;
        this._derivedKeys  = null;
        this._continuity   = null;
        this._worker       = null;
        this._activityPoll = null;
        this._mandatoryTimer = null;
        this._localRs1ForDerivation = null;
        this._installedSenderKinds   = new Set();
        this._installedReceiverKinds = new Set();

        // Video's sender/receiver are captured at install time but not
        // actually wired into the worker until we can resolve the real
        // negotiated codec from live stats (see installSender/
        // installReceiver below). Until createEncodedStreams() is
        // called, media flows completely normally, so holding these is
        // safe and doesn't interrupt video during the handshake window.
        this._pendingVideoSender   = null;
        this._pendingVideoReceiver = null;
        this._h264DropEmitted      = false;
    }

    static handles(contentType) {
        return contentType === CONTENT_TYPE;
    }

    get state() { return this._state; }
    get continuityState() { return this._continuity; }
    get peerDeviceId() { return this._peerDeviceId; }

    get sas() {
        return this._derivedKeys ? deriveSAS(this._derivedKeys.sasBytes) : null;
    }

    /** Kinds ('audio' | 'video') that have a successful install on BOTH
     *  the sender and receiver side - i.e. actually protected end-to-end
     *  in both directions, not just one. Intended for the statistics /
     *  diagnostics view, not for the always-visible lock icon. */
    get encryptedKinds() {
        return ['audio', 'video'].filter(k =>
            this._installedSenderKinds.has(k) && this._installedReceiverKinds.has(k)
        );
    }

    get _peerUri() {
        return this._call._remoteIdentity.uri;
    }

    // Called early — right when senders/receivers are created, before
    // media flows. Audio installs immediately (no codec ambiguity: the
    // prefix is always 0). Video is deferred - see _installPendingVideo*.
    installSender(sender) {
        if (!sender.track || !this._call.zrtpEnabled) return;
        const kind = sender.track.kind;

        const isMidCallVideo = kind === 'video' && this._state !== 'idle';

        // Safari's RTCRtpScriptTransform stalls a sender's encoder after one
        // frame when attached to a track added mid-call (see notes on
        // _installTransform) - skip it there entirely, since Safari needs no
        // transform at all for plain, unencrypted media to flow normally.
        //
        // Chrome's legacy insertable-streams path is the opposite: once
        // `encodedInsertableStreams: true` is set on the RTCPeerConnection,
        // EVERY sender/receiver's encoded frames are diverted into that pipe
        // regardless of whether we ever call createEncodedStreams() on it.
        // Skip the call here and the frames just get stuck internally - no
        // media flows for that track at all. So on Chrome we must always
        // install the transform, mid-call video included, and let it run as
        // a passthrough (no key/prefix ever set for it).
        if (isMidCallVideo && !SUPPORTS_INSERTABLE_STREAMS) {
            DEBUG('Video sender added after ZRTP already started (state=%s) - skipping transform for upgraded video', this._state);
            return;
        }

        this._installTransform(sender, 'install-sender', kind);

        if (kind === 'audio') {
            this._installedSenderKinds.add('audio');
            return;
        }

        if (isMidCallVideo) {
            DEBUG('Video sender added after ZRTP already started (state=%s) - leaving upgraded video unencrypted', this._state);
            return;
        }

        if (this._state === 'key-agreed' || this._state === 'key-active') {
            this._pendingVideoSender = sender;
            this._installPendingVideoSender();
        } else if (this._state !== 'failed') {
            this._pendingVideoSender = sender;
        }
    }

    installReceiver(receiver) {
        if (!receiver.track || !this._call.zrtpEnabled) return;
        const kind = receiver.track.kind;
        const isMidCallVideo = kind === 'video' && this._state !== 'idle';

        if (isMidCallVideo && !SUPPORTS_INSERTABLE_STREAMS) {
            DEBUG('Video receiver added after ZRTP already started (state=%s) - skipping transform for upgraded video', this._state);
            return;
        }

        this._installTransform(receiver, 'install-receiver', kind);

        if (kind === 'audio') {
            this._installedReceiverKinds.add('audio');
            return;
        }

        if (isMidCallVideo) {
            DEBUG('Video receiver added after ZRTP already started (state=%s) - leaving upgraded video unencrypted', this._state);
            return;
        }

        if (this._state === 'key-agreed' || this._state === 'key-active') {
            this._pendingVideoReceiver = receiver;
            this._installPendingVideoReceiver();
        } else if (this._state !== 'failed') {
            this._pendingVideoReceiver = receiver;
        }
    }

    _installTransform(target, type, kind) {
        if (!SUPPORTS_INSERTABLE_STREAMS && SUPPORTS_SCRIPT_TRANSFORM) {
            target.transform = new RTCRtpScriptTransform(this._getWorker(), { type, kind });
            return;
        }
        const { readable, writable } = target.createEncodedStreams();
        this._getWorker().postMessage(
            { type, kind, readable, writable },
            [readable, writable]
        );
    }

    start() {
        if (this._state !== 'idle') return;
        this._keyPair = nacl.box.keyPair();
        if (this._call._direction === 'outgoing') {
            this._sendProbe();
        }
        this._mandatoryTimer = setTimeout(
            () => this._checkMandatoryTimeout(),
            ZrtpSession.MANDATORY_TIMEOUT_MS
        );
    }

    _checkMandatoryTimeout() {
        if (this._state === 'key-agreed' || this._state === 'key-active' || this._state === 'failed') {
            return;
        }
        const payload = {
            reason: 'timeout',
            detail: `No key agreement within ${ZrtpSession.MANDATORY_TIMEOUT_MS}ms`
        };
        if (this._call.encryptionMode === 'zrtp_mandatory') {
            this._call.emit('zrtpMandatoryFailed', payload);
        } else {
            this._call.emit('zrtpDowngradeWarning', { ...payload, state: this._state });
        }
        this._transition('failed');
    }

    async handleSignal(content) {
        let msg;
        try {
            msg = JSON.parse(content);
        } catch(err) {
            DEBUG('bad message: %s', err);
            return;
        }
        if (!msg.call_id || msg.call_id !== this._call._callId) return;
        if (msg.suites && !msg.suites.includes(SUITE)) {
            this._transition('failed');
            return;
        }

        // v3: verify the detached signature before acting on probe/accept.
        // recv_ready / sender_ready confirm receipt of an already-verified
        // key, so only probe/accept carry (and need) a signature.
        if (msg.type === 'probe' || msg.type === 'accept') {
            const ok = await this._verifyOrReject(msg);
            if (!ok) return;
        }

        DEBUG('← %s (state=%s)', msg.type, this._state);
        switch (msg.type) {
            case 'probe':        this._handleProbe(msg);       break;
            case 'accept':       this._handleAccept(msg);      break;
            case 'recv_ready':   this._handleRecvReady(msg);   break;
            case 'sender_ready': this._handleSenderReady(msg); break;
        }
    }

    /** Called when the user dismisses a mismatch alarm with "I understand" -
     *  forgets the stored rs1 for this specific peer device so the next
     *  call re-bootstraps instead of alarming forever. */
    clearRs1() {
        this._call._account.clearRs1ForDevice(this._peerUri, this._peerDeviceId);
        this._call.emit('zrtpRs1Clear', { uri: this._peerUri, device_id: this._peerDeviceId });
    }

    destroy() {
        if (this._mandatoryTimer) {
            clearTimeout(this._mandatoryTimer);
            this._mandatoryTimer = null;
        }
        if (this._activityPoll) {
            clearInterval(this._activityPoll);
            this._activityPoll = null;
        }
        if (this._worker) {
            this._worker.terminate();
            this._worker = null;
        }
    }

    async _send(payload) {
        const unsigned = {
            v:         VERSION,
            call_id:   this._call._callId,
            device_id: this._call._account.localDeviceId,
            ...payload,
        };
        const signed = await this._maybeSign(unsigned);
        this._call._sendSignal(CONTENT_TYPE, signed);
    }

    async _maybeSign(payload) {
        const pgp = this._call._account.pgp;
        if (!pgp) return payload;
        const canonical = canonicalize(payload);
        try {
            const sig = await pgp.signDetached(canonical);
            return { ...payload, sig };
        } catch (err) {
            DEBUG('Could not sign zrtp payload (%s): %s', payload.type, err);
            return payload;
        }
    }

    // Receive-side policy per docs/encryption/zrtp/Readme.md:
    //   negotiated v < 3                      -> accept
    //   v >= 3, no peer key,  no sig           -> accept + warning
    //   v >= 3, no peer key,  sig present      -> accept + warning
    //   v >= 3, peer key held, no sig          -> accept + warning
    //   v >= 3, peer key held, sig, verifies   -> accept
    //   v >= 3, peer key held, sig, fails      -> reject, state 'failed'
    async _verifyOrReject(msg) {
        const negotiatedVersion = Math.min(msg.v || 1, VERSION);
        if (negotiatedVersion < 3) {
            return true;
        }

        const pgp = this._call._account.pgp;

        if (!msg.sig || !pgp) {
            DEBUG('v3 peer sent %s without a checkable signature - accepting with warning', msg.type);
            this.emit('signatureWarning', { reason: 'missing-sig', type: msg.type });
            return true;
        }

        const { sig, ...unsigned } = msg;
        const canonical = canonicalize(unsigned);
        const { verified, hadKey } = await pgp.verifyDetached(sig, canonical, this._peerUri);

        if (!hadKey) {
            DEBUG('Cannot verify signed %s: no public key for %s - accepting with warning', msg.type, this._peerUri);
            this.emit('signatureWarning', { reason: 'no-peer-key', type: msg.type });
            return true;
        }

        if (!verified) {
            DEBUG('Signature verification FAILED for %s from %s - rejecting session', msg.type, this._peerUri);
            this.emit('signatureFailed', { type: msg.type, from: this._peerUri });
            this._transition('failed');
            return false;
        }
        return true;
    }

    async _sendProbe() {
        this._transition('probing');
        const account = this._call._account;
        const legacyRs1 = account.getLegacyRs1(this._peerUri);
        const candidates = await account.getRs1Candidates(this._peerUri);

        const msg = { type: 'probe', ephem_pub_hex: buf2hex(this._keyPair.publicKey), suites: [SUITE] };
        if (legacyRs1) {
            msg.rs_id_hex = buf2hex(await sha256(legacyRs1)).slice(0, 16);
        }
        if (candidates.length > 0) {
            msg.rs_id_hex_candidates = candidates;
        }
        await this._send(msg);
    }

    async _sendAccept() {
        // By now (post-_handleProbe) we know the caller's device_id, so we
        // can resolve our own pairwise rs1 for exactly that device instead
        // of guessing from the legacy slot.
        const account = this._call._account;
        const localRs1 = account.resolveLocalRs1(this._peerUri, this._peerDeviceId);

        const msg = { type: 'accept', ephem_pub_hex: buf2hex(this._keyPair.publicKey), suites: [SUITE] };
        if (localRs1) {
            msg.rs_id_hex = buf2hex(await sha256(localRs1)).slice(0, 16);
        }
        await this._send(msg);
    }

    async _handleProbe(msg) {
        if (this._call._direction !== 'incoming') return;
        if (this._state !== 'idle' || this._peerPub)  return;
        const pub = hex2buf(msg.ephem_pub_hex);
        if (pub.length !== 32) { this._transition('failed'); return; }
        this._peerPub      = pub;
        this._peerDeviceId = msg.device_id || null;

        const localDeviceId = this._call._account.localDeviceId;
        const candidate = (msg.rs_id_hex_candidates || []).find(c => c.device_id === localDeviceId);
        this._peerRsIdHex = candidate ? candidate.rs_id_hex : (msg.rs_id_hex || null);

        this._keyPair = this._keyPair || nacl.box.keyPair();
        this._transition('probing');
        await this._deriveKeys(await this._resolveContinuity());
        this._activateRecvKey();
        this._installPendingVideoReceiver();
        this._sendAccept();
    }

    async _handleAccept(msg) {
        if (this._call._direction !== 'outgoing') return;
        if (this._state !== 'probing' || this._peerPub) return;
        const pub = hex2buf(msg.ephem_pub_hex);
        if (pub.length !== 32) { this._transition('failed'); return; }
        this._peerPub      = pub;
        this._peerDeviceId = msg.device_id || null; // accept carries no candidates array
        this._peerRsIdHex  = msg.rs_id_hex || null;

        await this._deriveKeys(await this._resolveContinuity());
        this._activateRecvKey();
        this._installPendingVideoReceiver();
        this._send({ type: 'recv_ready' });
    }

    async _handleRecvReady(msg) {
        if (this._call._direction !== 'incoming') return;
        if (!this._derivedKeys || this._state === 'key-active' || this._state === 'failed') return;
        this._activateSendKey();
        this._installPendingVideoSender();
        this._send({ type: 'sender_ready' });
        this._transition('key-agreed');
        this._startActivityPoller();
    }

    async _handleSenderReady(msg) {
        if (this._call._direction !== 'outgoing') return;
        if (!this._derivedKeys || this._state === 'key-active' || this._state === 'failed') return;
        this._activateSendKey();
        this._installPendingVideoSender();
        this._transition('key-agreed');
        this._startActivityPoller();
    }

    /** Resolves the codec actually in use from live pc.getStats() rather
     *  than the SDP's full offered/accepted codec list - the SDP m-line
     *  usually lists every codec both sides support, not just the one
     *  in use, so it can't tell us the real answer. Retries briefly
     *  since outbound/inbound-rtp stats entries only appear once real
     *  frames have been encoded/decoded, which can lag a moment behind
     *  the handshake completing. */
    async _resolveVideoCodec(direction) {
        const pc = this._call._pc;
        if (!pc) return null;
        const rtpType = direction === 'send' ? 'outbound-rtp' : 'inbound-rtp';
        for (let attempt = 0; attempt < CODEC_LOOKUP_ATTEMPTS; attempt++) {
            try {
                const stats = await pc.getStats();
                for (const stat of stats.values()) {
                    if (stat.type === rtpType && stat.kind === 'video' && stat.codecId) {
                        const codecStat = stats.get(stat.codecId);
                        if (codecStat?.mimeType) {
                            DEBUG(codecStat.mimeType);
                            return codecStat.mimeType.split('/')[1].toUpperCase();
                        }
                    }
                }
            } catch (err) {
                DEBUG('getStats error while resolving video codec: %s', err);
            }
            await new Promise(r => setTimeout(r, CODEC_LOOKUP_INTERVAL_MS));
        }
        return null;
    }

    async _installPendingVideoSender() {
        const sender = this._pendingVideoSender;
        if (!sender) return;
        this._pendingVideoSender = null;
        const codec = await this._resolveVideoCodec('send');
        if (codec === 'H264') { this._handleH264Drop(); return; }
        const prefix = VIDEO_PREFIX_BY_CODEC[codec];
        if (prefix === undefined) {
            DEBUG('Skipping video E2E (sender): unresolved/unsupported codec %s', codec);
            return;
        }
        this._installedSenderKinds.add('video');
        this._getWorker().postMessage({ type: 'set-video-send-prefix', prefix });
    }

    async _installPendingVideoReceiver() {
        const receiver = this._pendingVideoReceiver;
        if (!receiver) return;
        this._pendingVideoReceiver = null;
        const codec = await this._resolveVideoCodec('recv');
        if (codec === 'H264') { this._handleH264Drop(); return; }
        const prefix = VIDEO_PREFIX_BY_CODEC[codec];
        if (prefix === undefined) {
            DEBUG('Skipping video E2E (receiver): unresolved/unsupported codec %s', codec);
            return;
        }
        this._installedReceiverKinds.add('video');
        this._getWorker().postMessage({ type: 'set-video-recv-prefix', prefix });
    }

    _handleH264Drop() {
        if (this._h264DropEmitted) return;
        this._h264DropEmitted = true;
        if (this._call.encryptionMode === 'zrtp_mandatory') {
            for (const sender of this._call.getSenders()) {
                if (sender.track?.kind === 'video') {
                    sender.track.stop();
                }
            }
            for (const receiver of this._call.getReceivers()) {
                if (receiver.track?.kind === 'video') {
                    receiver.track.stop();
                }
            }
            this._call.emit('zrtpStrictH264VideoDrop', {});
        }
        // zrtp_optional: video just stays unencrypted; audio is unaffected.
    }

    async _resolveContinuity() {
        const account = this._call._account;
        const localRs1 = account.resolveLocalRs1(this._peerUri, this._peerDeviceId);
        const localHas = !!localRs1;
        const peerHas  = !!this._peerRsIdHex;

        this._localRs1ForDerivation = localRs1;

        if (!localHas && !peerHas) return 'first-time';
        if (!localHas && peerHas)  return 'one-sided-peer';
        if (localHas  && !peerHas) return 'one-sided-local';
        const localRsId = buf2hex(await sha256(localRs1)).slice(0, 16);
        return localRsId === this._peerRsIdHex ? 'verified' : 'mismatch';
    }

    async _deriveKeys(continuityState) {
        const sharedSecret = nacl.scalarMult(this._keyPair.secretKey, this._peerPub);
        this._continuity  = continuityState;
        this._derivedKeys = await deriveSessionKeys(sharedSecret, this._localRs1ForDerivation, continuityState);
        if (continuityState === 'mismatch') {
            this.emit('mitmDetected', { sas: this.sas });
        }
        this.emit('keysReady', { sas: this.sas });
    }

    _activateSendKey() {
        const { key, salt } = this._getSendKey();
        DEBUG('activating send key, direction=%s', this._call._direction);
        this._getWorker().postMessage({ type: 'set-send-key', key: Array.from(key), salt: Array.from(salt) });
    }

    _activateRecvKey() {
        const { key, salt } = this._getRecvKey();
        DEBUG('activating recv key, direction=%s', this._call._direction);
        this._getWorker().postMessage({ type: 'set-recv-key', key: Array.from(key), salt: Array.from(salt) });
    }

    _getSendKey() {
        const k = this._derivedKeys;
        return this._call._direction === 'outgoing'
            ? { key: k.audioCallerKey, salt: k.audioCallerSalt }
            : { key: k.audioCalleeKey, salt: k.audioCalleeSalt };
    }

    _getRecvKey() {
        const k = this._derivedKeys;
        return this._call._direction === 'outgoing'
            ? { key: k.audioCalleeKey, salt: k.audioCalleeSalt }
            : { key: k.audioCallerKey, salt: k.audioCallerSalt };
    }

    _startActivityPoller() {
        let lastTotal = 0;
        let ticks = 0;
        this._activityPoll = setInterval(async () => {
            if (!this._call._pc || this._state === 'failed') {
                clearInterval(this._activityPoll);
                return;
            }
            try {
                const stats = await this._call._pc.getStats();
                let total = 0;
                stats.forEach(s => { if (s.type === 'inbound-rtp') total += s.packetsReceived || 0; });
                if (total > lastTotal) { lastTotal = total; ticks++; }
                if (ticks >= ACTIVITY_TICKS) {
                    clearInterval(this._activityPoll);
                    this._transition('key-active');

                    const account = this._call._account;
                    account.setRs1ForDevice(this._peerUri, this._peerDeviceId, this._derivedKeys.nextRs1);
                    const payload = {
                        uri: this._peerUri,
                        device_id: this._peerDeviceId,
                        rs1: Array.from(this._derivedKeys.nextRs1),
                        continuity: this._continuity
                    };
                    this.emit('rs1Update', payload);
                    this._call.emit('zrtpRs1Update', payload);
                }
            } catch(err) {
                DEBUG('stats error: %s', err);
            }
        }, 500);
    }

    _getWorker() {
        if (!this._worker) {
            this._worker = new Worker(new URL('./zrtp-frame-worker.js', import.meta.url));
            this._worker.onerror = (err) => {
                DEBUG('worker error: %s', err.message);
                this._transition('failed');
            };
        }
        return this._worker;
    }

    _transition(newState) {
        if (this._state === newState) return;
        DEBUG('%s → %s', this._state, newState);
        this._state = newState;
        this._call.emit('zrtpStateChanged', newState);
        if (newState === 'key-agreed' && this._mandatoryTimer) {
            clearTimeout(this._mandatoryTimer);
            this._mandatoryTimer = null;
        }
    }
}


export { ZrtpSession };
