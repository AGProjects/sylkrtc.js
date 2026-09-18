'use strict';

import debug from 'debug';
import md5 from 'blueimp-md5';
import { v4 as uuidv4 } from 'uuid';
import transform from 'sdp-transform';
import utils from './utils';
import { chunkPlaintextForSend, ChunkReassembler } from './chunking';

import { EventEmitter } from 'events';
import { buf2hex, sha256 } from './zrtp-crypto';
import { ENCRYPTION_MODES, ENCRYPTION_MODE_DEFAULT } from './zrtp';

import { Call } from './call';
import { ConferenceCall } from './conference';
import { Message } from './message';
import { PGP } from './pgp';
import * as locationSharing from './locationSharing';

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
        this._addressbookFetched = false;
        this._chunkReassembler = new ChunkReassembler();
        this._localDeviceId = options.deviceId || null;
        this._zrtpRs1Store = new Map();  // uri -> Map<peerDeviceId, Uint8Array>
        this._zrtpRs1Legacy = new Map(); // uri -> Uint8Array (backward compat)
        this._encryptionMode = 'sdes';

        this.encryptionMode = this.zrtpSupported && ENCRYPTION_MODES.includes(options.encryptionMode)
            ? options.encryptionMode
            : ENCRYPTION_MODE_DEFAULT;
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

    get addressbookFetched() {
        return this._addressbookFetched;
    }

    get localDeviceId() {
        return this._localDeviceId;
    }

    get encryptionMode() {
        return this._encryptionMode;
    }

    set encryptionMode(mode) {
        if (!this.zrtpSupported) {
            DEBUG('zRTP not supported falling back to sdes')
            this._encryptionMode = 'sdes';
            return;
        }

        if (!ENCRYPTION_MODES.includes(mode)) {
            throw new Error(`Invalid encryption mode: ${mode}`);
        }

        this._encryptionMode = mode;
        this.emit('encryptionModeChanged', mode);
    }

    get zrtpSupported() {
        return typeof RTCRtpSender !== 'undefined' && (
            typeof RTCRtpSender.prototype.createEncodedStreams === 'function' ||
            typeof RTCRtpScriptTransform !== 'undefined'
        );
    }

    get zrtpEnabled() {
        return this._encryptionMode !== 'sdes';
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
        const metadata = utils.serializeMessageMetadata(options.metadata);
        const outgoingMessage = new Message({
            account: uri,
            content: message,
            contentType,
            timestamp: options.timestamp || new Date().toISOString(),
            type: 'normal',
            ...( options.id && {message_id: options.id}),
            ...(metadata !== null && {metadata})
        }, new utils.Identity(this._id, this._displayName), 'pending');

        if (contentType !== 'text/pgp-private-key' && contentType !== 'text/pgp-public-key') {
            this._messages.set(outgoingMessage.id, outgoingMessage);
        }
        (async () => {
            const pieces = chunkPlaintextForSend(message, contentType);
            DEBUG('chunkPlaintextForSend result: %o, contentType: %s, byteLen: %d', pieces && pieces.length, contentType, message ? message.length : 0);
            if (pieces) {
                await this._sendChunked(uri, outgoingMessage, pieces, cb);
                return outgoingMessage;
            }
            let result = {};
            if (locationSharing.isLocationSharing(contentType)) {
                result = await locationSharing.encryptEnvelopeForSend(message, this._pgp, uri, outgoingMessage.id) || {};
            } else if (this._pgp !== null && !options.cleartext && contentType !== 'text/pgp-private-key' && contentType !== 'text/pgp-public-key') {
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
                content: result.content !== undefined ? result.content : (result.message || message),
                content_type: outgoingMessage.contentType,
                timestamp: outgoingMessage.timestamp,
                ...(result.metadata
                    ? {metadata: utils.serializeMessageMetadata(result.metadata)}
                    : (metadata !== null && {metadata}))
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
        const ids = (message.chunkIds && message.chunkIds.length > 0) ? message.chunkIds : [message.id];
        ids.forEach((message_id, i) => {
            const req = {
                sylkrtc: 'account-remove-message',
                account: this._id,
                message_id: message_id,
                contact: contact
            };
            DEBUG('Sending remove message: %o', req);
            this._sendRequest(req, (error) => {
                if (error) {
                    DEBUG('Error sending remove message: %s', error);
                }
                if (cb && i === ids.length - 1) {
                    cb(error);
                }
            });
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
    /** Generates a new random device id if one isn't already set/loaded,
     *  and emits 'deviceIdGenerated' so the app can persist it. Mirrors
     *  generatePGPKeys()'s "make one, hand it back for storage" shape.
     *  Returns the id synchronously; cb is optional, for callers that
     *  prefer the callback style used elsewhere in this class. */
    generateDeviceId(cb = null) {
        if (this._localDeviceId) {
            if (cb) cb(this._localDeviceId);
            return this._localDeviceId;
        }
        const id = uuidv4();
        this._localDeviceId = id;
        this.emit('deviceIdGenerated', id);
        if (cb) cb(id);
        return id;
    }

    /** Loads a previously persisted device id. Call this at startup,
     *  before register()/any calls, if one was already generated and
     *  saved in an earlier session — mirrors addPGPKeys() for loading
     *  previously-generated key material. */
    loadDeviceId(id) {
        if (!id) {
            throw new Error('loadDeviceId requires a non-empty id');
        }
        this._localDeviceId = id;
    }

    getRs1ForDevice(uri, deviceId) {
        const perDevice = this._zrtpRs1Store.get(uri);
        return (deviceId && perDevice && perDevice.get(deviceId)) || null;
    }

    getLegacyRs1(uri) {
        return this._zrtpRs1Legacy.get(uri) || null;
    }

    // "Our" rs1 for a given peer once we know which of their devices
    // we're talking to; falls back to the legacy single slot.
    resolveLocalRs1(uri, peerDeviceId) {
        return this.getRs1ForDevice(uri, peerDeviceId) || this.getLegacyRs1(uri);
    }

    setRs1ForDevice(uri, deviceId, rs1) {
        if (deviceId) {
            let perDevice = this._zrtpRs1Store.get(uri);
            if (!perDevice) {
                perDevice = new Map();
                this._zrtpRs1Store.set(uri, perDevice);
            }
            perDevice.set(deviceId, rs1);
        }
        // Mirror into the legacy slot so v2-only peers that never send
        // device_id still get continuity.
        this._zrtpRs1Legacy.set(uri, rs1);
    }

    clearRs1ForDevice(uri, deviceId) {
        const perDevice = this._zrtpRs1Store.get(uri);
        if (perDevice) perDevice.delete(deviceId);
        this._zrtpRs1Legacy.delete(uri);
    }

    // Built at probe-send time: one {device_id, rs_id_hex} entry per remote
    // device we've previously established a pairwise rs1 with for this uri.
    async getRs1Candidates(uri) {
        const perDevice = this._zrtpRs1Store.get(uri);
        if (!perDevice) return [];
        return Promise.all(
            Array.from(perDevice.entries()).map(async ([deviceId, rs1]) => ({
                device_id: deviceId,
                rs_id_hex: buf2hex(await sha256(rs1)).slice(0, 16)
            }))
        );
    }

    // Bulk-load previously persisted rs1 data at startup, before any calls
    // are made/answered. entries: [{ uri, deviceId, rs1Hex }, ...]
    loadRs1(entries) {
        for (const { uri, deviceId, rs1 } of entries) {
            this.setRs1ForDevice(uri, deviceId, new Uint8Array(rs1));
        }
    }

    // Private API

    _fetchAddressbook() {
        const req = {
            sylkrtc: 'account-fetch-addressbook',
            account: this._id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Addressbook fetch error: %s', error);
            } else {
                this._addressbookFetched = true;
            }
        });
    }

    _updateAddressbook(action, type, data) {
        const req = {
            sylkrtc: 'account-update-addressbook',
            account: this._id,
            action: action,
            type: type,
            data: data
        };
        DEBUG('Sending update addressbook: %o', req);
        return new Promise((resolve, reject) => {
            this._sendRequest(req, (error) => {
                if (error) {
                    DEBUG('Error sending update addressbook: %s', error);
                    if (action !== 'add') {
                        this._fetchAddressbook();
                    }
                    reject(error);
                } else {
                    resolve();
                }
            })
        });
    }

    async _sendChunked(uri, outgoingMessage, pieces, cb) {
        this.emit('sendingMessage', outgoingMessage);
        let anyFailed = false;
        for (let i = 0; i < pieces.length; i++) {
            let result = {};
            if (this._pgp !== null) {
                result = await this._pgp.encryptMessage(uri, { ...outgoingMessage, content: pieces[i] });
            }
            const req = {
                sylkrtc: 'account-message',
                account: this._id,
                uri: uri,
                message_id: i === 0 ? outgoingMessage.id : `${outgoingMessage.id}-${i}`,
                content: result.message || pieces[i],
                content_type: outgoingMessage.contentType,
                timestamp: outgoingMessage.timestamp
            };
            DEBUG('Sending message piece %d/%d: %o', i + 1, pieces.length, req);
            await new Promise((resolve) => {
                this._sendRequest(req, (error) => {
                    if (error) {
                        DEBUG('Error sending message piece %d: %s', i, error);
                        anyFailed = true;
                    }
                    resolve();
                });
            });
        }
        outgoingMessage._chunkIds = pieces.map((_, i) => i === 0 ? outgoingMessage.id : `${outgoingMessage.id}-${i}`);
        if (anyFailed) outgoingMessage._setState('failed');
        if (cb) cb(anyFailed ? new Error('one or more chunks failed to send') : null);
    }

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
                if (newState === 'registered' && !this._addressbookFetched) {
                    this._fetchAddressbook();
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
                        if (!locationSharing.isLocationSharing(message.content_type) &&
                            typeof message.content === 'string' &&
                            message.content.includes(`-----BEGIN PGP MESSAGE-----`) &&
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

                        if (locationSharing.isLocationSharing(message.content_type)) {
                            await locationSharing.decryptInPlace(message, this._pgp);
                            if (message.didDecrypt === false) {
                                if (!locationSharing.shouldSuppressErrorOnFailedDecrypt(message.content_type)) {
                                    this._sendError(message);
                                }
                                return;
                            }
                            message.isSecure = true;
                        }

                        if (message.content_type === 'text/pgp-private-key') {
                            DEBUG('Skipping message');
                            return;
                        }
                        if (message.content_type === 'application/sylk-contact-update') {
                            DEBUG('Skipping message');
                            return;
                        }

                        if (message.content_type === 'text/plain' || message.content_type === 'text/html') {
                            const reassembly = this._chunkReassembler.add(message.sender.uri, message.content, message.message_id);
                            if (reassembly) {
                                if (!reassembly.done) return;
                                message = { ...message, content: reassembly.body, chunkIds: reassembly.chunkIds };
                            }
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
                            if (locationSharing.isLocationSharing(messageEntry.content_type)) {
                                await locationSharing.decryptInPlace(messageEntry, this._pgp);
                            } else if (messageEntry.content.includes(`-----BEGIN PGP MESSAGE-----`) &&
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
                    const journalReassembler = new ChunkReassembler();
                    const reassembledMessages = [];
                    for (const entry of message.messages) {
                        if (entry.content_type !== 'text/plain' && entry.content_type !== 'text/html') {
                            reassembledMessages.push(entry);
                            continue;
                        }
                        const sender = entry.sender ? entry.sender.uri : entry.contact;
                        const reassembly = journalReassembler.add(sender, entry.content, entry.message_id);
                        if (!reassembly) {
                            reassembledMessages.push(entry);
                        } else if (reassembly.done) {
                            reassembledMessages.push({ ...entry, content: reassembly.body, chunkIds: reassembly.chunkIds });
                        }
                        // else: piece buffered, wait for the rest
                    }

                    const messageList = reassembledMessages.filter((message) => {
                        if (message.content_type === 'text/pgp-public-key') {
                            DEBUG('Public key found, adding: %s', message.content);
                            if (this._pgp !== null) {
                                this._pgp.addPublicPGPKeys({ [message.sender.uri]: message.content });
                            }
                            return false;
                        }
                        if (message.didDecrypt === false) {
                            // send disposition error
                            if (!locationSharing.shouldSuppressErrorOnFailedDecrypt(message.content_type)) {
                                this._sendError(message);
                            }
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
                                if (locationSharing.isLocationSharing(content.content_type)) {
                                    await locationSharing.decryptInPlace(content, this._pgp);
                                    if (content.didDecrypt !== false) content.isSecure = true;
                                }

                                if (!locationSharing.isLocationSharing(content.content_type) &&
                                    typeof content.content === 'string' &&
                                    content.content.includes(`-----BEGIN PGP MESSAGE-----`) &&
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

                                if (content.content_type === 'text/plain' || content.content_type === 'text/html') {
                                    const reassembly = this._chunkReassembler.add(content.contact, content.content, content.message_id);
                                    if (reassembly) {
                                        if (!reassembly.done) return;
                                        content = { ...content, content: reassembly.body, chunkIds: reassembly.chunkIds };
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
                this._connection._addressbook._load(this.id, message.addressbook);
                break;
            case 'addressbook-updated':
                this._connection._addressbook._update(this.id, message);
                break;
            case 'addressbook-update-failed':
                this._connection._addressbook._updateFailed(message);
                this._fetchAddressbook();
                break;
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
