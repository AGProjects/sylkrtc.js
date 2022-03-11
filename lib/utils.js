'use strict';

import transform from 'sdp-transform';
import attachMediaStream from '@rifflearning/attachmediastream';
import DOMPurify from 'dompurify';

class Identity {
    constructor(uri, displayName=null) {
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


class SharedFile {
    constructor(filename, filesize, uploader, session) {
        this._filename = filename;
        this._filesize = filesize;
        this._uploader = uploader;
        this._session = session;
    }

    get filename() {
        return this._filename;
    }

    get filesize() {
        return this._filesize;
    }

    get uploader() {
        return this._uploader;
    }

    get session() {
        return this._session;
    }
}


function createLocalSdp(pc, type, options) {
    if (type !== 'offer' && type !== 'answer') {
        return Promise.reject('type must be "offer" or "answer", but "' +type+ '" was given');
    }
    let p = new Promise(function(resolve, reject) {
        let createFunc;
        if (type === 'offer' ) {
            createFunc = 'createOffer';
        } else {
            createFunc = 'createAnswer';
        }
        pc[createFunc](options)
            .then((desc) => {
                return pc.setLocalDescription(desc);
            })
            .then(() => {
                resolve(mungeSdp(pc.localDescription.sdp));
            })
            // failure
            .catch((error) => {
                reject('Error creating local SDP or setting local description: ' + error);
            });
    });
    return p;
}


function mungeSdp(sdp, fixmsid=false) {
    let parsedSdp = transform.parse(sdp);
    let h264payload = null;
    let hasProfileLevelId = false;

    // try to fix H264 support
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
                        break;
                    }
                }
                if (!hasProfileLevelId) {
                    media.fmtp.push({
                        payload: h264payload,
                        config: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1'
                    });
                }
                break;
            }
        }
    }

    if (fixmsid === true) {
        const randomNumber = Math.floor(100000 + Math.random() * 900000);
        for (let media of parsedSdp.media) {
            media.msid = media.msid + '-' + randomNumber;
            for(let ssrc of media.ssrcs) {
                if (ssrc.attribute === 'msid') {
                    ssrc.value = ssrc.value + '-' + randomNumber;
                }
            }
        }
    }

    // remove bogus rtcp-fb elements
    for (let media of parsedSdp.media) {
        let payloads = String(media.payloads).split(' ');
        if (media.rtcpFb) {
            media.rtcpFb = media.rtcpFb.filter((item) => {
                return payloads.indexOf(String(item.payload)) !== -1;
            });
        }
    }

    return transform.write(parsedSdp);
}

function getMediaDirections(sdp) {
    const parsedSdp = transform.parse(sdp);
    const directions = {};
    for (let media of parsedSdp.media) {
        directions[media.type] = (directions[media.type] || []).concat(media.direction);
    }
    return directions;
}

function closeMediaStream(stream) {
    if (!stream) {
        return;
    }

    // Latest spec states that MediaStream has no stop() method and instead must
    // call stop() on every MediaStreamTrack.
    if (MediaStreamTrack && MediaStreamTrack.prototype && MediaStreamTrack.prototype.stop) {
        if (stream.getTracks) {
            for (let track of stream.getTracks()) {
                track.stop();
            }
        } else {
            for (let track of stream.getAudioTracks()) {
                track.stop();
            }

            for (let track of stream.getVideoTracks()) {
                track.stop();
            }
        }
    // Deprecated by the spec, but still in use.
    } else if (typeof stream.stop === 'function') {
        stream.stop();
    }
}

function sanatizeHtml(html) {
    return DOMPurify.sanitize(html.trim());
}


