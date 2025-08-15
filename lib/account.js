'use strict';

import debug from 'debug';
import md5 from 'blueimp-md5';
import transform from 'sdp-transform';
import utils from './utils';

import { EventEmitter } from 'events';
import { Call } from './call';
import { ConferenceCall } from './conference';
import { Message } from './message';
import { PGP } from './pgp';

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
            this._password = md5(username + ':' + (options.realm || domain) + ':' + options.password);
        }
        this._incomingHeaderPrefixes = options.incomingHeaderPrefixes;
        this._pgp = null;
        this._connection = connection;
        this._registrationState = null;
        this._calls = new Map();
        this._confCalls = new Map();
        this._messages = new Map();
        this._pendingMessageDecryption = new Set();
        this._delayedDispositionMessages = new Map();
        // this._fetchAddressbook()
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

    get incomingHeaderPrefixes() {
        return this._incomingHeaderPrefixes;
    }

    get registrationState() {
        return this._registrationState;
    }

    get messages() {
        return Array.from(this._messages.values());
    }

    get pgp() {
        return this._pgp;
    }

    _fetchAddressbook() {
        const req = {
            sylkrtc: 'account-fetch-addressbook',
            account: this._id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Addressbook fetch error: %s', error);
            }
        });
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
                const data = { reason: error.toString() };
                this._registrationState = newState;
                this.emit('registrationStateChanged', oldState, newState, data);
            }
        });
    }

    unregister() {
        const req = {
            sylkrtc: 'account-unregister',
            account: this._id
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

    call(uri, options = {}) {
        const callObj = new Call(this);
        callObj._initOutgoing(uri, options);
        this._calls.set(callObj.id, callObj);
        this.emit('outgoingCall', callObj);
        return callObj;
    }

    joinConference(uri, options = {}) {
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

    addPGPKeys(keys) {
        this._pgp = new PGP(keys, this._connection);
        // Wipe received messages, they could be encrypted. After this you should always fetch from the server....
        if (this._messages.size > 0) {
            this._messages.clear();
        }
    }

    generatePGPKeys(cb = null) {
        if (this._pgp === null) {
            this._pgp = new PGP({}, this._connection);
        }
        this._pgp.generatePGPKeys((result) => {
            this.emit('privateKeysGenerated', result);
            cb(result);
        });
    }

    checkIfKeyExists(cb = null) {
        this._connection.lookupPublicKey(this._id);
        new Promise((resolve, reject) => {
            this._connection.once('publicKey', (message) => {
                if (message.publicKey) {
                    message.publicKey = message.publicKey.trim();
                }
                resolve(message.publicKey);
            });
        }).then(publicKey => cb(publicKey));
    }

    decryptKeyImport(message, password, cb = null) {
        if (this._pgp === null) {
            this._pgp = new PGP({}, this._connection);
        }
        this._pgp.decryptKeyImport(message, password, (result) => {
            if (!this._pgp._privateKey && !this._pgp_publicKey) {
                this._pgp = null;
            }
            cb(result);
        });
    }

    exportPrivateKey(password) {
        if (this._pgp === null) {
            return;
        }
        this._pgp.exportKeys(password).then(result => {
            if (result.didEncrypt) {
                this.sendMessage(this._id, result.message, 'text/pgp-private-key');
            }
        });
    }

    encryptFile(uri, file) {
        if (this._pgp === null) {
            return;
        }
        return this._pgp.encryptFile(uri, file);
    }

    decryptFile(file, filename, filetype) {
        if (this._pgp === null) {
            return;
        }
        return this._pgp.decryptFile(file, filename, filetype);
    }

    sendMessage(uri, message, contentType = 'text/plain', options = {}, cb = null) {
        const outgoingMessage = new Message({
            account: uri,
            content: message,
            contentType,
            timestamp: options.timestamp || new Date().toISOString(),
            type: 'normal'
        }, new utils.Identity(this._id, this._displayName), 'pending');

        if (contentType !== 'text/pgp-private-key' && contentType !== 'text/pgp-public-key') {
            this._messages.set(outgoingMessage.id, outgoingMessage);
        }

        (async () => {
            let result = {};
            if (this._pgp !== null && contentType !== 'text/pgp-private-key' && contentType !== 'text/pgp-public-key') {
                result = await this._pgp.encryptMessage(uri, outgoingMessage);
                if (result.didEncrypt) {
                    outgoingMessage._isSecure = true;
                }
            }
            const req = {
                sylkrtc: 'account-message',
                account: this._id,
                uri: uri,
                message_id: outgoingMessage.id,
                content: result.message || message,
                content_type: outgoingMessage.contentType,
                timestamp: outgoingMessage.timestamp
            };
            if (contentType !== 'text/pgp-private-key' && contentType !== 'text/pgp-public-key') {
                this.emit('sendingMessage', outgoingMessage);
            }
            DEBUG('Sending message: %o', outgoingMessage);
            this._sendRequest(req, (error) => {
                if (error) {
                    DEBUG('Error sending message: %s', error);
                    outgoingMessage._setState('failed');
                }
                if (cb) {
                    cb(error);
                }
            });
        })();
        return outgoingMessage;
    }

    sendDispositionNotification(uri, id, timestamp, state, cb = null) {
        const req = {
            sylkrtc: 'account-disposition-notification',
            account: this._id,
            uri: uri,
            message_id: id,
            state,
            timestamp
        };
        DEBUG('Sending disposition notification: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending disposition notification: %s', error);
            } else {
                const incomingMessage = this._messages.get(id);
                if (incomingMessage) {
                    incomingMessage._setDispositionState(state);
                }
            }
            this.emit('sendingDispositionNotification', id, state, error);
            if (cb) {
                cb(error);
            }
        });
    }

    syncConversations(id = null, cb = null) {
        const req = {
            sylkrtc: 'account-sync-conversations',
            account: this._id,
            message_id: id
        };
        DEBUG('Sending replay journal: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending sync request: %s', error);
            }
            if (cb) {
                cb(error);
            }
        });
    }

    markConversationRead(contact) {
        const req = {
            sylkrtc: 'account-mark-conversation-read',
            account: this._id,
            contact: contact
        };
        DEBUG('Sending markConversationRead: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending markConversationRead request: %s', error);
            }
        });
        this._readConversation(contact);
    }

    removeMessage(message, cb = null) {
        this._removeMessage(message.id);
        let contact = message.receiver;
        if (message.state === 'received') {
            contact = message.sender.uri;
        }
        const req = {
            sylkrtc: 'account-remove-message',
            account: this._id,
            message_id: message.id,
            contact: contact
        };
        DEBUG('Sending remove message: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending remove message: %s', error);
            }
            if (cb) {
                cb(error);
            }
        });
    }

    removeConversation(uri, cb = null) {
        this._removeConversation(uri);
        const req = {
            sylkrtc: 'account-remove-conversation',
            account: this._id,
            contact: uri
        };
        DEBUG('Sending remove conversation: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending remove conversation: %s', error);
            }
            if (cb) {
                cb(error);
            }
        });
    }

   _updateAddressbook(action, type, data, cb=null) {
        const req = {
            sylkrtc: 'account-update-addressbook',
            account: this._id,
            action: action,
            type: type,
            data: data
        };
        DEBUG('Sending update addressbook: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending update addressbook: %s', error);
            }
            if (cb) {
                cb(error);
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
                call._initIncoming(message.session, message.originator, message.sdp, message.call_id, message.headers);
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
                const incomingMessage = this._messages.get(message.message_id);
                if (!incomingMessage) {
                    (async () => {
                        if (message.content.includes(`-----BEGIN PGP MESSAGE-----`) &&
                            message.content.trim().endsWith(`-----END PGP MESSAGE-----`) &&
                            message.content_type !== 'text/pgp-private-key'
                        ) {
                            if (this._pgp !== null) {
                                message = await this._pgp.decryptMessage(message);
                                if (message.didDecrypt) {
                                    message.isSecure = true;
                                } else {
                                    this._sendError(message);
                                    // Decryption failed, add failure disposition
                                    return;
                                }
                            }
                        }

                        if (message.content_type === 'text/pgp-private-key') {
                            DEBUG('Skipping message');
                            return;
                        }
                        if (message.content_type === 'application/sylk-contact-update') {
                            DEBUG('Skipping message');
                            return;
                        }

                        const mappedMessage = new Message(
                            message,
                            new utils.Identity(message.sender.uri, message.sender.display_name),
                            'received'
                        );

                        if (message.content_type === 'text/pgp-public-key') {
                            if (this._pgp !== null) {
                                this._pgp.addPublicPGPKeys({ [message.sender.uri]: mappedMessage.content });
                                return;
                            }
                        }
                        this._messages.set(mappedMessage.id, mappedMessage);
                        this.emit('incomingMessage', mappedMessage);

                        if (message.disposition_notification &&
                            message.disposition_notification.indexOf('positive-delivery') !== -1
                        ) {
                            this.sendDispositionNotification(
                                message.sender.uri,
                                message.message_id,
                                message.timestamp,
                                'delivered'
                            );
                        }
                    })();
                }
                break;
            case 'disposition-notification':
                const outgoingMessage = this._messages.get(message.message_id);
                if (outgoingMessage) {
                    if (outgoingMessage.state === 'displayed') {
                        break;
                    }
                    outgoingMessage._setState(message.state);
                }
                // Delay state changes if message is being decrypted
                if (this._pendingMessageDecryption.has(message.message_id)) {
                    const delayedMessage = this._delayedDispositionMessages.get(message.message_id) || [];
                    delayedMessage.push(message);
                    this._delayedDispositionMessages.set(message.message_id, delayedMessage);
                } else {
                    const { reason, code } = message;
                    this.emit('messageStateChanged', message.message_id, message.state, { reason, code });
                }
                break;
            case 'sync-conversations':
                const specialContentTypes = new Set(['application/sylk-message-remove', 'message/imdn']);
                this.emit('processingFetchedMessages');
                (async () => {
                    if (this._pgp !== null) {
                        let progress = 1;
                        const items = message.messages.length;
                        if (items >= 75) {
                            this.emit('processingFetchedMessages', progress);
                        }
                        for (const [idx, messageEntry] of message.messages.entries()) {
                            if (messageEntry.content.includes(`-----BEGIN PGP MESSAGE-----`) &&
                                messageEntry.content.trim().endsWith(`-----END PGP MESSAGE-----`)
                            ) {
                                await this._pgp.decryptMessage(messageEntry);
                            }
                            if (items >= 100) {
                                const tempProgress = Math.round((100 / items) * idx);
                                if (tempProgress !== progress && tempProgress % 5 === 0) {
                                    progress = tempProgress;
                                    this.emit('processingFetchedMessages', progress);
                                }
                            }
                        }
                    }

                    const messageList = message.messages.filter((message) => {
                        if (message.content_type === 'text/pgp-public-key') {
                            DEBUG('Public key found, adding: %s', message.content);
                            if (this._pgp !== null) {
                                this._pgp.addPublicPGPKeys({ [message.sender.uri]: message.content });
                            }
                            return false;
                        }
                        if (message.didDecrypt === false) {
                            this._sendError(message);
                            // send disposition error
                            return false;
                        }
                        if (message.content_type === 'application/sylk-contact-update') {
                            return false;
                        }
                        return true;
                    }).map((message) => {
                        if (specialContentTypes.has(message.content_type)) {
                            message.content = JSON.parse(message.content);
                        }

                        message.isSecure = message.didDecrypt;

                        if (message.direction === 'outgoing') {
                            message.account = message.contact;
                            return new Message(message, new utils.Identity(this._id, this._displayName), message.state);
                        }
                        message.account = this._id;
                        return new Message(message, new utils.Identity(message.contact, ''), message.state);
                    });
                    this.emit('syncConversations', messageList);
                })();
                break;
            case 'sync':
                if (message.type === 'message') {
                    let content = message.content;
                    switch (message.action) {
                        case 'remove':
                            const existingMessage = this._messages.get(content.message_id);
                            if (existingMessage) {
                                this.emit('removeMessage', existingMessage);
                                this._removeMessage(message.content.message_id);
                                break;
                            }
                            if (content.direction === 'outgoing') {
                                content.account = content.contact;
                                this.emit('removeMessage', new Message(content, new utils.Identity(this._id, ''), ''));
                                break;
                            }
                            content.account = this._id;
                            this.emit('removeMessage', new Message(content, new utils.Identity(content.contact, ''), ''));
                            break;
                        case 'add':
                            content.account = content.uri;
                            (async () => {
                                if (content.content.includes(`-----BEGIN PGP MESSAGE-----`) &&
                                    content.content.trim().endsWith(`-----END PGP MESSAGE-----`) &&
                                    content.content_type !== 'text/pgp-private-key'
                                ) {
                                    if (this._pgp !== null) {
                                        this._pendingMessageDecryption.add(content.message_id);
                                        content = await this._pgp.decryptMessage(content);
                                        this._pendingMessageDecryption.delete(content.message_id);
                                        if (content.didDecrypt) {
                                            content.isSecure = true;
                                        } else {
                                            return;
                                        }
                                    }
                                }

                                const outgoingMessage = new Message(
                                    content,
                                    new utils.Identity(this._id, this._displayName),
                                    content.account == this._id || (content.server_generated && content.server_generated == true) ? 'accepted' : 'pending'
                                );
                                if (content.content_type === 'text/pgp-public-key' ||
                                    content.content_type === 'application/sylk-contact-update') {
                                    return;
                                }

                                if (content.content_type !== 'text/pgp-private-key') {
                                    this._messages.set(outgoingMessage.id, outgoingMessage);
                                    this.emit('sendingMessage', outgoingMessage);
                                }
                                this.emit('outgoingMessage', outgoingMessage);

                                const delayedMessages = this._delayedDispositionMessages.get(outgoingMessage.id);
                                if (delayedMessages) {
                                    setImmediate(() => {
                                        while (delayedMessages.length) {
                                            const delayedMessage = delayedMessages.shift();
                                            this._handleEvent(delayedMessage);
                                        }
                                        this._delayedDispositionMessages.delete(outgoingMessage.id);
                                    });
                                }
                            })();
                            break;
                        default:
                            break;
                    }
                }
                if (message.type === 'conversation') {
                    switch (message.action) {
                        case 'remove':
                            this._removeConversation(message.content.contact);
                            this.emit('removeConversation', message.content.contact);
                            break;
                        case 'read':
                            this._readConversation(message.content.contact);
                            this.emit('readConversation', message.content.contact);
                            break;
                        default:
                            break;
                    }
                }
                break;
            case 'addressbook-fetched':
                this._connection._addressbook._load(message);
            case 'addressbook-updated':
                this._connection._addressbook._update(message);
            default:
                break;
        }
    }

    _sendError(message) {
        const disposition = message.disposition_notification || message.disposition || false;
        if (disposition && disposition.indexOf('display') !== -1) {
            this.sendDispositionNotification(
                message.sender ? message.sender.uri : message.contact,
                message.message_id,
                message.timestamp,
                'error'
            );
        }
    }

    _removeMessage(id) {
        this._messages.delete(id);
    }

    _readConversation(uri) {
        for (const [id, message] of this._messages.entries()) {
            if (message.state === 'received' && message.sender.uri === uri && message.dispositionState !== 'displayed') {
                message._setDispositionState('displayed');
            }
        }
    }

    _removeConversation(uri) {
        for (const [id, message] of this._messages.entries()) {
            if (message.state === 'received' && message.sender.uri === uri) {
                this._messages.delete(id);
            } else if (message.receiver === uri) {
                this._messages.delete(id);
            }
        }
    }

    _sendRequest(req, cb) {
        this._connection._sendRequest(req, cb);
    }

}


export { Account };
