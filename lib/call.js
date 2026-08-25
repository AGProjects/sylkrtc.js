'use strict';

import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

import { Statistics } from './statistics';
import { Message } from './message';
import { ScreenSharingManager } from './screenSharingManager';
import { CapabilitiesManager } from './capabilitiesManager';
import utils from './utils';

const DEBUG = debug('sylkrtc:Call');


class Call extends EventEmitter {
    constructor(account) {
        super();
        this._account = account;
        this._id = null;
        this._callId = null;
        this._direction = null;
        this._pc = null;
        this._state = null;
        this._terminated = false;
        this._incomingSdp = null;
        this._remoteMediaDirections = {};
        this._localIdentity = new utils.Identity(account.id, account.displayName);
        this._remoteIdentity = null;
        this._remoteStreams = new MediaStream();
        this._localStreams = new MediaStream();
        this._previousTrack = null;
        this._sharingScreen = false;
        this._dtmfSender = null;
        this._delay_established = false;  // set to true when we need to delay posting the state change to 'established'
        this._setup_in_progress = false;  // set while we set the remote description and setup the peer copnnection
        this._statistics = new Statistics();
        this._headers = [];
        this._messages = new Map();

        this._capabilities = new CapabilitiesManager(this);
        this._capabilities.on('changed', (peer) => this.emit('capabilitiesChanged', peer));

        this._screenSharing = new ScreenSharingManager(this);
        this._screenSharing.on('pointer', (data) => this.emit('pointer', data));
        this._screenSharing.on('pointerAck', (context) => this.emit('pointerAck', context));
        this._screenSharing.on('screenShareRequest', (data) => this.emit('screenShareRequest', data));
        this._screenSharing.on('screenShareRequestResolved', (data) => this.emit('screenShareRequestResolved', data));
        this._screenSharing.on('remoteScreenSharingChanged', (data) => this.emit('remoteScreenSharingChanged', data));

        this._upgrading = false;
        this._pendingVideoAddition = null;

        // bind some handlers to this instance
        this._onDtmf = this._onDtmf.bind(this);
    }

    get account() {
        return this._account;
    }

    get id() {
        return this._id;
    }

    get callId() {
        return this._callId;
    }

    get headers() {
        return this._headers;
    }

    get statistics() {
        return this._statistics;
    }

    get sharingScreen() {
        return this._sharingScreen;
    }

    get direction() {
        return this._direction;
    }

    get state() {
        return this._state;
    }

    get localIdentity() {
        return this._localIdentity;
    }

    get remoteIdentity() {
        return this._remoteIdentity;
    }

    get remoteMediaDirections() {
        return this._remoteMediaDirections;
    }

    /** Tokens this side declared, or null if none. */
    get localCapabilities() {
        return this._capabilities.local;
    }

    /** Tokens the peer advertised. */
    get peerCapabilities() {
        return this._capabilities.peer;
    }

    peerSupports(capability) {
        return this._capabilities.peerSupports(capability);
    }

    /** Declare what this build can do; sent immediately if already
     *  established, otherwise on the next 'established'. */
    setLocalCapabilities(capabilities) {
        this._capabilities.setLocal(capabilities);
    }

    // -- screen sharing / remote pointer -------------------------------

    get remoteScreenSharing() {
        return this._screenSharing.remoteScreenSharing;
    }

    get remoteScreenSharePointable() {
        return this._screenSharing.remoteScreenSharePointable;
    }

    get remoteInApp() {
        return this._screenSharing.remoteInApp;
    }

    get canPointAtRemoteScreen() {
        return this._screenSharing.canPointAtRemoteScreen;
    }

    /** Set before startScreensharing(); fixed for that share's lifetime. */
    setScreenSharePointable(pointable) {
        this._screenSharing.setScreenSharePointable(pointable);
    }

