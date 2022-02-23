'use strict';

import debug from 'debug';
import 'regenerator-runtime/runtime';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

import { map2obj, parseStats } from './utils';

const DEBUG = debug('sylkrtc:Statistics');


const eventListeners = {};

class Statistics extends EventEmitter {
    constructor(options={}) {
        super();
        this._getStatsInterval = options.getStatsInterval || 1000;
        this._rawStats = !!options.rawStats;
        this._statsObject = !!options.statsObject;
        this._filteredStats = !!options.filteredStats;

        if (typeof options.remote === 'boolean') {
            this.remote = options.remote;
        }

        this._connectionsToMonitor = {};
        this.statsToMonitor = [
            'inbound-rtp',
            'outbound-rtp',
            'remote-inbound-rtp',
            'remote-outbound-rtp',
            'peer-connection',
            'data-channel',
            'stream',
            'track',
            'sender',
            'receiver',
            'transport',
            'candidate-pair',
            'local-candidate',
            'remote-candidate'
        ];
    }


    get numberOfMonitoredPeers () {
        return Object.keys(this._connectionsToMonitor).length;
    }

    async addConnection(options) {
        const {pc, peerId} = options;
        let {connectionId, remote} = options;

        remote = typeof remote === 'boolean' ? remote : this.remote;

        if (!pc || !(pc instanceof RTCPeerConnection)) {
            throw new Error(`Missing argument 'pc' or is not of instance RTCPeerConnection`);
        }

        if (!peerId) {
            throw new Error('Missing argument peerId');
        }

        if (this._connectionsToMonitor[peerId]) {
            if (connectionId && connectionId in this._connectionsToMonitor[peerId]) {
                throw new Error(`We are already monitoring connection with id ${connectionId}.`);
            } else {
                for (let id of this._connectionsToMonitor[peerId]) {
                    const peerConnection = this._connectionsMonitor[peerId][id];
                    if (peerConnection.pc === pc) {
                        throw new Error(`We are already monitoring peer with id ${peerId}.`);
                    }

                    // remove an connection if it's already closed.
                    if(peerConnection.pc.connectionState === 'closed') {
                        this.removeConnection(peerId, peerConnection.pc);
                    }
                }
            }
        }
        const config = pc.getConfiguration();

        // don't log credentials
        if (config.iceServers) {
            config.iceServers.forEach(function (server) {
                delete server.credential;
            });
        }

        // if the user didn't send a connectionId, we should generate one
        if (!connectionId) {
            connectionId = uuidv4();
        }

        DEBUG(`Adding PeerConnection with id ${peerId}.`);
        this._monitorPc({
            peerId,
            connectionId,
            pc,
            remote
        });

        return {connectionId};
    }

    removeConnection (options) {
        let {peerId, connectionId, pc} = options;

        if (!peerId && !pc && !connectionId) {
            throw new Error('Missing arguments. You need to either send a peerId and pc, or a connectionId.');
        }

        if ((peerId && !pc) || (pc && !peerId)) {
            throw new Error('By not sending a connectionId, you need to send a peerId and a pc (RTCPeerConnection instance)');
        }

        // if the user sent a connectionId, use that
        if (connectionId) {
            DEBUG('Removing connection: %s',connectionId);
            for (let pId in this._connectionsToMonitor) {
                if (connectionId in this._connectionsToMonitor[pId]) {
                    peerId = pId;

                    // remove listeners
                    this._removePeerConnectionEventListeners(peerId, connectionId, pc);
                    delete this._connectionsToMonitor[pId][connectionId];
                }
            }
            // else, if the user sent a peerId and pc
        } else if (peerId && pc) {
            // check if we have this peerId
            if (peerId in this._connectionsToMonitor) {
                // loop through all connections
                for (let connectionId in this._connectionsToMonitor[peerId]) {
                    // until we find the one we're searching for
                    if (this._connectionsToMonitor[peerId][connectionId].pc === pc) {
                        DEBUG('Removing peerConnection: %s', peerId);
                        // remove listeners
                        this._removePeerConnectionEventListeners(peerId, connectionId, pc);
                        // delete it
                        delete this._connectionsToMonitor[peerId][connectionId];
                    }
                }
            }
        }

        if (Object.values(this._connectionsToMonitor[peerId]).length === 0) {
            delete this._connectionsToMonitor[peerId];
        }
    }

    removePeer (id) {
        DEBUG(`Removing PeerConnection with id ${id}.`);
        if (!this._connectionsToMonitor[id]) {
            return;
        }

        for (let connectionId in this._connectionsToMonitor[id]) {
            let pc = this.peersToMonitor[id][connectionId].pc;

            this._removePeerConnectionEventListeners(id, connectionId, pc);
        }

        // remove from peersToMonitor
        delete this._connectionsToMonitor[id];
    }

