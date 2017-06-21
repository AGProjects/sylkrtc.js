'use strict';

import debug from 'debug';
import uuidv4 from 'uuid/v4';
import utils from './utils';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Conference');


class Participant extends EventEmitter {
    constructor(publisherId, identity, conference) {
        super();
        this._id = uuidv4();
        this._publisherId = publisherId;
        this._identity = identity;
        this._conference = conference;
        this._state = null;
        this._pc = null;
    }

    get id() {
        return this._id;
    }

    get identity() {
        return this._identity;
    }

    get conference() {
        return this._conference;
    }

    get state() {
        return this._state;
    }

    get streams() {
        if (this._pc !== null) {
            return this._pc.getRemoteStreams();
        } else {
            return [];
        }
    }

    attach() {
        if (this._state !== null) {
            return;
        }
        this._setState('progress');
        this._sendAttach();
    }

    detach() {
        if (this._state !== null) {
            this._sendDetach();
        }
    }

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;
        DEBUG(`Participant ${this.id} state change: ${oldState} -> ${newState}`);
        this.emit('stateChanged', oldState, newState);
    }

    _handleOffer(offerSdp) {
        DEBUG('Handling SDP for participant offer: %s', offerSdp);

        // Create the RTCPeerConnection
        const pcConfig = this.conference._pcConfig;
        const pc = new RTCPeerConnection(pcConfig);
        pc.addEventListener('addstream', (event) => {
            DEBUG('Stream added');
            this.emit('streamAdded', event.stream);
        });
        pc.addEventListener('icecandidate', (event) => {
            if (event.candidate !== null) {
                DEBUG('New ICE candidate %o', event.candidate);
            } else {
                DEBUG('ICE candidate gathering finished');
            }
            this._sendTrickle(event.candidate);
        });
        this._pc = pc;

        // no need for a local stream since we are only going to receive media here
        pc.setRemoteDescription(
            new RTCSessionDescription({type: 'offer', sdp: offerSdp}),
            // success
            () => {
                utils.createLocalSdp(pc, 'answer')
                    .then((sdp) => {
                        DEBUG('Local SDP: %s', sdp);
                        this._sendAnswer(sdp);
                    })
                    .catch((reason) => {
                        DEBUG(reason);
                        this._close();
                    });
            },
            // failure
            (error) => {
                DEBUG('Error setting remote description: %s', error);
                this._close();
            }
        );
    }

    _sendAttach() {
        const req = {
            sylkrtc: 'videoroom-ctl',
            session: this.conference.id,
            option: 'feed-attach',
            feed_attach: {
                session: this.id,
                publisher: this._publisherId
            }
        };
        DEBUG('Sending request: %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error attaching to participant %s: %s', this._publisherId, error);
            }
        });
    }

    _sendDetach() {
        const req = {
            sylkrtc: 'videoroom-ctl',
            session: this.conference.id,
            option: 'feed-detach',
            feed_detach: {
                session: this.id
            }
        };
        DEBUG('Sending request: %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error detaching to participant %s: %s', this._publisherId, error);
            }
            this._close();
        });
    }

    _sendTrickle(candidate) {
        const req = {
            sylkrtc: 'videoroom-ctl',
            session: this.conference.id,
            option: 'trickle',
            trickle: {
                session: this.id,
                candidates: candidate !== null ? [candidate] : []
            }
        };
        this.conference._sendRequest(req, null);
    }

    _sendAnswer(sdp) {
        const req = {
            sylkrtc: 'videoroom-ctl',
            session: this.conference.id,
            option: 'feed-answer',
            feed_answer: {
                session: this.id,
                sdp: sdp
            }
        };
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
                this._close();
            }
        });
    }

    _close() {
        DEBUG('Closing Participant RTCPeerConnection');
        if (this._pc !== null) {
            for (let stream of this._pc.getLocalStreams()) {
                utils.closeMediaStream(stream);
            }
            for (let stream of this._pc.getRemoteStreams()) {
                utils.closeMediaStream(stream);
            }
            this._pc.close();
            this._pc = null;
            this._setState(null);
        }
    }
}


