'use strict';

import debug from 'debug';
import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:CapabilitiesManager');

// Per-call capability advertisement: each side lists optional protocol
// tokens it speaks once the call reaches 'established'. Unknown tokens
// are ignored, and a peer that sends nothing is treated as supporting
// nothing.
const CONTENT_TYPE = 'application/sylk-capabilities';
const VERSION = 1;


class CapabilitiesManager extends EventEmitter {
    static handles(contentType) {
        return contentType === CONTENT_TYPE;
    }

    constructor(call) {
        super();
        this._call = call;
        this._local = null;
        this._peer = [];
        this._sent = false;
    }

    /** Tokens this side declared, or null if none. */
    get local() {
        return this._local === null ? null : this._local.slice();
    }

    /** Tokens the peer advertised. */
    get peer() {
        return this._peer.slice();
    }

    peerSupports(capability) {
        return this._peer.indexOf(capability) !== -1;
    }

    /** Declare what this build can do; sent immediately if already
     *  established, otherwise on the next 'established'. */
    setLocal(capabilities) {
        if (!Array.isArray(capabilities)) {
            DEBUG('Ignoring non-array capabilities: %o', capabilities);
            return;
        }
        this._local = capabilities.filter((c) => typeof c === 'string');
        if (this._call.state === 'established') {
            this.send();
        }
    }

    /** Sent once per call; safe to call again on re-entry into
     *  'established'. */
    send() {
        if (this._local === null || this._sent) {
            return;
        }
        if (this._call.state !== 'established' || this._call._terminated) {
            return;
        }
        this._sent = true;
        DEBUG('Advertising capabilities: %o', this._local);
        const sent = this._call._sendSignal(CONTENT_TYPE, {
            version: VERSION,
            capabilities: this._local
        }, (error) => {
            if (error) {
                this._sent = false;
                DEBUG('Error advertising capabilities: %s', error);
            }
        });
        if (!sent) {
            this._sent = false;
        }
    }

    handleSignal(content) {
        let capabilities;
        try {
            const parsed = JSON.parse(content);
            capabilities = parsed && parsed.capabilities;
        } catch (e) {
            DEBUG('Ignoring malformed capabilities: %s', e);
            return;
        }
        if (!Array.isArray(capabilities)) {
            DEBUG('Ignoring capabilities without a list: %s', content);
            return;
        }
        this._peer = capabilities.filter((c) => typeof c === 'string');
        DEBUG('Peer advertised capabilities: %o', this._peer);
        this.emit('changed', this.peer);
    }
}


export { CapabilitiesManager };
