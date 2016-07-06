'use strict';

import debug from 'debug';
import uuid from 'node-uuid';
import rtcninja from 'rtcninja';
import utils from './utils';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Call');


class Identity {
    constructor(uri, displayName='') {
        this._uri = uri;
        this._displayName = displayName;
    }

    get uri() {
        return this._uri;
    }

    get displayName() {
        return this._displayName;
    }

    toString() {
        if (!this._displayName) {
            return this._uri;
        } else {
            return `${this._displayName} <${this._uri}>`;
        }
    }
}


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
        this._localIdentity = new Identity(account.id, account.displayName);
        this._remoteIdentity = null;
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

    // Private API

    _initOutgoing(uri, options={}) {
        if (uri.indexOf('@') === -1) {
            throw new Error('Invalid URI');
        }

        this._id = uuid.v4();
        this._direction = 'outgoing';
        this._remoteIdentity = new Identity(uri);

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
        this._remoteIdentity = new Identity(caller.uri, caller.display_name);
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
                let data = {};

                if (newState === 'accepted' && this._direction === 'outgoing') {
                    let sdp = utils.mungeSdp(message.data.sdp);
                    DEBUG('Remote SDP: %s', sdp);
                    this._pc.setRemoteDescription(
                        new rtcninja.RTCSessionDescription({type: 'answer', sdp: sdp}),
                        // success
                        () => {
                            DEBUG('Call accepted');
                            this.emit('stateChanged', oldState, newState, data);
                        },
                        // failure
                        (error) => {
                            DEBUG('Error accepting call: %s', error);
                            this.terminate();
                        }
                    );
                } else {
                    if (newState === 'terminated') {
                        data.reason = message.data.reason;
                        this._terminated = true;
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
        let req = {
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
        let req = {
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
        let req = {
            sylkrtc: 'session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : [],
        };
        this._sendRequest(req, null);
    }

    _sendAnswer(sdp) {
        let req = {
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
        let data = {
            reason: error.toString()
        };
        this._closeRTCPeerConnection();
        this.emit('stateChanged', oldState, newState, data);
    }
}


export { Call, Identity };
