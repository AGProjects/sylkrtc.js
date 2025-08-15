'use strict';

import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

import { Statistics } from './statistics';
import { Message } from './message';
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

    getLocalStreams() {
        if (this._pc !== null) {
            if (this._pc.getSenders) {
                this._pc.getSenders().forEach((e) => {
                    if (e.track != null) {
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

    startScreensharing(newTrack) {
        let oldTrack = this.getLocalStreams()[0].getVideoTracks()[0];
        this.replaceTrack(oldTrack, newTrack, true, (value) => {
            this._sharingScreen = value;
        });
    }

    stopScreensharing() {
        let oldTrack = this.getLocalStreams()[0].getVideoTracks()[0];
        this.replaceTrack(oldTrack, this._previousTrack);
        this._sharingScreen = false;
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

    sendDtmf(tones, duration=100, interToneGap=70) {
        DEBUG('sendDtmf()');
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
                         this._dtmfSender = this._pc.getSenders()[0].dtmf;
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

    _handleEvent(message) {
        DEBUG('Call event: %o', message);
        switch (message.event) {
            case 'state':
                let oldState = this._state;
                let newState = message.state;
                this._state = newState;

                if ((newState === 'accepted' || newState === 'early-media') && this._direction === 'outgoing') {
                    DEBUG('Call accepted or early media');
                    this.emit('stateChanged', oldState, newState, {});
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
                                        this.emit('stateChanged', oldState, this._state, {});
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
                        this.emit('stateChanged', oldState, newState, {});
                    }
                } else if (newState === 'proceeding') {
                    this.emit('stateChanged', oldState, newState, { code: message.code });
                } else if (newState === 'terminated') {
                    this.emit('stateChanged', oldState, newState, {reason: message.reason});
                    this._terminated = true;
                    this._account._calls.delete(this.id);
                    this._closeRTCPeerConnection();
                } else {
                    this.emit('stateChanged', oldState, newState, {});
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

                    const mappedMessage = new Message(
                        message,
                        new utils.Identity(message.sender.uri, message.sender.display_name),
                        'received'
                    );

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
        }, 150);
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

    _closeRTCPeerConnection() {
        DEBUG('Closing RTCPeerConnection');
        if (this._pc !== null) {
            let tempStream;
            if (this._pc.getSenders) {
                let tracks = [];
                for (let track of this._pc.getSenders()) {
                    if (track.track != null ) {
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
        this.emit('stateChanged', oldState, newState, data);
    }

    _onDtmf(event) {
        DEBUG('Sent DTMF tone %s', event.tone);
        this.emit('dtmfToneSent', event.tone);
    }
}


export { Call };
