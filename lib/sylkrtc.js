'use strict';

import debug from 'debug';
import rtcninja from 'rtcninja';
import { Connection } from './connection';


// Public API

function createConnection(options = {}) {
    if (!rtcninja.hasWebRTC()) {
        throw new Error('WebRTC support not detected');
    }

    let conn = new Connection(options);
    conn._initialize();
    return conn;
}


// Some proxied functions from rtcninja

function isWebRTCSupported() {
    return rtcninja.hasWebRTC();
}

function attachMediaStream(element, stream) {
    return rtcninja.attachMediaStream(element, stream);
}

function closeMediaStream(stream) {
    rtcninja.closeMediaStream(stream);
}


export default {
    createConnection,
    debug,
    attachMediaStream, closeMediaStream, isWebRTCSupported
};
