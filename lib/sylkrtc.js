'use strict';

import adapter from 'webrtc-adapter';
import { Connection } from './connection';
import _utils from './utils';


// Public API

function createConnection(options = {}) {
    if (!window.RTCPeerConnection) {
        throw new Error('WebRTC support not detected');
    }

    const conn = new Connection(options);
    conn._initialize();
    return conn;
}


const utils = {
    'attachMediaStream': _utils.attachMediaStream,
    'closeMediaStream': _utils.closeMediaStream,
    'sanatizeHtml': _utils.sanatizeHtml
};


export {
    createConnection,
    utils
};
