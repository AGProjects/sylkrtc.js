'use strict';

import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:ScreenSharingManager');

// In-dialog screen sharing and remote pointer, using four content types:
//   sylk-screen-sharing       {action: start|stop|request|request_accept|request_reject, ...}
//   sylk-pointer              {x, y, t} -- normalized point on the shared surface
//   sylk-pointer-visibility   {inApp} -- can the sharer paint into their capture right now
//   sylk-pointer-ack          {t} -- point t was actually rendered
// All signalling, never surfaced as 'incomingMessage'.
const SCREEN_SHARING_CONTENT_TYPE = 'application/sylk-screen-sharing';
const POINTER_CONTENT_TYPE = 'application/sylk-pointer';
const POINTER_VISIBILITY_CONTENT_TYPE = 'application/sylk-pointer-visibility';
const POINTER_ACK_CONTENT_TYPE = 'application/sylk-pointer-ack';

const CONTENT_TYPES = Object.freeze([
    SCREEN_SHARING_CONTENT_TYPE,
    POINTER_CONTENT_TYPE,
    POINTER_VISIBILITY_CONTENT_TYPE,
    POINTER_ACK_CONTENT_TYPE
]);

const SCREEN_REQUEST_TTL = 60 * 1000;   // how long an unanswered request stays live
const PENDING_POINT_TTL = 5000;         // forget points never ACKed after this long
const COORD_PRECISION = 1000;           // millipoint precision for x/y


class ScreenSharingManager extends EventEmitter {
    static handles(contentType) {
        return CONTENT_TYPES.indexOf(contentType) !== -1;
    }

    constructor(call) {
        super();
        this._call = call;

        this._sharePointable = false;
        this._remoteScreenSharing = false;
        this._remoteScreenSharePointable = true;
        this._remoteInApp = true;
        this._outgoingScreenRequests = new Map();   // id -> expiry timer
        this._handledScreenRequests = new Set();    // ids already surfaced
        this._pendingPoints = new Map();             // t -> caller's context
    }

    get remoteScreenSharing() {
        return this._remoteScreenSharing;
    }

    get remoteScreenSharePointable() {
        return this._remoteScreenSharePointable;
    }

    get remoteInApp() {
        return this._remoteInApp;
    }

    get canPointAtRemoteScreen() {
        return this._remoteScreenSharing && this._remoteScreenSharePointable && this._remoteInApp;
    }

    /** Declare whether a screen we are about to share can be pointed at.
     *  Set before startScreensharing(); fixed for that share's lifetime. */
    setScreenSharePointable(pointable) {
        this._sharePointable = !!pointable;
    }

    /** Ask the peer to share THEIR screen. Returns the request id, or
     *  null if it could not be sent. Resolves via
     *  'screenShareRequestResolved', including on timeout. */
    requestScreenShare(ttl=SCREEN_REQUEST_TTL) {
        const requestId = uuidv4();
        const sent = this._sendSignal(SCREEN_SHARING_CONTENT_TYPE, {
            action: 'request',
            id: requestId,
            expires: new Date(Date.now() + ttl).toISOString()
        });
        if (!sent) {
            return null;
        }
        DEBUG('Screen share requested from %s: %s', this._call.remoteIdentity.uri, requestId);
        const timer = setTimeout(() => {
            this._outgoingScreenRequests.delete(requestId);
            DEBUG('Screen share request %s timed out', requestId);
            this.emit('screenShareRequestResolved',
                { id: requestId, accepted: false, reason: 'timeout' });
        }, ttl);
        this._outgoingScreenRequests.set(requestId, timer);
        return requestId;
    }

    acceptScreenShareRequest(requestId) {
        this._sendSignal(SCREEN_SHARING_CONTENT_TYPE,
            { action: 'request_accept', id: requestId });
    }

    rejectScreenShareRequest(requestId) {
        this._sendSignal(SCREEN_SHARING_CONTENT_TYPE,
            { action: 'request_reject', id: requestId });
    }