export function removeAllowExtmapMixed() {
      /* remove a=extmap-allow-mixed for Chrome < M71 */
      if (!window.RTCPeerConnection) {
              return;
      }
      const nativeSRD = window.RTCPeerConnection.prototype.setRemoteDescription;
      window.RTCPeerConnection.prototype.setRemoteDescription = function(desc) {
          if (desc && desc.sdp && desc.sdp.indexOf('\na=extmap-allow-mixed') !== -1) {
              desc.sdp = desc.sdp.split('\n').filter((line) => {
                  return line.trim() !== 'a=extmap-allow-mixed';
              }).join('\n');
          }
          return nativeSRD.apply(this, arguments);
      };
}

function _addAdditionalData (currentStats, previousStats) {
    // we need the previousStats stats to compute thse values
    if (!previousStats) {
        return currentStats;
    }

    // audio
    // inbound
    currentStats.audio.inbound.map((report) => {
        let prev = previousStats.audio.inbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesReceived');
        report.packetRate = _computeBitrate(report, prev, 'packetsReceived');
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });
    // outbound
    currentStats.audio.outbound.map((report) => {
        let prev = previousStats.audio.outbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesSent');
        report.packetRate = _computeBitrate(report, prev, 'packetsSent');
    });

    currentStats.remote.audio.inbound.map((report) => {
        let prev = previousStats.remote.video.inbound.find(r => r.id === report.id);
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });

    // video
    // inbound
    currentStats.video.inbound.map((report) => {
        let prev = previousStats.video.inbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesReceived');
        report.packetRate = _computeRate(report, prev, 'packetsReceived');
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });
    // outbound
    currentStats.video.outbound.map((report) => {
        let prev = previousStats.video.outbound.find(r => r.id === report.id);
        report.bitrate = _computeBitrate(report, prev, 'bytesSent');
        report.packetRate = _computeRate(report, prev, 'packetsSent');
    });

    currentStats.remote.video.inbound.map((report) => {
        let prev = previousStats.remote.video.inbound.find(r => r.id === report.id);
        report.packetLossRate = _computeRate(report, prev, 'packetsLost');
    });

    return currentStats;
}

function _getCandidatePairInfo (candidatePair, stats) {
    if (!candidatePair || !stats) {
        return {};
    }

    const connection = {...candidatePair};

    if (connection.localCandidateId) {
        const localCandidate = stats.get(connection.localCandidateId);
        connection.local = {...localCandidate};
    }

    if (connection.remoteCandidateId) {
        const remoteCandidate = stats.get(connection.remoteCandidateId);
        connection.remote = {...remoteCandidate};
    }

    return connection;
}

// Takes two stats reports and determines the rate based on two counter readings
// and the time between them (which is in units of milliseconds).
function _computeRate (newReport, oldReport, statName) {
    const newVal = newReport[statName];
    const oldVal = oldReport ? oldReport[statName] : null;
    if (newVal === null || oldVal === null) {
        return null;
    }
    if (newVal < oldVal) {
        return 0;
    }
    return (newVal - oldVal) / (newReport.timestamp - oldReport.timestamp) * 1000;
}

// Convert a byte rate to a bit rate.
function _computeBitrate (newReport, oldReport, statName) {
    return _computeRate(newReport, oldReport, statName) * 8;
}

