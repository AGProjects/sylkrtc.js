'use strict';

import debug from 'debug';
import uuid from 'node-uuid';
import rtcninja from 'rtcninja';
import transform from 'sdp-transform';

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
        this._localIdentity = null;
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

        const self = this;
        const pcConfig = options.pcConfig || {iceServers:[]};
        const mediaConstraints = options.mediaConstraints || {audio: true, video: true};
        const answerOptions = options.answerOptions;
        const localStream = options.localStream || null;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        if (localStream !== null) {
            // Use the provided stream
            userMediaSucceeded(localStream);
        } else {
            // Get the user media
            rtcninja.getUserMedia(
                mediaConstraints,
                userMediaSucceeded,
                userMediaFailed
            );
        }

        function userMediaSucceeded(stream) {
            // adding a local stream doesn't trigger the 'onaddstream' callback
            self._pc.addStream(stream);
            self.emit('localStreamAdded', stream);

            self._pc.setRemoteDescription(
                new rtcninja.RTCSessionDescription({type: 'offer', sdp: self._incomingSdp}),
                // success
                function() {
                    self._createLocalSDP(
                        'answer',
                        answerOptions,
                        // success
                        function(sdp) {
                            DEBUG('Local SDP: %s', sdp);
                            self._sendAnswer(sdp);
                        },
                        // failure
                        function(error) {
                            DEBUG('Error creating local SDP: %s', error);
                            self.terminate();
                        }
                    );
                },
                // failure
                function(error) {
                    DEBUG('Error setting remote description: %s', error);
                    self.terminate();
                }
            );
        }

        function userMediaFailed(error) {
            DEBUG('Error getting user media: %s', error);
            self.terminate();
        }
    }

    terminate() {
        if (this._terminated) {
            return;
        }

        this._sendTerminate();
    }

    // Private API

    _initOutgoing(uri, options={}) {
        if (uri.indexOf('@') === -1) {
            throw new Error('Invalid URI');
        }

        this._id = uuid.v4();
        this._direction = 'outgoing';
        this._localIdentity = new Identity(this._account.id);
        this._remoteIdentity = new Identity(uri);

        const self = this;
        const pcConfig = options.pcConfig || {iceServers:[]};
        const mediaConstraints = options.mediaConstraints || {audio: true, video: true};
        const offerOptions = options.offerOptions;
        const localStream = options.localStream || null;

        // Create the RTCPeerConnection
        this._initRTCPeerConnection(pcConfig);

        if (localStream !== null) {
            // Use the provided stream
            userMediaSucceeded(localStream);
        } else {
            // Get the user media
            rtcninja.getUserMedia(
                mediaConstraints,
                userMediaSucceeded,
                userMediaFailed
            );
        }

        function userMediaSucceeded(stream) {
            // adding a local stream doesn't trigger the 'onaddstream' callback
            self._pc.addStream(stream);
            self.emit('localStreamAdded', stream);

            self._createLocalSDP(
                'offer',
                offerOptions,
                // success
                function(sdp) {
                    DEBUG('Local SDP: %s', sdp);
                    self._sendCall(uri, sdp);
                },
                // failure
                function(error) {
                    DEBUG('Error creating local SDP: %s', error);
                    self._localTerminate(error);
                }
            );
        }

        function userMediaFailed(error) {
            DEBUG('Error getting user media: %s', error);
            self._localTerminate(error);
        }
    }

    _initIncoming(id, caller, sdp) {
        this._id = id;
        this._localIdentity = new Identity(this._account.id);
        this._remoteIdentity = new Identity(caller.uri, caller.display_name);
        this._incomingSdp = sdp;
        this._direction = 'incoming';
        this._state = 'incoming';
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
                    const self = this;
                    this._pc.setRemoteDescription(
                        new rtcninja.RTCSessionDescription({type: 'answer', sdp: message.data.sdp}),
                        // success
                        function() {
                            DEBUG('Call accepted');
                            self.emit('stateChanged', oldState, newState, data);
                        },
                        // failure
                        function(error) {
                            DEBUG('Error accepting call: %s', error);
                            self.terminate();
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

        const self = this;
        this._pc = new rtcninja.RTCPeerConnection(pcConfig);
        this._pc.onaddstream = function(event, stream) {
            DEBUG('Stream added');
            self.emit('streamAdded', stream);
        };
        this._pc.onicecandidate = function(event) {
            let candidate = null;
            if (event.candidate !== null) {
                candidate = {
                    'candidate': event.candidate.candidate,
                    'sdpMid': event.candidate.sdpMid,
                    'sdpMLineIndex': event.candidate.sdpMLineIndex
                };
                DEBUG('New ICE candidate %o', candidate);
            }
            self._sendTrickle(candidate);
        };
    }

    _createLocalSDP(type, options, onSuccess, onFailure) {
        const self = this;

        if (type === 'offer') {
            this._pc.createOffer(
                // success
                createSucceeded,
                // failure
                failure,
                // options
                options
            );
        } else if (type === 'answer') {
            this._pc.createAnswer(
                // success
                createSucceeded,
                // failure
                failure,
                // options
                options
            );
        } else {
            throw new Error('type must be "offer" or "answer", but "' +type+ '" was given');
        }

        function createSucceeded(desc) {
            self._pc.setLocalDescription(
                desc,
                // success
                function() {
                    onSuccess(self._fixLocalSdp(self._pc.localDescription.sdp));
                },
                // failure
                failure
            );
        }

        function failure(error) {
            onFailure(error);
        }
    }

    _fixLocalSdp(sdp) {
        let parsedSdp = transform.parse(sdp);
        let h264payload = null;
        let hasProfileLevelId = false;

        for (let media of parsedSdp.media) {
            if (media.type === 'video') {
                for (let rtp of media.rtp) {
                    if (rtp.codec === 'H264') {
                        h264payload = rtp.payload;
                        break;
                    }
                }
                if (h264payload !== null) {
                    for (let fmtp of media.fmtp) {
                        if (fmtp.payload === h264payload && fmtp.config.indexOf('profile-level-id') !== -1) {
                            hasProfileLevelId = true;
                            break
                        }
                    }
                    if (!hasProfileLevelId) {
                        media.fmtp.push({payload: h264payload, config: 'profile-level-id=420010'});
                    }
                    break;
                }
            }
        }
        return transform.write(parsedSdp);
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
        const self = this;
        this._sendRequest(req, function(error) {
            if (error) {
                DEBUG('Call error: %s', error);
                self._localTerminate(error);
            }
        });
    }

    _sendTerminate() {
        let req = {
            sylkrtc: 'session-terminate',
            session: this.id
        };
        const self = this;
        this._sendRequest(req, function(error) {
            if (error) {
                DEBUG('Error terminating call: %s', error);
                self._localTerminate(error);
            }
            self._terminated = true;
        });
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
        const self = this;
        this._sendRequest(req, function(error) {
            if (error) {
                DEBUG('Answer error: %s', error);
                self.terminate();
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
