'use strict';

import rtcninja from 'rtcninja';
import transform from 'sdp-transform';


function getUserMedia(mediaConstraints, localStream=null) {
    if (localStream !== null) {
        return Promise.resolve(localStream);
    }

    let p = new Promise(function(resolve, reject) {
        rtcninja.getUserMedia(
            mediaConstraints,
            //success
            function(stream) {
                resolve(stream);
            },
            // failure
            function(error) {
                reject('Error getting user media: %s', error);
            }
        );
    });

    return p;
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
                        resolve(fixupSdp(pc.localDescription.sdp));
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


function fixupSdp(sdp) {
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
    return transform.write(parsedSdp);
}


export default { getUserMedia, createLocalSdp };
