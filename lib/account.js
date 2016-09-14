'use strict';

import debug from 'debug';
import md5 from 'blueimp-md5';
import transform from 'sdp-transform';
import utils from './utils';

import { EventEmitter } from 'events';
import { Call } from './call';
import { ConferenceCall } from './conference';

const DEBUG = debug('sylkrtc:Account');


class Account extends EventEmitter {
    constructor(options, connection) {
        if (options.account.indexOf('@') === -1) {
            throw new Error('Invalid account id specified');
        }
        super();
        const id = options.account;
        const [username, domain] = id.split('@');
        this._id = id;
        this._displayName = options.displayName;
        this._password = md5(username + ':' + (options.realm || domain)+ ':' + options.password);
        this._connection = connection;
        this._registrationState = null;
        this._calls = new Map();
        this._confCalls = new Map();
    }

    get id() {
        return this._id;
    }

    get password() {
        return this._password;
    }

    get displayName() {
        return this._displayName;
    }

    get registrationState() {
        return this._registrationState;
    }

    register() {
        const req = {
            sylkrtc: 'account-register',
            account: this._id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Register error: %s', error);
                const oldState = this._registrationState;
                const newState = 'failed';
                const data = {reason: error.toString()};
                this._registrationState = newState;
                this.emit('registrationStateChanged', oldState, newState, data);
            }
        });
    }

    unregister() {
        const req = {
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
        const callObj = new Call(this);
        callObj._initOutgoing(uri, options);
        this._calls.set(callObj.id, callObj);
        this.emit('outgoingCall', callObj);
        return callObj;
    }

    joinConference(uri, options={}) {
        const confCall = new ConferenceCall(this);
        confCall._initialize(uri, options);
        this._confCalls.set(confCall.id, confCall);
        this.emit('conferenceCall', confCall);
        return confCall;
    }

    // Private API

    _handleEvent(message) {
        DEBUG('Received account event: %s', message.event);
        const data = {};
        switch (message.event) {
            case 'registration_state':
                const oldState = this._registrationState;
                const newState = message.data.state;
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
                // see what media types are offered
                const mediaTypes = { audio: false, video: false };
                const parsedSdp = transform.parse(message.data.sdp);
                for (let media of parsedSdp.media) {
                    if (media.type === 'audio' && media.port !== 0 && media.direction === 'sendrecv') {
                        mediaTypes.audio = true;
                    } else if (media.type === 'video' && media.port !== 0 && media.direction === 'sendrecv') {
                        mediaTypes.video = true;
                    }
                }
                DEBUG('Incoming call from %s with media types: %o', message.data.originator.uri, mediaTypes);
                this.emit('incomingCall', call, mediaTypes);
                break;
            case 'missed_session':
                data.originator = new utils.Identity(message.data.originator.uri, message.data.originator.display_name);
                this.emit('missedCall', data);
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
