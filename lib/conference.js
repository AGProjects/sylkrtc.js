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
        this._videoSubscriptionPaused = false;
        this._audioSubscriptionPaused = false;
        this._videoPublishingPaused = false;
        this._audioPublishingPaused = false;
    }

    get id() {
        return this._id;
    }

    get publisherId() {
        return this._publisherId;
    }

    get identity() {
        return this._identity;
    }

    get conference() {
        return this._conference;
    }

    get videoPaused() {
        return this._videoSubscriptionPaused;
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

    pauseVideo() {
        this._sendUpdate({video: false});
        this._videoSubscriptionPaused = true;
    }

    resumeVideo() {
        this._sendUpdate({video: true});
        this._videoSubscriptionPaused = false;
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
            sylkrtc: 'videoroom-feed-attach',
            session: this.conference.id,
            publisher: this._publisherId,
            feed: this.id
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
            sylkrtc: 'videoroom-feed-detach',
            session: this.conference.id,
            feed: this.id
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
            sylkrtc: 'videoroom-session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : []
        };
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Trickle error: %s', error);
                this._close();
            }
        });
    }

    _sendAnswer(sdp) {
        const req = {
            sylkrtc: 'videoroom-feed-answer',
            session: this.conference.id,
            feed: this.id,
            sdp: sdp
        };
        DEBUG('Sending request: %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
                this._close();
            }
        });
    }

    _sendUpdate(options = {}) {
        const req = {
            sylkrtc: 'videoroom-session-update',
            session: this.id,
            options: options
        };
        DEBUG('Sending update participant request %o', req);
        this.conference._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Answer error: %s', error);
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
        this._activeParticpants = [];
        this._pcConfig = null;  // saved on initialize, used later for subscriptions
        this._delay_established = false;  // set to true when we need to delay posting the state change to 'established'
        this._setup_in_progress = false;  // set while we set the remote description and setup the peer copnnection
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
        return Array.from(new Set(this._participants.values()));
    }

    get activeParticipants() {
        return this._activeParticpants;
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
        for (let participant of new Set(this._participants.values())) {
            streams = streams.concat(participant.streams);
        }
        return streams;
    }

    scaleLocalTrack(oldTrack, divider) {
        DEBUG('Scaling track by %d', divider);

        let sender;

        for (sender of this._pc.getSenders()) {
            if (sender.track === oldTrack) {
                DEBUG('Found sender to modify track %o', sender);
                break;
            }
        }

        sender.setParameters({encodings: [{scaleResolutionDownBy: divider}]})
            .then(() => {
                DEBUG("Scale set to %o", divider);
                DEBUG('Active encodings %o', sender.getParameters().encodings);
            })
            .catch((error) => {
                DEBUG('Error %o', error);
            });
    }

    configureRoom(ps, cb=null) {
        if (!Array.isArray(ps)) {
            return;
        }
        this._sendConfigureRoom(ps, cb);
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
            sylkrtc: 'videoroom-invite',
            session: this.id,
            participants: ps
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
        let participant;
        switch (message.event) {
            case 'session-state':
                let oldState = this._state;
                let newState = message.state;
                this._state = newState;

                if (newState === 'accepted') {
                    this.emit('stateChanged', oldState, newState, {});
                    const sdp = utils.mungeSdp(message.sdp);
                    DEBUG('Remote SDP: %s', sdp);
                    this._setup_in_progress = true;
                    this._pc.setRemoteDescription(
                        new RTCSessionDescription({type: 'answer', sdp: sdp}),
                        // success
                        () => {
                            this._setup_in_progress = false;
                            if (!this._terminated) {
                                if (this._delay_established) {
                                    oldState = this._state;
                                    this._state = 'established';
                                    DEBUG('Setting delayed established state!');
                                    this.emit('stateChanged', oldState, this._state, {});
                                    this._delay_established = false;
                                }
                                DEBUG('Conference accepted');
                                if (this._initialParticipants.length > 0 ) {
                                    setTimeout(() => {
                                            this.inviteParticipants(this._initialParticipants);
                                    }, 50);
                                }
                            }
                        },
                        // failure
                        (error) => {
                            DEBUG('Error processing conference accept: %s', error);
                            this.terminate();
                        }
                    );
                } else if (newState === 'established') {
                    if (this._setup_in_progress) {
                        this._delay_established = true;
                    } else {
                        this.emit('stateChanged', oldState, newState, {});
                    }
                } else if (newState === 'terminated') {
                    this.emit('stateChanged', oldState, newState, {reason: message.reason});
                    this._terminated = true;
                    this._close();
                } else {
                    this.emit('stateChanged', oldState, newState, {});
                }
                break;
            case 'initial-publishers':
                // this comes between 'accepted' and 'established' states
                for (let p of message.publishers) {
                    participant = new Participant(p.id, new utils.Identity(p.uri, p.display_name), this);
                    this._participants.set(participant.id, participant);
                    this._participants.set(p.id, participant);
                }
                break;
            case 'publishers-joined':
                for (let p of message.publishers) {
                    DEBUG('Participant joined: %o', p);
                    participant = new Participant(p.id, new utils.Identity(p.uri, p.display_name), this);
                    this._participants.set(participant.id, participant);
                    this._participants.set(p.id, participant);
                    this.emit('participantJoined', participant);
                }
                break;
            case 'publishers-left':
                for (let pId of message.publishers) {
                    participant = this._participants.get(pId);
                    if (participant) {
                        this._participants.delete(participant.id);
                        this._participants.delete(pId);
                        this.emit('participantLeft', participant);
                    }
                }
                break;
            case 'feed-attached':
                participant = this._participants.get(message.feed);
                if (participant) {
                    participant._handleOffer(message.sdp);
                }
                break;
            case 'feed-established':
                participant = this._participants.get(message.feed);
                if (participant) {
                    participant._setState('established');
                }
                break;
            case 'configure':
                let activeParticipants = [];
                let originator;
                const mappedOriginator = this._participants.get(message.originator);

                if (mappedOriginator) {
                    originator = mappedOriginator.identity;
                } else if (message.originator === this.id) {
                    originator = this.localIdentity;
                } else if (message.originator === 'videoroom'){
                    originator = message.originator;
                }

                for (let pId of message.active_participants) {
                    participant = this._participants.get(pId);
                    if (participant) {
                        activeParticipants.push(participant);
                    } else if (pId === this.id) {
                        activeParticipants.push({
                            id: this.id,
                            publisherId: this.id,
                            identity: this.localIdentity,
                            streams: this.getLocalStreams()
                        });
                    }
                }
                this._activeParticpants = activeParticipants;
                const roomConfig = {originator: originator, activeParticipants: this._activeParticpants};
                this.emit('roomConfigured', roomConfig);
                break;
            default:
                break;
        }
    }

    _sendConfigureRoom(ps, cb = null) {
        const req = {
            sylkrtc: 'videoroom-configure',
            session: this.id,
            active_participants: ps
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error configuring room: %s', error);
                if (cb) {
                    cb(error);
                }
            } else {
                DEBUG('Configure room send: %o', ps);
            }
        });
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
            sylkrtc: 'videoroom-leave',
            session: this.id
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error terminating conference: %s', error);
                this._localTerminate(error);
            }
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
            sylkrtc: 'videoroom-session-trickle',
            session: this.id,
            candidates: candidate !== null ? [candidate] : []
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Trickle error: %s', error);
                this._localTerminate(error);
            }
        });
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