    /** Send a guide point at a normalized (0..1) position. `context` is
     *  opaque, handed back with 'pointerAck'. Returns the point's token,
     *  or null when there is nothing to point at. */
    sendPointer(x, y, context=null) {
        if (!this.canPointAtRemoteScreen) {
            return null;
        }
        if (typeof x !== 'number' || typeof y !== 'number') {
            return null;
        }
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) {
            return null;
        }
        const t = Date.now();
        const point = {
            x: Math.round(x * COORD_PRECISION) / COORD_PRECISION,
            y: Math.round(y * COORD_PRECISION) / COORD_PRECISION,
            t
        };
        if (!this._sendSignal(POINTER_CONTENT_TYPE, point)) {
            return null;
        }
        this._pendingPoints.set(t, context);
        for (const key of this._pendingPoints.keys()) {
            if (key < t - PENDING_POINT_TTL) {
                this._pendingPoints.delete(key);
            }
        }
        return t;
    }

    ackPointer(t) {
        if (t == null) {
            return;
        }
        this._sendSignal(POINTER_ACK_CONTENT_TYPE, { t });
    }

    setPointerVisibility(inApp) {
        this._sendSignal(POINTER_VISIBILITY_CONTENT_TYPE, { inApp: !!inApp });
    }

    /** Announce that our own share started or stopped. */
    announce(sharing) {
        this._sendSignal(SCREEN_SHARING_CONTENT_TYPE, sharing
            ? { action: 'start', pointer: this._sharePointable }
            : { action: 'stop' });
    }

    handleSignal(contentType, rawContent) {
        let content;
        try {
            content = JSON.parse(rawContent);
        } catch (e) {
            DEBUG('Ignoring malformed %s: %s', contentType, e);
            return;
        }
        if (!content) {
            return;
        }
        switch (contentType) {
            case SCREEN_SHARING_CONTENT_TYPE:
                this._handleScreenSharingSignal(content);
                break;
            case POINTER_CONTENT_TYPE:
                if (this._call.sharingScreen
                    && typeof content.x === 'number' && typeof content.y === 'number') {
                    this.emit('pointer', { x: content.x, y: content.y, t: content.t });
                }
                break;
            case POINTER_VISIBILITY_CONTENT_TYPE:
                if (typeof content.inApp === 'boolean') {
                    this._updateRemoteScreenState({ inApp: content.inApp });
                }
                break;
            case POINTER_ACK_CONTENT_TYPE:
                if (content.t != null && this._pendingPoints.has(content.t)) {
                    const context = this._pendingPoints.get(content.t);
                    this._pendingPoints.delete(content.t);
                    this.emit('pointerAck', context);
                }
                break;
            default:
                break;
        }
    }

    clear() {
        for (const timer of this._outgoingScreenRequests.values()) {
            clearTimeout(timer);
        }
        this._outgoingScreenRequests.clear();
        this._pendingPoints.clear();
    }

    // Private API

    _sendSignal(contentType, payload) {
        return this._call._sendSignal(contentType, payload);
    }

    _handleScreenSharingSignal(content) {
        switch (content.action) {
            case 'start':
            case 'stop': {
                const sharing = content.action === 'start';
                this._updateRemoteScreenState({
                    sharing,
                    pointable: sharing ? content.pointer !== false : true,
                    inApp: true
                });
                break;
            }
            case 'request': {
                const requestId = content.id;
                if (!requestId || this._handledScreenRequests.has(requestId)) {
                    return;
                }
                const expires = Date.parse(content.expires);
                const deadline = isNaN(expires) ? Date.now() + SCREEN_REQUEST_TTL : expires;
                if (Date.now() >= deadline) {
                    DEBUG('Dropping stale screen share request %s', requestId);
                    return;
                }
                this._handledScreenRequests.add(requestId);
                DEBUG('Screen share requested by %s: %s', this._call.remoteIdentity.uri, requestId);
                this.emit('screenShareRequest', { id: requestId, expiresAt: deadline });
                break;
            }
            case 'request_accept':
            case 'request_reject': {
                const requestId = content.id;
                const timer = this._outgoingScreenRequests.get(requestId);
                if (timer === undefined) {
                    return;
                }
                clearTimeout(timer);
                this._outgoingScreenRequests.delete(requestId);
                const accepted = content.action === 'request_accept';
                DEBUG('Peer %s screen share request %s',
                    accepted ? 'accepted' : 'rejected', requestId);
                this.emit('screenShareRequestResolved', { id: requestId, accepted });
                break;
            }
            default:
                break;
        }
    }

    _updateRemoteScreenState(next) {
        let changed = false;
        if ('sharing' in next && next.sharing !== this._remoteScreenSharing) {
            this._remoteScreenSharing = next.sharing;
            changed = true;
        }
        if ('pointable' in next && next.pointable !== this._remoteScreenSharePointable) {
            this._remoteScreenSharePointable = next.pointable;
            changed = true;
        }
        if ('inApp' in next && next.inApp !== this._remoteInApp) {
            this._remoteInApp = next.inApp;
            changed = true;
        }
        if (changed) {
            DEBUG('Remote screen: sharing=%s pointable=%s inApp=%s',
                this._remoteScreenSharing, this._remoteScreenSharePointable, this._remoteInApp);
            this.emit('remoteScreenSharingChanged', {
                sharing: this._remoteScreenSharing,
                pointable: this._remoteScreenSharePointable,
                inApp: this._remoteInApp
            });
        }
    }
}


export { ScreenSharingManager };
