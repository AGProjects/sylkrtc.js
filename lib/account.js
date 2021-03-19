'use strict';

import debug from 'debug';
import md5 from 'blueimp-md5';
import transform from 'sdp-transform';
import utils from './utils';

import { EventEmitter } from 'events';
import { Call } from './call';
import { ConferenceCall } from './conference';
import { Message } from './message';

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
        if (options.hasOwnProperty('ha1') && !options.ha1) {
            this._password = options.password;
        } else {
            this._password = md5(username + ':' + (options.realm || domain)+ ':' + options.password);
        }
        this._connection = connection;
        this._registrationState = null;
        this._calls = new Map();
        this._confCalls = new Map();
        this._messages = new Map();
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

    get messages() {
        return Array.from(this._messages.values());
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

    setDeviceToken(token, platform, device, silent, app) {
        DEBUG('Setting device token: %s', token);
        const req = {
            sylkrtc: 'account-devicetoken',
            account: this._id,
            token,
            platform,
            device,
            silent,
            app
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error setting device token: %s', error);
            }
        });
    }

    sendMessage(uri, message, contentType='text/plain') {
        const outgoingMessage = new Message({
            content: message,
            contentType,
            timestamp: new Date().toISOString(),
            type: 'normal'
        }, new utils.Identity(this._id, this._displayName), 'pending');
        const req = {
            sylkrtc: 'account-message',
            account: this._id,
            uri: uri,
            message_id: outgoingMessage.id,
            content: outgoingMessage.content,
            content_type: outgoingMessage.contentType,
            timestamp: outgoingMessage.timestamp
        };
        this._messages.set(outgoingMessage.id, outgoingMessage);
        this.emit('sendingMessage', outgoingMessage);
        DEBUG('Sending message: %o', outgoingMessage);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending message: %s', error);
                outgoingMessage._setState('failed');
            }
        });
        return outgoingMessage;
    }

    sendDispositionNotification(uri, id, timestamp, state) {
        const req = {
            sylkrtc: 'account-disposition-notification',
            account: this._id,
            uri: uri,
            message_id: id,
            state,
            timestamp
        };
        this.emit('sendingDispositionNotification');
        DEBUG('Sending disposition notification: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending disposition notification: %s', error);
            }
        });
    }

    // Private API

    _handleEvent(message) {
        DEBUG('Received account event: %s', message.event);
        const data = {};
        switch (message.event) {
            case 'registration-state':
                const oldState = this._registrationState;
                const newState = message.state;
                this._registrationState = newState;
                if (newState === 'failed') {
                    data.reason = message.reason;
                }
                this.emit('registrationStateChanged', oldState, newState, data);
                break;
            case 'incoming-session':
                let call = new Call(this);
                call._initIncoming(message.session, message.originator, message.sdp, message.call_id);
                this._calls.set(call.id, call);
                // see what media types are offered
                const mediaTypes = { audio: false, video: false };
                const parsedSdp = transform.parse(message.sdp);
                for (let media of parsedSdp.media) {
                    if (media.type === 'audio' && media.port !== 0 && media.direction === 'sendrecv') {
                        mediaTypes.audio = true;
                    } else if (media.type === 'video' && media.port !== 0 && media.direction === 'sendrecv') {
                        mediaTypes.video = true;
                    }
                }
                DEBUG('Incoming call from %s with media types: %o', message.originator.uri, mediaTypes);
                this.emit('incomingCall', call, mediaTypes);
                break;
            case 'missed-session':
                data.originator = new utils.Identity(message.originator.uri, message.originator.display_name);
                this.emit('missedCall', data);
                break;
            case 'conference-invite':
                data.originator = new utils.Identity(message.originator.uri, message.originator.display_name);
                data.room = message.room;
                data.id = message.session_id;
                this.emit('conferenceInvite', data);
                break;
            case 'message':
                DEBUG('Incoming message from %s: %o', message.sender.uri, message);
                const mappedMessage = new Message(
                    message,
                    new utils.Identity(message.sender.uri, message.sender.display_name),
                    'received'
                );
                if (message.disposition_notification && message.disposition_notification.indexOf('positive-delivery') !== -1) {
                    this.sendDispositionNotification(message.sender.uri, message.message_id, message.timestamp, 'delivered')
                }
                this._messages.set(mappedMessage.id, mappedMessage);
                this.emit('message', mappedMessage);
                break;
            case 'disposition-notification':
                const outgoingMessage = this._messages.get(message.message_id);
                if (outgoingMessage) {
                    outgoingMessage._setState(message.state);
                }
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
