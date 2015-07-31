'use strict';

import debug from 'debug';

import { md5 } from 'blueimp-md5';
import { EventEmitter } from 'events';
import { Call } from './call';

const DEBUG = debug('sylkrtc:Account');


class Account extends EventEmitter {
    constructor(id, password, connection) {
        if (id.indexOf('@') === -1) {
            throw new Error('Invalid account id specified');
        }
        super();
        const username = id.substring(0, id.indexOf('@'));
        const domain = id.substring(id.indexOf('@') + 1);
        this._id = id;
        this._password = md5(username + ':' + domain + ':' + password);
        this._connection = connection;
        this._registrationState = null;
        this._calls = new Map();
    }

    get id() {
        return this._id;
    }

    get password() {
        return this._password;
    }

    get registrationState() {
        return this._registrationState;
    }

    register() {
        let req = {
            sylkrtc: 'account-register',
            account: this._id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Register error: %s', error);
                const oldState = this._registrationState;
                const newState = 'failed';
                let data = {reason: error.toString()};
                this._registrationState = newState;
                this.emit('registrationStateChanged', oldState, newState, data);
            }
        });
    }

    unregister() {
        let req = {
            sylkrtc: 'account-unregister',
            account: this._id,
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Unregister error: %s', error);
            }
            const oldState = this._registrationState;
            const newState = null;
            this._registrationState = newState;
            this.emit('registrationStateChanged', oldState, newState, {});
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
                let data = {};
                this._registrationState = newState;
                if (newState === 'failed') {
                    data.reason = message.data.reason;
                }
                this.emit('registrationStateChanged', oldState, newState, data);
                break;
            case 'incoming_session':
                let call = new Call(this);
                call._initIncoming(message.session, message.data.originator, message.data.sdp);
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