    _monitorPc(options) {
        let {peerId, connectionId, pc, remote} = options;

        if (!pc) {
            return;
        }

        const monitorPcObject = {
            pc: pc,
            connectionId,
            stream: null,
            stats: {
                // keep a reference of the current stat
                parsed: null,
                raw: null
            },
            options: {
                remote
            }
        };

        if (this._connectionsToMonitor[peerId]) {
            if (connectionId in this.peersToMonitor[peerId]) {
                DEBUG(`Already watching connection with ID ${connectionId}`);
                return;
            }
            this._connectionsToMonitor[peerId][connectionId] = monitorPcObject;
        } else {
            // keep this in an object to avoid duplicates
            this._connectionsToMonitor[peerId] = {[connectionId]: monitorPcObject};
        }
        this._addPeerConnectionEventListeners(peerId, connectionId, pc);

        // start monitoring from the first peer added
        if (this.numberOfMonitoredPeers === 1) {
            this._startStatsMonitoring();
            // this._startConnectionStateMonitoring();
        }
    }

    _startStatsMonitoring () {
        if (this._monitoringSetInterval) {
            return;
        }

        DEBUG('Start collecting statistics');

        this._monitoringSetInterval = window.setInterval(() => {
            if (!this.numberOfMonitoredPeers) {
                this._stopStatsMonitoring();
            }

            this._getStats().then((statsEvents) => {
                statsEvents.forEach((statsEventObject) => {
                    this.emit(statsEventObject.tag, statsEventObject);
                });
            });
        }, this._getStatsInterval);
    }

    _stopStatsMonitoring ()  {
        if (this._monitoringSetInterval) {
            window.clearInterval(this._monitoringSetInterval);
            this._monitoringSetInterval = 0;
        }
    }

    _checkIfConnectionIsClosed (peerId, connectionId, pc) {
        const isClosed = this._isConnectionClosed(pc);

        if (isClosed) {
            DEBUG('Removing %s, connection is closed', peerId);
            this.removeConnection({peerId, pc});
        }
        return isClosed;
    }

    _isConnectionClosed (pc) {
        return pc.connectionState === 'closed' || pc.iceConnectionState === 'closed';
    }

    /*
    _startConnectionStateMonitoring () {
        this.connectionMonitoringSetInterval = window.setInterval(() => {
            if (!this.numberOfMonitoredPeers) {
                this._stopConnectionStateMonitoring()
            }

            for (const id in this._connectionsToMonitor) {
                for (const connectionId in this._connectionsToMonitor[id]) {
                    const pc = this._connectionsToMonitor[id][connectionId].pc
                    this._checkIfConnectionIsClosed(id, connectionId, pc);
                }
            }
        }, this._getStatsInterval)
    }

    _stopConnectionStateMonitoring() {
        if (this.connectionMonitoringSetInterval) {
            window.clearInterval(this.connectionMonitoringSetInterval)
            this.connectionMonitoringSetInterval = 0
        }
    }
    */

    async _getStats (id = null) {
       // DEBUG(id ? `Getting stats from peer ${id}` : `Getting stats from all peers`)
        let peersToAnalyse = {};

        // if we want the stats for a specific peer
        if (id) {
            peersToAnalyse[id] = this._connectionsToMonitor[id];
            if (!peersToAnalyse[id]) {
                throw new Error(`Cannot get stats. Peer with id ${id} does not exist`);
            }
        } else {
            // else, get stats for all of them
            peersToAnalyse = this._connectionsToMonitor;
        }

        let statsEventList = [];

        for (const id in peersToAnalyse) {
            for (const connectionId in peersToAnalyse[id]) {
                const peerObject = peersToAnalyse[id][connectionId];
                const pc = peerObject.pc;

                // if this connection is closed, continue
                if (!pc || this._checkIfConnectionIsClosed(id, connectionId, pc)) {
                    continue;
                }

                try {
                    const prom = pc.getStats(null);
                    if (prom) {
                        const res = await prom;
                        // create an object from the RTCStats map
                        const statsObject = map2obj(res);

                        const parseStatsOptions = {remote: true};
                        const parsedStats = parseStats(res, peerObject.stats.parsed, parseStatsOptions);

                        const statsEventObject = {
                            event: 'stats',
                            tag: 'stats',
                            peerId: id,
                            connectionId: connectionId,
                            data: parsedStats
                        };

                        if (this.rawStats === true) {
                            statsEventObject.rawStats = res;
                        }
                        if (this.statsObject === true) {
                            statsEventObject.statsObject = statsObject;
                        }
                        if (this.filteredStats === true) {
                            statsEventObject.filteredStats = this._filteroutStats(statsObject);
                        }

                        if (peerObject.stream) {
                            statsEventObject.stream = peerObject.stream;
                        }
                        statsEventList.push(statsEventObject);

                        peerObject.stats.parsed = parsedStats;
                    } else {
                        DEBUG(`PeerConnection from peer ${id} did not return any stats data`);
                    }
                } catch (e) {
                    DEBUG(e);
                }
            }
        }

        return statsEventList;
    }

