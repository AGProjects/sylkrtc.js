'use strict';

import debug from 'debug';
import uuid from 'node-uuid';
import rtcninja from 'rtcninja';
import utils from './utils';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Call');


class Call extends EventEmitter {
    constructor(account) {
        super();
        this._account = account;
        this._id = null;
        this._direction = null;
        this._pc = null;
        this._state = null;
        this._terminated = false;
        this._incomingSdp = null;
        this._localIdentity = new utils.Identity(account.id, account.displayName);
        this._remoteIdentity = null;
        this._dtmfSender = null;

        // bind some handlers to this instance
        this._onDtmf = this._onDtmf.bind(this);
    }

    get account() {
        return this._account;
    }

    get id() {
        return this._id;
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

    getLocalStreams() {
        if (this._pc !== null) {
            return this._pc.getLocalStreams();
        } else {
            return [];
        }
    }

    getRemoteStreams() {
        if (this._pc !== null) {
            return this._pc.getRemoteStreams();
        } else {
            return [];
        }
    }

    answer(options = {}) {
        if (this._state !== 'incoming') {
            throw new Error('Call is not in the incoming state: ' + this._state);
        }

        const pcConfig = options.pcConfig || {iceServers:[]};
        const mediaConstraints = options.mediaConstraints || {audio: true, video: true};
        const answerOptions = options.answerOptions;
        const localStream = options.localStream || null;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        utils.getUserMedia(mediaConstraints, localStream)
            .then((stream) => {
                this._pc.addStream(stream);
                this.emit('localStreamAdded', stream);
                this._pc.setRemoteDescription(
                    new rtcninja.RTCSessionDescription({type: 'offer', sdp: this._incomingSdp}),
                    // success
                    () => {
                        utils.createLocalSdp(this._pc, 'answer', answerOptions)
                            .then((sdp) => {
                                DEBUG('Local SDP: %s', sdp);
                                this._sendAnswer(sdp);
                            })
                            .catch((reason) => {
                                DEBUG(reason);
                                this.terminate();
                            });
                    },
                    // failure
                    (error) => {
                        DEBUG('Error setting remote description: %s', error);
                        this.terminate();
                    }
                );
            })
            .catch(function(reason) {
                DEBUG(reason);
                this.terminate();
            });
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
                    this._dtmfSender = this._pc.createDTMFSender(track);
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

        this._id = uuid.v4();
        this._direction = 'outgoing';
        this._remoteIdentity = new utils.Identity(uri);

        const pcConfig = options.pcConfig || {iceServers:[]};
        const mediaConstraints = options.mediaConstraints || {audio: true, video: true};
        const offerOptions = options.offerOptions;
        const localStream = options.localStream || null;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        utils.getUserMedia(mediaConstraints, localStream)
            .then((stream) => {
                this._pc.addStream(stream);
                this.emit('localStreamAdded', stream);
                utils.createLocalSdp(this._pc, 'offer', offerOptions)
                    .then((sdp) => {
                        DEBUG('Local SDP: %s', sdp);
                        this._sendCall(uri, sdp);
                    })
                    .catch((reason) => {
                        DEBUG(reason);
                        this._localTerminate(reason);
                    });
            })
            .catch(function(reason) {
                DEBUG(reason);
                this._localTerminate(reason);
            });
    }

    _initIncoming(id, caller, sdp) {
        this._id = id;
        this._remoteIdentity = new utils.Identity(caller.uri, caller.display_name);
        this._incomingSdp = sdp;
        this._direction = 'incoming';
        this._state = 'incoming';
        DEBUG('Remote SDP: %s', sdp);
    }

    _handleEvent(message) {
        DEBUG('Call event: %o', message);
        switch (message.event) {
            case 'state':
                const oldState = this._state;
                const newState = message.data.state;
                this._state = newState;
                const data = {};

                if (newState === 'accepted' && this._direction === 'outgoing') {
                    const sdp = utils.mungeSdp(message.data.sdp);
                    DEBUG('Remote SDP: %s', sdp);
                    this._pc.setRemoteDescription(
                        new rtcninja.RTCSessionDescription({type: 'answer', sdp: sdp}),
                        // success
                        () => {
                            // emit 'established' state change
                            this.emit('stateChanged', this._state, 'established', {});
                        },
                        // failure
                        (error) => {
                            DEBUG('Error accepting call: %s', error);
                            this.terminate();
                        }
                    );
                    DEBUG('Call accepted');
                    this.emit('stateChanged', oldState, newState, data);
                } else if (newState === 'established' && this._direction === 'outgoing') {
                    // TODO: remove this
                } else {
                    if (newState === 'terminated') {
                        data.reason = message.data.reason;
                        this._terminated = true;
                        this._account._calls.delete(this.id);
                        this._closeRTCPeerConnection();
                    }
                    this.emit('stateChanged', oldState, newState, data);
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

        this._pc = new rtcninja.RTCPeerConnection(pcConfig);
        this._pc.onaddstream = (event, stream) => {
            DEBUG('Stream added');
            this.emit('streamAdded', stream);
        };
        this._pc.onicecandidate = (event) => {
            if (event.candidate !== null) {
                DEBUG('New ICE candidate %o', event.candidate);
            } else {
                DEBUG('ICE candidate gathering finished');
            }
            this._sendTrickle(event.candidate);
        };
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
            sdp: sdp
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
            this._terminated = true;
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
        this._sendRequest(req, null);
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
            for (let stream of this._pc.getLocalStreams()) {
                rtcninja.closeMediaStream(stream);
            }
            for (let stream of this._pc.getRemoteStreams()) {
                rtcninja.closeMediaStream(stream);
            }
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
