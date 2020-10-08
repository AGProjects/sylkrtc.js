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
                    media.fmtp.push({payload: h264payload, config: 'profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1'});
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

export default { Identity, SharedFile, createLocalSdp, mungeSdp, getMediaDirections, attachMediaStream, closeMediaStream,  sanatizeHtml};