    _filteroutStats (stats = {}) {
        const fullObject = {...stats};
        for (const key in fullObject) {
            let stat = fullObject[key];
            if (!this.statsToMonitor.includes(stat.type)) {
                delete fullObject[key];
            }
        }

        return fullObject;
    }


    get peerConnectionListeners () {
        return {
            /*
            icecandidate: (id, pc, e) => {
                DEBUG('[pc-event] icecandidate | peerId: ${peerId}', e)

                this.emitEvent({
                    event: 'onicecandidate',
                    tag: 'connection',
                    peerId: id,
                    data: e.candidate
                })
            },
            */
            track: (id, connectionId, pc, e) => {
                DEBUG(`[pc-event] track | peerId: ${id}`, e);

                const track = e.track;
                const stream = e.streams[0];

                // save the remote stream
                if (id in this._connectionsToMonitor && connectionId in this._connectionsToMonitor[id]) {
                    this._connectionsToMonitor[id][connectionId].stream = stream;
                }

                // this.addTrackEventListeners(track)
                // this.emitEvent({
                //     event: 'ontrack',
                //     tag: 'track',
                //     peerId: id,
                //     data: {
                // 	stream: stream ? this.getStreamDetails(stream) : null,
                // 	track: track ? this.getMediaTrackDetails(track) : null,
                // 	title: e.track.kind + ':' + e.track.id + ' ' + e.streams.map(function (stream) {
                // 	    return 'stream:' + stream.id
                // 	})
                //     }
                // })
            },
            /*
            signalingstatechange: (id, pc) => {
                DEBUG(`[pc-event] signalingstatechange | peerId: ${id}`)
                this.emitEvent({
                    event: 'onsignalingstatechange',
                    tag: 'connection',
                    peerId: id,
                    data: {
                        signalingState: pc.signalingState,
                        localDescription: pc.localDescription,
                        remoteDescription: pc.remoteDescription
                    }
                })
            },
            iceconnectionstatechange: (id, pc) => {
                DEBUG(`[pc-event] iceconnectionstatechange | peerId: ${id}`)
                this.emitEvent({
                    event: 'oniceconnectionstatechange',
                    tag: 'connection',
                    peerId: id,
                    data: pc.iceConnectionState
                })
            },
            icegatheringstatechange: (id, pc) => {
                DEBUG(`[pc-event] icegatheringstatechange | peerId: ${id}`)
                this.emitEvent({
                    event: 'onicegatheringstatechange',
                    tag: 'connection',
                    peerId: id,
                    data: pc.iceGatheringState
                })
            },
            icecandidateerror: (id, pc, ev) => {
                DEBUG(`[pc-event] icecandidateerror | peerId: ${id}`)
                this.emitEvent({
                    event: 'onicecandidateerror',
                    tag: 'connection',
                    peerId: id,
                    error: {
                        errorCode: ev.errorCode
                    }
                })
            },
            connectionstatechange: (id, pc) => {
                DEBUG(`[pc-event] connectionstatechange | peerId: ${id}`)
                this.emitEvent({
                    event: 'onconnectionstatechange',
                    tag: 'connection',
                    peerId: id,
                    data: pc.connectionState
                })
            },
            negotiationneeded: (id, pc) => {
                DEBUG(`[pc-event] negotiationneeded | peerId: ${id}`)
                this.emitEvent({
                    event: 'onnegotiationneeded',
                    tag: 'connection',
                    peerId: id
                })
            },
            datachannel: (id, pc, event) => {
                DEBUG(`[pc-event] datachannel | peerId: ${id}`, event)
                this.emitEvent({
                    event: 'ondatachannel',
                    tag: 'datachannel',
                    peerId: id,
                    data: event.channel
                })
            }
            */
        };
    }

    _addPeerConnectionEventListeners (peerId, connectionId, pc) {
        DEBUG(`Adding event listeners for peer ${peerId} and connection ${connectionId}.`);

        eventListeners[connectionId] = {};
        Object.keys(this.peerConnectionListeners).forEach(eventName => {
            eventListeners[connectionId][eventName] = this.peerConnectionListeners[eventName].bind(this, peerId, connectionId, pc);
            pc.addEventListener(eventName, eventListeners[connectionId][eventName], false);
        });
    }

    _removePeerConnectionEventListeners(peerId, connectionId, pc) {
        if (connectionId in eventListeners) {
            // remove all PeerConnection listeners
            Object.keys(this.peerConnectionListeners).forEach(eventName => {
                pc.removeEventListener(eventName, eventListeners[connectionId][eventName], false);
            });

            // remove reference for this connection
            delete eventListeners[connectionId];
        }

        // also remove track listeners
        // pc.getSenders().forEach(sender => {
        //     if (sender.track) {
        //         this.removeTrackEventListeners(sender.track)
        //     }
        // })
        //
        // pc.getReceivers().forEach(receiver => {
        //     if (receiver.track) {
        //         this.removeTrackEventListeners(receiver.track)
        //     }
        // })
    }


}


export { Statistics };
