'use strict';

import adapter from 'webrtc-adapter';
import { Connection } from './connection';


// Public API

function createConnection(options = {}) {
    if (!window.RTCPeerConnection) {
        throw new Error('WebRTC support not detected');
    }

    const conn = new Connection(options);
    conn._initialize();
    return conn;
}


export {
    createConnection
};
