'use strict';

import transform from 'sdp-transform';


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


function createLocalSdp(pc, type, options) {
    if (type !== 'offer' && type !== 'answer') {
        return Promise.reject('type must be "offer" or "answer", but "' +type+ '" was given');
    }
    let p = new Promise(function(resolve, reject) {
        let createFunc;
        if (type === 'offer' ) {
            createFunc = pc.createOffer;
        } else {
            createFunc = pc.createAnswer;
        }
        createFunc.call(
            pc,
            // success
            function(desc) {
                pc.setLocalDescription(
                    desc,
                    // success
                    function() {
                        resolve(mungeSdp(pc.localDescription.sdp));
                    },
                    // failure
                    function(error) {
                        reject('Error setting local description: ' + error);
                    }
                );
            },
            // failure
            function(error) {
                reject('Error creating local SDP: ' + error);
            },
            options
        );
    });
    return p;
}


function mungeSdp(sdp) {
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


export default { Identity, createLocalSdp, mungeSdp };