export function parseStats (stats, previousStats, options= {}) {
    // Create an object structure with all the needed stats and types that we care
    // about. This allows to map the getStats stats to other stats names.

    if (!stats) {
        return null;
    }

    /**
     * The starting object where we will save the details from the stats report
     * @type {Object}
     */
        let statsObject = {
            audio: {
                inbound: [],
                outbound: []
            },
            video: {
                inbound: [],
                outbound: []
            },
            connection: {
                inbound: [],
                outbound: []
            }
        };

    // if we want to collect remote data also
    if (options.remote) {
        statsObject.remote = {
            audio:{
                inbound: [],
                outbound: []
            },
            video:{
                inbound: [],
                outbound: []
            }
        };
    }

    for (const report of stats.values()) {
        switch (report.type) {
            case 'outbound-rtp': {
                // let outbound = {};
                const mediaType = report.mediaType || report.kind;
                const codecInfo = {};
                if (!['audio', 'video'].includes(mediaType)) {
                    continue;
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                    }
                }

                statsObject[mediaType].outbound.push({...report, ...codecInfo});
                break;
            }
            case 'inbound-rtp': {
                // let inbound = {};
                let mediaType = report.mediaType || report.kind;
                const codecInfo = {};

                // Safari is missing mediaType and kind for 'inbound-rtp'
                if (!['audio', 'video'].includes(mediaType)) {
                    if (report.id.includes('Video')) {
                        mediaType = 'video';
                    } else if (report.id.includes('Audio')) {
                        mediaType = 'audio';
                    } else {
                        continue;
                    }
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                    }
                }

                // if we don't have connection details already saved
                // and the transportId is present (most likely chrome)
                // get the details from the candidate-pair
                if (!statsObject.connection.id && report.transportId) {
                    const transport = stats.get(report.transportId);
                    if (transport && transport.selectedCandidatePairId) {
                        const candidatePair = stats.get(transport.selectedCandidatePairId);
                        statsObject.connection = _getCandidatePairInfo(candidatePair, stats);
                    }
                }

                statsObject[mediaType].inbound.push({...report, ...codecInfo});
                break;
            }
            case 'peer-connection': {
                statsObject.connection.dataChannelsClosed = report.dataChannelsClosed;
                statsObject.connection.dataChannelsOpened = report.dataChannelsOpened;
                break;
            }
            case 'remote-inbound-rtp': {
                if(!options.remote) {
                    break;
                }
                // let inbound = {};
                let mediaType = report.mediaType || report.kind;
                const codecInfo = {};

                // Safari is missing mediaType and kind for 'inbound-rtp'
                if (!['audio', 'video'].includes(mediaType)) {
                    if (report.id.includes('Video')) {
                        mediaType = 'video';
                    } else if (report.id.includes('Audio')) {
                        mediaType = 'audio';
                    } else {
                        continue;
                    }
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                    }
                }

                // if we don't have connection details already saved
                // and the transportId is present (most likely chrome)
                // get the details from the candidate-pair
                if (!statsObject.connection.id && report.transportId) {
                    const transport = stats.get(report.transportId);
                    if (transport && transport.selectedCandidatePairId) {
                        const candidatePair = stats.get(transport.selectedCandidatePairId);
                        statsObject.connection = _getCandidatePairInfo(candidatePair, stats);
                    }
                }

                statsObject.remote[mediaType].inbound.push({...report, ...codecInfo});
                break;
            }
            case 'remote-outbound-rtp': {
                if(!options.remote) {
                    break;
                }
                // let outbound = {};
                const mediaType = report.mediaType || report.kind;
                const codecInfo = {};
                if (!['audio', 'video'].includes(mediaType)) {
                    continue;
                }

                if (report.codecId) {
                    const codec = stats.get(report.codecId);
                    if (codec) {
                        codecInfo.clockRate = codec.clockRate;
                        codecInfo.mimeType = codec.mimeType;
                        codecInfo.payloadType = codec.payloadType;
                    }
                }

                statsObject.remote[mediaType].outbound.push({...report, ...codecInfo});
                break;
            }
            default:
        }
    }

    // if we didn't find a candidate-pair while going through inbound-rtp
    // look for it again
    if (!statsObject.connection.id) {
        for (const report of stats.values()) {
            // select the current active candidate-pair report
            if (report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded') {
                statsObject.connection = _getCandidatePairInfo(report, stats);
            }
        }
    }

    statsObject = _addAdditionalData(statsObject, previousStats);

    return statsObject;
}

export function map2obj (stats) {
    if (!stats.entries) {
        return stats;
    }
    const o = {};
    stats.forEach(function (v, k) {
        o[k] = v;
    });
    return o;
}


export default {
    Identity,
    SharedFile,
    createLocalSdp,
    mungeSdp,
    getMediaDirections,
    attachMediaStream,
    closeMediaStream,
    sanatizeHtml,
    removeAllowExtmapMixed,
    map2obj,
    parseStats
};