    /** Ask the peer to share THEIR screen. Resolves via
     *  'screenShareRequestResolved', including on timeout. */
    requestScreenShare(ttl) {
        return this._screenSharing.requestScreenShare(ttl);
    }

    acceptScreenShareRequest(requestId) {
        this._screenSharing.acceptScreenShareRequest(requestId);
    }

    rejectScreenShareRequest(requestId) {
        this._screenSharing.rejectScreenShareRequest(requestId);
    }

    /** Send a guide point at a normalized (0..1) position. `context` is
     *  handed back with 'pointerAck'. */
    sendPointer(x, y, context=null) {
        return this._screenSharing.sendPointer(x, y, context);
    }

    ackPointer(t) {
        this._screenSharing.ackPointer(t);
    }

    setPointerVisibility(inApp) {
        this._screenSharing.setPointerVisibility(inApp);
    }

    getLocalStreams() {
        if (this._pc !== null) {
            if (this._pc.getSenders) {
                this._pc.getSenders().forEach((e) => {
                    if (e.track !== null) {
                        if (e.track.readyState !== "ended") {
                            this._localStreams.addTrack(e.track);
                        } else {
                            this._localStreams.removeTrack(e.track);
                        }
                    }
                });
                return [this._localStreams];
            } else {
                return this._pc.getLocalStreams();
            }
        } else {
            return [];
        }
    }

    getRemoteStreams() {
        if (this._pc !== null) {
           if (this._pc.getReceivers) {
              this._pc.getReceivers().forEach((e) => {
                  if (e.track.readyState !== "ended") {
                    this._remoteStreams.addTrack(e.track);
                  }
              });
              return [this._remoteStreams];
          } else {
                return this._pc.getRemoteStreams();
          }
        } else {
            return [];
        }
    }

    getSenders() {
        if (this._pc !== null) {
           return this._pc.getSenders();
        } else {
            return [];
        }
    }

    getReceivers() {
        if (this._pc !== null) {
           return this._pc.getReceivers();
        } else {
            return [];
        }
    }