class ConferenceCall extends EventEmitter {
    constructor(account) {
        super();
        this._account = account;
        this._id = null;
        this._pc = null;
        this._participants = new Map();
        this._terminated = false;
        this._state = null;
        this._localIdentity = new utils.Identity(account.id, account.displayName);
        this._remoteIdentity = null;
        this._pcConfig = null;  // saved on initialize, used later for subscriptions
    }

    get account() {
        return this._account;
    }

    get id() {
        return this._id;
    }

    get direction() {
        // make this object API compatible with `Call`
        return 'outgoing';
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

    get participants() {
        return Array.from(this._participants.values());
    }

    getLocalStreams() {
        if (this._pc !== null) {
            return this._pc.getLocalStreams();
        } else {
            return [];
        }
    }

    getRemoteStreams() {
        let streams = [];
        for (let participant of this._participants) {
            streams = streams.contact(participant.streams);
        }
        return streams;
    }

    terminate() {
        if (this._terminated) {
            return;
        }
        DEBUG('Terminating conference');
        this._sendTerminate();
    }

    inviteParticipants(ps) {
        if (this._terminated) {
            return;
        }
        if (!Array.isArray(ps) || ps.length === 0) {
            return;
        }
        DEBUG('Inviting participants: %o', ps);
        const req = {
            sylkrtc: 'videoroom-ctl',
            session: this.id,
            option: 'invite-participants',
            invite_participants: {
                participants: ps
            }
        };
        this._sendRequest(req, null);
    }

    // Private API

    _initialize(uri, options={}) {
        if (this._id !== null) {
            throw new Error('Already initialized');
        }

        if (uri.indexOf('@') === -1) {
            throw new Error('Invalid URI');
        }

        if (!options.localStream) {
            throw new Error('Missing localStream');
        }

        this._id = uuidv4();
        this._remoteIdentity = new utils.Identity(uri);

        options = Object.assign({}, options);
        const pcConfig = options.pcConfig || {iceServers:[]};
        this._pcConfig = pcConfig;
        this._initialParticipants = options.initialParticipants || [];
        const offerOptions = options.offerOptions || {};
        // only send audio / video through the publisher connection
        offerOptions.offerToReceiveAudio = false;
        offerOptions.offerToReceiveVideo = false;
        delete offerOptions.mandatory;

        // Create the RTCPeerConnection
        this._pc = new RTCPeerConnection(pcConfig);
        this._pc.addEventListener('icecandidate', (event) => {
            if (event.candidate !== null) {
                DEBUG('New ICE candidate %o', event.candidate);
            } else {
                DEBUG('ICE candidate gathering finished');
            }
            this._sendTrickle(event.candidate);
        });

        this._pc.addStream(options.localStream);
        this.emit('localStreamAdded', options.localStream);
        DEBUG('Offer options: %o', offerOptions);
        utils.createLocalSdp(this._pc, 'offer', offerOptions)
            .then((sdp) => {
                DEBUG('Local SDP: %s', sdp);
                this._sendJoin(sdp);
            })
            .catch((reason) => {
                this._localTerminate(reason);
            });
    }

    _handleEvent(message) {
        DEBUG('Conference event: %o', message);
        switch (message.event) {
            case 'state':
                const oldState = this._state;
                const newState = message.data.state;
                this._state = newState;
                let data = {};
                let participant;

                if (newState === 'accepted') {
                    let sdp = utils.mungeSdp(message.data.sdp);
                    DEBUG('Remote SDP: %s', sdp);
                    this._pc.setRemoteDescription(
                        new RTCSessionDescription({type: 'answer', sdp: sdp}),
                        // success
                        () => {
                            DEBUG('Conference accepted');
                            this.emit('stateChanged', oldState, newState, data);
                            if (this._initialParticipants.length > 0 ) {
                                setTimeout(() => {
                                        this.inviteParticipants(this._initialParticipants);
                                }, 50);
                            }
                        },
                        // failure
                        (error) => {
                            DEBUG('Error processing conference accept: %s', error);
                            this.terminate();
                        }
                    );
                } else {
                    if (newState === 'terminated') {
                        data.reason = message.data.reason;
                        this._terminated = true;
                        this._close();
                    }
                    this.emit('stateChanged', oldState, newState, data);
                }
                break;
            case 'initial_publishers':
                // this comes between 'accepted' and 'established' states
                for (let p of message.data.publishers) {
                    if (!this._participants.has(p.id)) {
                        participant = new Participant(p.id, new utils.Identity(p.uri, p.display_name), this);
                        this._participants.set(participant.id, participant);
                    }
                }
                break;
            case 'publishers_joined':
                for (let p of message.data.publishers) {
                    if (!this._participants.has(p.id)) {
                        DEBUG('Participant joined: %o', p);
                        participant = new Participant(p.id, new utils.Identity(p.uri, p.display_name), this);
                        this._participants.set(participant.id, participant);
                        this.emit('participantJoined', participant);
                    }
                }
                break;
            case 'publishers_left':
                for (let pId of message.data.publishers) {
                    for (participant of this._participants.values()) {
                        if (pId === participant._publisherId) {
                            this._participants.delete(participant.id);
                            this.emit('participantLeft', participant);
                        }
                    }
                }
                break;
            case 'feed_attached':
                participant = this._participants.get(message.data.subscription);
                if (participant) {
                    participant._handleOffer(message.data.sdp);
                }
                break;
            case 'feed_established':
                participant = this._participants.get(message.data.subscription);
                if (participant) {
                    participant._setState('established');
                }
                break;
            default:
                break;
        }
    }

    _sendJoin(sdp) {
        const req = {
            sylkrtc: 'videoroom-join',
            account: this.account.id,
            session: this.id,
            uri: this.remoteIdentity.uri,
            sdp: sdp
        };
        DEBUG('Sending request: %o', req);
        this._sendRequest(req, (error) => {
            if (error) {
                this._localTerminate(error);
            }
        });
    }

    _sendTerminate() {
        const req = {
            sylkrtc: 'videoroom-terminate',
            session: this.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error terminating conference: %s', error);
                this._localTerminate(error);
            }
            this._terminated = true;
        });
        setTimeout(() => {
            if (!this._terminated) {
                DEBUG('Timeout terminating call');
                this._localTerminate('');
            }
            this._terminated = true;
        }, 150);
    }

    _sendTrickle(candidate) {
        const req = {
            sylkrtc: 'videoroom-ctl',
            session: this.id,
            option: 'trickle',
            trickle: {
                candidates: candidate !== null ? [candidate] : []
            }
        };
        this._sendRequest(req, null);
    }

    _sendRequest(req, cb) {
        this._account._sendRequest(req, cb);
    }

    _close() {
        DEBUG('Closing RTCPeerConnection');
        if (this._pc !== null) {
            for (let stream of this._pc.getLocalStreams()) {
                utils.closeMediaStream(stream);
            }
            for (let stream of this._pc.getRemoteStreams()) {
                utils.closeMediaStream(stream);
            }
            this._pc.close();
            this._pc = null;
        }
        const participants = this.participants;
        this._participants = [];
        for (let p of participants) {
            p._close();
        }
    }

    _localTerminate(reason) {
        if (this._terminated) {
            return;
        }
        DEBUG(`Local terminate, reason: ${reason}`);
        this._account._confCalls.delete(this.id);
        this._terminated = true;
        const oldState = this._state;
        const newState = 'terminated';
        const data = {
            reason: reason.toString()
        };
        this._close();
        this.emit('stateChanged', oldState, newState, data);
    }

}


export { ConferenceCall };
