'use strict';

import bowser from 'bowser';
import debug from 'debug';
import uuid from 'node-uuid';

import { EventEmitter } from 'events';
import { setImmediate } from 'timers';
import { w3cwebsocket as W3CWebSocket } from 'websocket';
import { Account } from './account';

const SYLKRTC_PROTO = 'sylkRTC-1';
const DEBUG = debug('sylkrtc:Connection');

const MSECS = 1000;
const INITIAL_DELAY = 0.5 * MSECS;
const MAX_DELAY = 64 * MSECS;

// compute a string for our well-known platforms
let platform;
if (bowser.iphone) {
    platform = 'iPhone';
} else if (bowser.ipad) {
    platform = 'iPad';
} else if (bowser.ipod) {
    platform = 'iPod';
} else if (bowser.android) {
    platform = 'Android';
} else if (bowser.mac) {
    platform = 'macOS';
} else if (bowser.linux) {
    platform = 'Linux';
} else if (bowser.windows) {
    platform = 'Windows';
} else {
    platform = 'Unknown';
}
if (bowser.osversion) {
    platform = `${platform} ${bowser.osversion}`;
}
let browser = bowser.name;
if (bowser.version) {
    browser = `${browser} ${bowser.version}`;
}

const USER_AGENT = `SylkRTC (${browser} on ${platform})`;


class Connection extends EventEmitter {
    constructor(options = {}) {
        if (!options.server) {
            throw new Error('\"server\" must be specified');
        }
        super();
        this._wsUri = options.server;
        this._sock = null;
        this._state = null;
        this._closed = false;
        this._timer = null;
        this._delay = INITIAL_DELAY;
        this._accounts = new Map();
        this._requests = new Map();
    }

    get state() {
        return this._state;
    }

    close() {
        if (this._closed) {
            return;
        }
        this._closed = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (this._sock) {
            this._sock.close();
            this._sock = null;
        } else {
            setImmediate(() => {
                this._setState('closed');
            });
        }
    }

