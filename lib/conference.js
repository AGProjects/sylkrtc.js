'use strict';

import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import utils from './utils';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Conference');


class Message extends EventEmitter {
    constructor(message, identity, state=null) {
        super();
        this._id = uuidv4();
        this._contentType   = message.content_type;
        this._sender        = identity;
        this._type          = message.type;
        this._timestamp     = new Date(message.timestamp);
        this._state         = state;
        if (message.content_type === 'text/html') {
            this._content = utils.sanatizeHtml(message.content);
        } else {
            this._content = message.content;
        }
    }

    get id() {
        return this._id;
    }

    get content() {
        return this._content;
    }

    get contentType() {
        return this._contentType;
    }

    get sender() {
        return this._sender;
    }

    get timestamp() {
        return this._timestamp;
    }

    get type() {
        return this._type;
    }

    get state() {
        return this._state;
    }

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;
        DEBUG(`Message ${this.id} state change: ${oldState} -> ${newState}`);
        this.emit('stateChanged', oldState, newState);
    }
}


class Participant extends EventEmitter {
    constructor(publisherId, identity, conference) {
        super();
        this._id = uuidv4();
        this._publisherId = publisherId;
        this._identity = identity;
        this._conference = conference;
        this._state = null;
        this._pc = null;
        this._stream = new MediaStream();
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

    getReceivers() {
        if (this._pc !== null) {
           return this._pc.getReceivers();
        } else {
            return [];
        }
    }

    get streams() {
        if (this._pc !== null) {
            if (this._pc.getReceivers) {
                this._pc.getReceivers().forEach((e) => {
                    this._stream.addTrack(e.track);
                });
                return [this._stream];
            } else {
                return this._pc.getRemoteStreams();
            }
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

    detach(isRemoved=false) {
        if (this._state !== null) {
            if (!isRemoved) {
                this._sendDetach();
            } else {
                this._close();
            }
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
        pc.setRemoteDescription(new RTCSessionDescription({type: 'offer', sdp: offerSdp}))
            // success
            .then(() => {
                utils.createLocalSdp(pc, 'answer')
                    .then((sdp) => {
                        DEBUG('Local SDP: %s', sdp);
                        this._sendAnswer(sdp);
                    })
                    .catch((reason) => {
                        DEBUG(reason);
                        this._close();
                    });
            })
            // failure
            .catch((error) => {
                DEBUG('Error setting remote description: %s', error);
                this._close();
            });
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
            let tempStream;
            if (this._pc.getSenders) {
                let tracks = [];
                for (let track of this._pc.getSenders()) {
                    if (track.track != null) {
                        tracks = tracks.concat(track.track);
                    }
                }
                if (tracks.length !== 0) {
                    tempStream = new MediaStream(tracks);
                    utils.closeMediaStream(tempStream);
                }
            } else {
                for (let stream of this._pc.getLocalStreams()) {
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
        this._localStreams = new MediaStream();
        this._previousTrack = null;
        this._remoteIdentity = null;
        this._sharingScreen = false;
        this._activeParticpants = [];
        this._sharedFiles = [];
        this._raisedHands = [];
        this._messages = new Map();
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

    get sharingScreen() {
        return this._sharingScreen;
    }

    get sharedFiles () {
        return this._sharedFiles;
    }

    get raisedHands () {
        return this._raisedHands;
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

    get messages() {
        return Array.from(this._messages.values());
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
        let streams = [];
        for (let participant of new Set(this._participants.values())) {
            streams = streams.concat(participant.streams);
        }
        return streams;
    }

    getSenders() {
        if (this._pc !== null) {
           return this._pc.getSenders();
        } else {
            return [];
        }
    }

    getReceivers() {
        let receivers = [];
        for (let participant of new Set(this._participants.values())) {
            receivers =  receivers.concat(participant.getReceivers());
        }
        return receivers;
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

    sendMessage(message, type) {
        return this._sendMessage(message, type);
    }

    sendComposing(state) {
        return this._sendComposing(state);
    }

    muteAudioParticipants() {
        DEBUG('Muting audio for all partcipants');
        const req = {
            sylkrtc: 'videoroom-mute-audio-participants',
            session: this.id
        };
        this._sendRequest(req, null);
    }

    toggleHand(session) {
        DEBUG('Toggle hand state');
        const req = {
            sylkrtc: 'videoroom-toggle-hand',
            session: this.id
        };
        if (session) {
            req.session_id = session;
        }
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

        this._id = options.id || uuidv4();
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
                                DEBUG('Conference accepted');
                                if (this._initialParticipants.length > 0 ) {
                                    setTimeout(() => {
                                            this.inviteParticipants(this._initialParticipants);
                                    }, 50);
                                }
                            }
                        })
                        // failure
                        .catch((error) => {
                            DEBUG('Error processing conference accept: %s', error);
                            this.terminate();
                        });
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
            case 'file-sharing':
                const mappedFiles = message.files.map((file) => {
                    return new utils.SharedFile(
                        file.filename,
                        file.filesize,
                        new utils.Identity(file.uploader.uri, file.uploader.display_name),
                        file.session
                    );
                });
                this._sharedFiles = this._sharedFiles.concat(mappedFiles);
                this.emit('fileSharing', mappedFiles);
                break;
            case 'message':
                const mappedMessage = new Message(
                    message,
                    new utils.Identity(message.sender.uri, message.sender.display_name),
                    'received'
                );
                this._messages.set(mappedMessage.id, mappedMessage);
                this.emit('message', mappedMessage);
                break;
            case 'message-delivery':
                const outgoingMessage = this._messages.get(message.message_id);
                if (outgoingMessage) {
                    if (message.delivered) {
                        outgoingMessage._setState('delivered');
                    } else {
                        outgoingMessage._setState('failed');
                    }
                }
                break;
            case 'composing-indication':
                const mappedComposing  = {
                    refresh: message.refresh,
                    sender: new utils.Identity(message.sender.uri, message.sender.display_name),
                    state: message.state
                };
                this.emit('composingIndication', mappedComposing);
                break;
            case 'mute-audio':
                let identity;
                const mappedIdentity = this._participants.get(message.originator);
                if (mappedIdentity) {
                    identity = mappedIdentity.identity;
                } else if (message.originator === this.id) {
                    identity = this.localIdentity;
                }
                this.emit('muteAudio', {originator: identity});
                break;
            case 'raised-hands':
                let raisedHands = [];
                for (let pId of message.raised_hands) {
                    participant = this._participants.get(pId);
                    if (participant) {
                        raisedHands.push(participant);
                    } else if (pId === this.id) {
                        raisedHands.push({
                            id: this.id,
                            publisherId: this.id,
                            identity: this.localIdentity,
                            streams: this.getLocalStreams()
                        });
                    }
                }
                this._raisedHands = raisedHands;
                this.emit('raisedHands', {raisedHands: this._raisedHands});
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

    _sendMessage(message, contentType='text/plain') {
        const outgoingMessage = new Message({
            content: message,
            content_type: contentType,
            timestamp: new Date().toISOString(),
            type: 'normal'
        }, this._localIdentity, 'pending');
        const req = {
            sylkrtc: 'videoroom-message',
            session: this.id,
            message_id: outgoingMessage.id,
            content: outgoingMessage.content,
            content_type: outgoingMessage.contentType
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


    _sendComposing(state) {
        const req = {
            sylkrtc: 'videoroom-composing-indication',
            session: this.id,
            state: state,
        };
        this._sendRequest(req, (error) => {
            if (error) {
                DEBUG('Error sending message: %s', error);
            }
        });
    }

    _sendRequest(req, cb) {
        this._account._sendRequest(req, cb);
    }

    _close() {
        DEBUG('Closing RTCPeerConnection');
        if (this._pc !== null) {
            let tempStream;
            if (this._pc.getSenders) {
                let tracks = [];
                for (let track of this._pc.getSenders()) {
                    tracks = tracks.concat(track.track);
                }
                if (this._previousTrack !== null) {
                    tracks = tracks.concat(this._previousTrack);
                }
                tempStream = new MediaStream(tracks);
                utils.closeMediaStream(tempStream);
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
