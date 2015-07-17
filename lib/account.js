'use strict';

import debug from 'debug';

import { md5 } from 'blueimp-md5';
import { EventEmitter } from 'events';
import { Call } from './call';

const DEBUG = debug('sylkrtc:Account');


class Account extends EventEmitter {
    constructor(id, password) {
        if (id.indexOf('@') === -1) {
            throw new Error('Invalid account id specified');
        }
        super();
        const username = id.substring(0, id.indexOf('@'));
        const domain = id.substring(id.indexOf('@') + 1);
        this._id = id;
        this._password = md5(username + ':' + domain + ':' + password);
        this._bound = false;
        this._connection = null;
        this._registrationState = null;
        this._calls = new Map();
    }

    get id() {
        return this._id;
    }

    get registrationState() {
        return this._registrationState;
    }

    bind() {
        if (this._bound) {
            return;
        }
        let req = {
            sylkrtc: 'bind',
            account: this._id,
            password: this._password
        };
        const self = this;
        self._sendRequest(req, function(error) {
            if (error) {
                DEBUG('Bind error: %s', error);
                const oldState = self._registrationState;
                const newState = 'failed';
                self._registrationState = newState;
                self.emit('registrationStateChanged', oldState, newState);
            } else {
                self._bound = true;
            }
        });
    }

    unbind() {
        if (!this._bound) {
            return;
        }
        let req = {
            sylkrtc: 'unbind',
            account: this._id,
        };
        const self = this;
        self._sendRequest(req, function(error) {
            if (error) {
                DEBUG('Unbind error: %s', error);
            }
            self._bound = false;
            const oldState = self._registrationState;
            const newState = null;
            self._registrationState = newState;
            self.emit('registrationStateChanged', oldState, newState);
        });
    }

    call(uri, options={}) {
        let call = new Call(this);
        call._initOutgoing(uri, options);
        this._calls.set(call.id, call);
        this.emit('outgoingCall', call);
        return call;
    }

    // Private API

    _handleEvent(message) {
        DEBUG('Received account event: %s', message.event);
        switch (message.event) {
            case 'registration_state':
                const oldState = this._registrationState;
                const newState = message.data.state;
                this._registrationState = newState;
                this.emit('registrationStateChanged', oldState, newState);
                break;
            case 'incoming_call':
                let call = new Call(this);
                call._initIncoming(message.session, message.data.sdp);
                this._calls.set(call.id, call);
                this.emit('incomingCall', call);
                break;
            default:
                break;
        }
    }

    _sendRequest(req, cb) {
        this._connection._sendRequest(req, cb);
    }

}


export { Account };