    addAccount(options = {}, cb = null) {
        if (typeof options.account !== 'string' || typeof options.password !== 'string') {
            throw new Error('Invalid options, \"account\" and \"password\" must be supplied');
        }
        if (this._accounts.has(options.account)) {
            throw new Error('Account already added');
        }

        const acc = new Account(options, this);
        // add it early to the set so we don't add it more than once, ever
        this._accounts.set(acc.id, acc);

        const req = {
            sylkrtc: 'account-add',
            account: acc.id,
            password: acc.password,
            display_name: acc.displayName,
            user_agent: USER_AGENT
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('add_account error: %s', error);
                this._accounts.delete(acc.id);
            }
            if (cb) {
                cb(error, error ? null : acc);
            }
        });

    }

    removeAccount(account, cb=null) {
        const acc = this._accounts.get(account.id);
        if (account !== acc) {
            throw new Error('Unknown account');
        }

        // delete the account from the mapping, regardless of the result
        this._accounts.delete(account.id);

        const req = {
            sylkrtc: 'account-remove',
            account: acc.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('remove_account error: %s', error);
            }
            if (cb) {
                cb();
            }
        });

    }

    reconnect() {
        if (this._state === 'disconnected') {
            clearTimeout(this._timer);
            this._delay = INITIAL_DELAY;
            this._timer = setTimeout(() => {
                this._connect();
            }, this._delay);
        }
    }

    // Private API

    _initialize() {
        if (this._sock !== null) {
            throw new Error('WebSocket already initialized');
        }
        if (this._timer !== null) {
            throw new Error('Initialize is in progress');
        }

        DEBUG('Initializing');

        if (process.browser) {
            window.addEventListener('beforeunload', () => {
                if (this._sock !== null) {
                    const noop = function() {};
                    this._sock.onerror = noop;
                    this._sock.onmessage = noop;
                    this._sock.onclose = noop;
                    this._sock.close();
                }
            });
        }

        this._timer = setTimeout(() => {
            this._connect();
        }, this._delay);
    }

    _connect() {
        DEBUG('WebSocket connecting');
        this._setState('connecting');

        this._sock = new W3CWebSocket(this._wsUri, SYLKRTC_PROTO);
        this._sock.onopen = () => {
            DEBUG('WebSocket connection open');
            this._onOpen();
        };
        this._sock.onerror = () => {
            DEBUG('WebSocket connection got error');
        };
        this._sock.onclose = (event) => {
            DEBUG('WebSocket connection closed: %d: (reason=\"%s\", clean=%s)', event.code, event.reason, event.wasClean);
            this._onClose();
        };
        this._sock.onmessage = (event) => {
            DEBUG('WebSocket received message: %o', event);
            this._onMessage(event);
        };
    }

    _sendRequest(req, cb) {
        const transaction = uuid.v4();
        req.transaction = transaction;
        if (this._state !== 'ready') {
            setImmediate(() => {
                cb(new Error('Connection is not ready'));
            });
            return;
        }
        this._requests.set(transaction, {req: req, cb: cb});
        this._sock.send(JSON.stringify(req));
    }

    _setState(newState) {
        DEBUG('Set state: %s -> %s', this._state, newState);
        const oldState = this._state;
        this._state = newState;
        this.emit('stateChanged', oldState, newState);
    }

    // WebSocket callbacks

    _onOpen() {
        clearTimeout(this._timer);
        this._timer = null;
        this._delay = INITIAL_DELAY;
        this._setState('connected');
    }

    _onClose() {
        this._sock = null;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }

        // remove all accounts, the server no longer has them anyway
        this._accounts.clear();

        this._setState('disconnected');
        if (!this._closed) {
            this._delay = this._delay * 2;
            if (this._delay > MAX_DELAY) {
                this._delay = INITIAL_DELAY;
            }
            DEBUG('Retrying connection in %s seconds', this._delay / MSECS);
            this._timer = setTimeout(() => {
                this._connect();
            }, this._delay);
        } else {
            this._setState('closed');
        }
    }

    _onMessage(event) {
        const message = JSON.parse(event.data);
        if (typeof message.sylkrtc === 'undefined') {
            DEBUG('Unrecognized message received');
            return;
        }

        DEBUG('Received \"%s\" message: %o', message.sylkrtc, message);

        if (message.sylkrtc === 'event') {
            DEBUG('Received event: \"%s\"', message.event);
            switch (message.event) {
                case 'ready':
                    this._setState('ready');
                    break;
                default:
                    break;
            }
        } else if (message.sylkrtc === 'account_event') {
            let acc = this._accounts.get(message.account);
            if (!acc) {
                DEBUG('Account %s not found', message.account);
                return;
            }
            acc._handleEvent(message);
        } else if (message.sylkrtc === 'session_event') {
            const sessionId = message.session;
            for (let acc of this._accounts.values()) {
                let call = acc._calls.get(sessionId);
                if (call) {
                    call._handleEvent(message);
                    break;
                }
            }
        } else if (message.sylkrtc === 'videoroom_event') {
            const confId = message.session;
            for (let acc of this._accounts.values()) {
                 let confCall = acc._confCalls.get(confId);
                 if (confCall) {
                     confCall._handleEvent(message);
                     break;
                 }
            }
        } else if (message.sylkrtc === 'ack' || message.sylkrtc === 'error') {
            const transaction = message.transaction;
            const data = this._requests.get(transaction);
            if (!data) {
                DEBUG('Could not find transaction %s', transaction);
                return;
            }
            this._requests.delete(transaction);
            DEBUG('Received \"%s\" for request: %o', message.sylkrtc, data.req);
            if (data.cb) {
                if (message.sylkrtc === 'ack') {
                    data.cb(null);
                } else {
                    data.cb(new Error(message.error));
                }
            }
        }
    }

}


export { Connection };