    answer(options = {}) {
        if (this._state !== 'incoming') {
            throw new Error('Call is not in the incoming state: ' + this._state);
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        const pcConfig = options.pcConfig || {iceServers:[]};
        const answerOptions = options.answerOptions;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        this._pc.addStream(options.localStream);
        this.emit('localStreamAdded', options.localStream);
        this._pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: this._incomingSdp}))
            // success
            .then(() => {
                utils.createLocalSdp(this._pc, 'answer', answerOptions)
                    .then((sdp) => {
                        DEBUG('Local SDP: %s', sdp);
                        this._sendAnswer(sdp);
                    })
                    .catch((reason) => {
                        DEBUG(reason);
                        this.terminate();
                    });
            })
            // failure
            .catch((error) => {
                DEBUG('Error setting remote description: %s', error);
                this.terminate();
            });
    }

    addVideo(options = {}) {
        if (this._state !== 'established' && this._state !== 'accepted') {
            throw new Error('Call is not active: ' + this._state);
        }
        if (!options.localStream) {
            throw new Error('Missing localStream');
        }
        if (this._upgrading) {
            throw new Error('A renegotiation is already in progress');
        }
        if (this._pc === null || this._pc.signalingState !== 'stable') {
            throw new Error('Peer connection is not stable: ' + (this._pc && this._pc.signalingState));
        }
        this._upgrading = true;

        const addedTracks = [];
        for (const track of options.localStream.getVideoTracks()) {
            const sender = this._pc.addTrack(track, options.localStream);
            addedTracks.push({ sender, track });
            this._localStreams.addTrack(track);
        }
        if (addedTracks.length === 0) {
            this._upgrading = false;
            throw new Error('localStream contains no video tracks');
        }
        this._pendingVideoAddition = addedTracks;

        utils.createLocalSdp(this._pc, 'offer')
            .then((sdp) => {
                DEBUG('Local update offer SDP: %s', sdp);
                this._sendUpdate(sdp);
            })
            .catch((reason) => {
                DEBUG('Error creating update offer: %s', reason);
                this._rollbackPendingVideo();
                this._upgrading = false;
                this.emit('updateFailed', reason);
            });

        this.emit('localStreamAdded', options.localStream);
    }

    answerUpdate(options = {}) {
        if (!this._upgrading) {
            throw new Error('No update in progress');
        }
        if (this._pc === null || this._pc.signalingState !== 'have-remote-offer') {
            throw new Error('Peer connection not in have-remote-offer: ' + (this._pc && this._pc.signalingState));
        }

        const addedTracks = [];
        if (options.localStream) {
            for (const track of options.localStream.getVideoTracks()) {
                const sender = this._pc.addTrack(track, options.localStream);
                addedTracks.push({ sender, track });
                this._localStreams.addTrack(track);
            }
            this.emit('localStreamAdded', options.localStream);
        }
        this._pendingVideoAddition = addedTracks;

        utils.createLocalSdp(this._pc, 'answer')
            .then((sdp) => {
                DEBUG('Local update answer SDP: %s', sdp);
                this._sendUpdate(sdp, () => {
                    this._upgrading = false;
                    this._pendingVideoAddition = null;
                    this.emit('mediaUpdated', {
                        hasLocalVideo: this._localStreams.getVideoTracks().length > 0,
                        hasRemoteVideo: (this._remoteMediaDirections.video || []).some(
                            d => d && d !== 'inactive'),
                    });
                });
            })
            .catch((reason) => {
                DEBUG('Error creating update answer: %s', reason);
                this._rollbackPendingVideo();
                this._upgrading = false;
                this.emit('updateFailed', reason);
            });
    }


    startScreensharing(newTrack) {
        let oldTrack = this.getLocalStreams()[0].getVideoTracks()[0];
        this.replaceTrack(oldTrack, newTrack, true, (value) => {
            this._sharingScreen = value;
            if (value) {
                this._screenSharing.announce(true);
            }
        });
    }

    stopScreensharing() {
        let oldTrack = this.getLocalStreams()[0].getVideoTracks()[0];
        this.replaceTrack(oldTrack, this._previousTrack);
        this._sharingScreen = false;
        this._screenSharing.announce(false);
    }

    replaceTrack(oldTrack, newTrack, keep=false, cb=null) {
        let sender;
        for (sender of this._pc.getSenders()) {
            if (sender.track === oldTrack) {
                break;
            }
        }

        sender.replaceTrack(newTrack)
            .then(() => {
                if (keep) {
                    this._previousTrack = oldTrack;
                } else {
                    if (oldTrack) {
                        oldTrack.stop();
                    }
                    if (newTrack === this._previousTrack) {
                        this._previousTrack = null;
                    }
                }

                if (oldTrack) {
                    this._localStreams.removeTrack(oldTrack);
                }
                this._localStreams.addTrack(newTrack);

                if (cb) {
                    cb(true);
                }
            }).catch((error)=> {
                DEBUG('Error replacing track: %s', error);
            });
    }

    sendMessage(message, contentType='text/plain', options={}, cb=null) {
        const outgoingMessage = new Message({
            account: this.remoteIdentity.uri,
            content: message,
            contentType,
            timestamp: options.timestamp || new Date().toISOString(),
            type: 'normal'
        }, new utils.Identity(this._account._id, this._account._displayName), 'pending');

        if (contentType !== 'text/pgp-private-key' && contentType !== 'text/pgp-public-key') {
            this._messages.set(outgoingMessage.id, outgoingMessage);
        }
        const req = {
            sylkrtc: 'session-message',
            session: this._id,
            message_id: outgoingMessage.id,
            content: message,
            content_type: outgoingMessage.contentType,
            timestamp: outgoingMessage.timestamp
        };
        this.emit('sendingMessage', outgoingMessage);
        DEBUG('Sending in dialog message: %o', outgoingMessage);
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending message: %s', error);
                outgoingMessage._setState('failed');
            }
            if (cb) {
                cb(error);
            }
        });
        return outgoingMessage;
    }

    terminate() {
        if (this._terminated) {
            return;
        }
        DEBUG('Terminating call');
        this._sendTerminate();
    }

    sendDtmf(tones, duration=100, interToneGap=70, method='info') {
        DEBUG('sendDtmf()');
        if (method === 'info') {
            const req = {
                sylkrtc: 'session-dtmf-info',
                session: this._id,
                digit: tones,
            };
            DEBUG('Sending DTMF using info: %o', tones);
            this._sendRequest(req, (error) => {
                if (error) {
                    DEBUG('Error sending dtmf: %s', error);
                }
            });
            return;
        }

        // RFC 4733
        if (this._dtmfSender === null) {
            if (this._pc !== null) {
                let track = null;
                try {
                    track = this._pc.getLocalStreams()[0].getAudioTracks()[0];
                } catch (e) {
                    // ignore
                }
                if (track !== null) {
                    DEBUG('Creating DTMF sender');
                     if (this._pc.getSenders) {
                         this._dtmfSender = this.getSenders().find(s => s.track && s.track.kind === 'audio');
                     } else {
                         DEBUG("Your browser doesn't support RTCPeerConnection.getSenders(), so " +
                             "falling back to use <strong>deprecated</strong> createDTMFSender() " +
                             "instead.");
                        this._dtmfSender = this._pc.createDTMFSender(track);
                     }
                    if (this._dtmfSender) {
                        this._dtmfSender.addEventListener('tonechange', this._onDtmf);
                    }
                }
            }
        }
        if (this._dtmfSender) {
            DEBUG('Sending DTMF tones');
            this._dtmfSender.insertDTMF(tones, duration, interToneGap);
        }
    }

    // Private API

    _initOutgoing(uri, options={}) {
        if (uri.indexOf('@') === -1) {
            throw new Error('Invalid URI');
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        this._id = options.id || uuidv4();
        this._direction = 'outgoing';
        this._remoteIdentity = new utils.Identity(uri);
        this._headers = options.headers;

        const pcConfig = options.pcConfig || {iceServers:[]};
        const offerOptions = options.offerOptions;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        this._pc.addStream(options.localStream);
        this.emit('localStreamAdded', options.localStream);
        utils.createLocalSdp(this._pc, 'offer', offerOptions)
            .then((sdp) => {
                DEBUG('Local SDP: %s', sdp);
                this._sendCall(uri, sdp);
            })
            .catch((reason) => {
                DEBUG(reason);
                this._localTerminate(reason);
            });
    }

    _initIncoming(id, caller, sdp, callId, headers = {}) {
        this._id = id;
        this._remoteIdentity = new utils.Identity(caller.uri, caller.display_name);
        this._incomingSdp = sdp;
        this._direction = 'incoming';
        this._state = 'incoming';
        this._callId = callId;
        this._remoteMediaDirections = Object.assign(
            {audio: [], video:[]}, utils.getMediaDirections(sdp)
        );
        this._headers = Object.keys(headers).map(key => {return {name: key, value: headers[key]};});
        DEBUG('Remote SDP: %s', sdp);
    }

    _handleRemoteUpdate(sdp) {
        if (this._pc === null) {
            DEBUG('Ignoring remote update, call already terminated');
            return;
        }

        const remoteSdp = utils.mungeSdp(sdp);
        DEBUG('Remote update offer SDP: %s', remoteSdp);

        if (this._upgrading) {
            DEBUG('Glare: remote update arrived while we are upgrading');
            this.emit('updateFailed', new Error('glare'));
            return;
        }

        this._upgrading = true;

        this._pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: remoteSdp}))
            .then(() => {
                this._remoteMediaDirections = Object.assign(
                    {audio: [], video: []}, utils.getMediaDirections(remoteSdp)
                );
                this.emit('updateRequest', {
                    sdp: remoteSdp,
                    remoteMediaDirections: this._remoteMediaDirections,
                });
            })
            .catch((error) => {
                DEBUG('Error applying remote update offer: %s', error);
                this._upgrading = false;
                this.emit('updateFailed', error);
            });
    }

    _handleEvent(message) {
        DEBUG('Call event: %o', message);
        switch (message.event) {
            case 'state':
                let oldState = this._state;
                let newState = message.state;
                this._state = newState;

                if ((newState === 'accepted' || newState === 'early-media') && this._direction === 'outgoing') {
                    DEBUG('Call accepted or early media');
                    this._emitStateChanged(oldState, newState, {});
                    if (message.sdp !== undefined) {
                        const sdp = utils.mungeSdp(message.sdp);
                        DEBUG('Remote SDP: %s', sdp);
                        this._remoteMediaDirections = Object.assign(
                            {audio: [], video:[]}, utils.getMediaDirections(sdp)
                        );
                        this._setup_in_progress = true;
                        this._callId = message.call_id;
                        this._pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: sdp}))
                            // success
                            .then(() => {
                                this._setup_in_progress = false;
                                if (!this._terminated) {
                                    if (this._delay_established) {
                                        oldState = this._state;
                                        this._state = 'established';
                                        DEBUG('Setting delayed established state!');
                                        this._emitStateChanged(oldState, this._state, {});
                                        this._delay_established = false;
                                    }
                                }
                            })
                            // failure
                            .catch((error) => {
                                DEBUG('Error accepting call or early media: %s', error);
                                this.terminate();
                            });
                    }
                } else if (newState === 'established' && this._direction === 'outgoing') {
                    if (this._setup_in_progress) {
                        this._delay_established = true;
                    } else {
                        this._emitStateChanged(oldState, newState, {});
                    }
                } else if (newState === 'proceeding') {
                    this._emitStateChanged(oldState, newState, { code: message.code });
                } else if (newState === 'terminated') {
                    this._emitStateChanged(oldState, newState, {reason: message.reason});
                    this._terminated = true;
                    this._account._calls.delete(this.id);
                    this._closeRTCPeerConnection();
                } else {
                    // Incoming calls reach 'established' here.
                    this._emitStateChanged(oldState, newState, {});
                }
                break;
            case 'message':
                DEBUG('Incoming in dialog message from %s: %o', message.sender.uri, message);
                const incomingMessage = this._messages.get(message.message_id);
                if (!incomingMessage) {
                    if (message.content_type === 'text/pgp-private-key') {
                        DEBUG('Skipping message');
                        return;
                    }
                    if (message.content_type === 'application/sylk-contact-update') {
                        DEBUG('Skipping message');
                        return;
                    }
                    // Signalling, not conversation.
                    if (CapabilitiesManager.handles(message.content_type)) {
                        this._capabilities.handleSignal(message.content);
                        return;
                    }
                    if (ScreenSharingManager.handles(message.content_type)) {
                        this._screenSharing.handleSignal(message.content_type, message.content);
                        return;
                    }

                    const mappedMessage = new Message(
                        message,
                        new utils.Identity(message.sender.uri, message.sender.display_name),
                        'received'
                    );

                    this._messages.set(mappedMessage.id, mappedMessage);
                    this.emit('incomingMessage', mappedMessage);
                    // Not implemented on sylkserver ATM
                    // if (message.disposition_notification &&
                    //     message.disposition_notification.indexOf('positive-delivery') !== -1
                    // ) {
                    //     this.sendDispositionNotification(
                    //         message.sender.uri,
                    //         message.message_id,
                    //         message.timestamp,
                    //         'delivered'
                    //     );
                    // }
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
                const {reason, code} = message;
                this.emit('messageStateChanged', message.message_id, message.state, {reason, code});
                break;
            case 'update':
                if (message.state === 'received') {
                    this._handleRemoteUpdate(message.sdp);
                } else if (message.state === 'accepted') {
                    if (this._pc === null) {
                        DEBUG('Ignoring update-accepted, call already terminated');
                        break;
                    }

                    const answerSdp = utils.mungeSdp(message.sdp);
                    DEBUG('Remote update answer SDP: %s', answerSdp);
                    this._pc.setRemoteDescription(new RTCSessionDescription({type: 'answer', sdp: answerSdp}))
                        .then(() => {
                            this._remoteMediaDirections = Object.assign(
                                {audio: [], video: []}, utils.getMediaDirections(answerSdp)
                            );
                            this._upgrading = false;
                            this._pendingVideoAddition = null;
                            this.emit('mediaUpdated', {
                                hasLocalVideo: this._localStreams.getVideoTracks().length > 0,
                                hasRemoteVideo: (this._remoteMediaDirections.video || []).some(d => d && d !== 'inactive')
                            });
                        })
                        .catch((error) => {
                            DEBUG('Error applying update answer: %s', error);
                            this._rollbackPendingVideo();
                            this._upgrading = false;
                            this.emit('updateFailed', error);
                        });
                } else if (message.state === 'failed') {
                    DEBUG('Update failed: %s', message.reason);
                    this._rollbackPendingVideo();
                    this._upgrading = false;
                    this.emit('updateFailed', new Error(message.reason || 'update rejected'));
                }
                break;
            default:
                break;
        }
    }

    _initRTCPeerConnection(pcConfig) {
        if (this._pc !== null) {
            throw new Error('RTCPeerConnection already initialized');
        }

        this._pc = new RTCPeerConnection(pcConfig);
        this._pc.addEventListener('addstream', (event) => {
            DEBUG('Stream added');
            this.emit('streamAdded', event.stream);
        });
        this._pc.addEventListener('icecandidate', (event) => {
            if (event.candidate !== null) {
                DEBUG('New ICE candidate %o', event.candidate);
            } else {
                DEBUG('ICE candidate gathering finished');
            }
            this._sendTrickle(event.candidate);
        });
        this._statistics.addConnection({pc:this._pc, peerId: this._id});
    }

    _sendRequest(req, cb) {
        this._account._sendRequest(req, cb);
    }

    _sendCall(uri, sdp) {
        const req = {
            sylkrtc: 'session-create',
            account: this.account.id,
            session: this.id,
            uri: uri,
            sdp: sdp,
            headers: this.headers
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Call error: %s', error);
                this._localTerminate(error);
            }
        });
    }

    _sendTerminate() {
        const req = {
            sylkrtc: 'session-terminate',
            session: this.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error terminating call: %s', error);
                this._localTerminate(error);
            }
        });
        setTimeout(() => {
            if (!this._terminated) {
                DEBUG('Timeout terminating call');
                this._localTerminate('200 OK');
            }
            this._terminated = true;
        }, 300);
    }

    _sendTrickle(candidate) {
        const req = {
            sylkrtc: 'session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : [],
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Trickle error: %s', error);
                this._localTerminate(error);
            }
        });
    }

    _sendAnswer(sdp) {
        const req = {
            sylkrtc: 'session-answer',
            session: this.id,
            sdp: sdp
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
                this.terminate();
            }
        });
    }

    _sendUpdate(sdp, onSuccess) {
        const req = {
            sylkrtc: 'session-update',
            session: this.id,
            sdp: sdp
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Update error: %s', error);
                this._rollbackPendingVideo();
                this._upgrading = false;
                this.emit('updateFailed', error);
                return;
            }
            if (onSuccess) {
                onSuccess();
            }
        });
    }


    _rollbackPendingVideo() {
        if (!this._pendingVideoAddition) {
            return;
        }
        for (const { sender, track } of this._pendingVideoAddition) {
            try {
                this._pc.removeTrack(sender);
            } catch (e) {
                // sender already detached; ignore
            }
            try {
                track.stop();
                this._localStreams.removeTrack(track);
            } catch (e) {
                // ignore
            }
        }
        this._pendingVideoAddition = null;
    }

    _closeRTCPeerConnection() {
        DEBUG('Closing RTCPeerConnection');
        if (this._pc !== null) {
            let tempStream;
            if (this._pc.getSenders) {
                let tracks = [];
                for (let track of this._pc.getSenders()) {
                    if (track.track !== null ) {
                        tracks = tracks.concat(track.track);
                    }
                    if (this._previousTrack !== null) {
                        tracks = tracks.concat(this._previousTrack);
                    }
                }
                if (tracks.length !== 0) {
                    tempStream = new MediaStream(tracks);
                    utils.closeMediaStream(tempStream);
                }
            } else {
                for (let stream of this._pc.getLocalStreams()) {
                    if (this._previousTrack !== null) {
                        stream = stream.concat(this._previousTrack);
                    }
                    utils.closeMediaStream(stream);
                }
            }

            if (this._pc.getReceivers) {
                let tracks = [];
                for (let track of this._pc.getReceivers()) {
                    tracks = tracks.concat(track.track);
                }
                tempStream = new MediaStream(tracks);
                utils.closeMediaStream(tempStream);
            } else {
                for (let stream of this._pc.getRemoteStreams()) {
                    utils.closeMediaStream(stream);
                }
            }
            this._statistics.removeConnection({pc:this._pc, peerId: this._id});
            this._pc.close();
            this._pc = null;
            if (this._dtmfSender !== null) {
                this._dtmfSender.removeEventListener('tonechange', this._onDtmf);
                this._dtmfSender = null;
            }
        }
    }

    _localTerminate(error) {
        if (this._terminated) {
            return;
        }
        DEBUG('Local terminate');
        this._account._calls.delete(this.id);
        this._terminated = true;
        const oldState = this._state;
        const newState = 'terminated';
        const data = {
            reason: error.toString()
        };
        this._closeRTCPeerConnection();
        this._emitStateChanged(oldState, newState, data);
    }

    _onDtmf(event) {
        DEBUG('Sent DTMF tone %s', event.tone);
        this.emit('dtmfToneSent', event.tone);
    }

    // -- capabilities --------------------------------------------------

    /** Advertises on the way into 'established'; every transition goes
     *  through here so it can't be missed on any path that reaches it. */
    _emitStateChanged(oldState, newState, data) {
        if (newState === 'terminated') {
            this._clearSignallingState();
        }
        this.emit('stateChanged', oldState, newState, data);
        if (newState === 'established') {
            this._capabilities.send();
        }
    }

    // -- signalling plumbing --------------------------------------------

    /** Send one in-dialog signal. Not conversation, so this bypasses
     *  sendMessage() and stays out of the message map / 'sendingMessage'.
     *  `onResult(error)` is optional, for callers that need to react to
     *  a failed send (e.g. to retry). */
    _sendSignal(contentType, payload, onResult=null) {
        if (this._terminated || this._id === null) {
            return false;
        }
        try {
            this._sendRequest({
                sylkrtc: 'session-message',
                session: this._id,
                message_id: uuidv4(),
                content: JSON.stringify(payload),
                content_type: contentType,
                timestamp: new Date().toISOString()
            }, (error) => {
                if (error) {
                    DEBUG('Error sending %s: %s', contentType, error);
                }
                if (onResult) {
                    onResult(error);
                }
            });
            return true;
        } catch (e) {
            DEBUG('Could not send %s: %s', contentType, e);
            return false;
        }
    }

    _clearSignallingState() {
        this._screenSharing.clear();
    }
}


export { Call };
