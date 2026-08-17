'use strict';

import debug from 'debug';

const DEBUG = debug('sylkrtc:LocationSharing');

const CONTENT_TYPE = 'application/sylk-location-sharing';

function isLocationSharing(contentType) {
    return contentType === CONTENT_TYPE;
}

async function decryptInPlace(entry, pgp) {
    const contentType = entry.content_type || entry.contentType;
    if (!isLocationSharing(contentType)) return;

    let wire;
    try {
        wire = JSON.parse(entry.content);
    } catch (e) {
        DEBUG('Malformed location-sharing envelope for %s: %s', entry.message_id || entry.messageId, e.message);
        entry.didDecrypt = false;
        return;
    }

    if (typeof wire.value !== 'string') {
        entry.didDecrypt = true;
        return;
    }

    if (!pgp) {
        DEBUG('No PGP context, cannot decrypt location value for %s', entry.message_id || entry.messageId);
        entry.didDecrypt = false;
        return;
    }

    let result;
    try {
        result = await pgp.decryptMessage({
            content: wire.value,
            message_id: entry.message_id || entry.messageId
        });
    } catch (e) {
        DEBUG('Location value decrypt threw for %s: %s', entry.message_id || entry.messageId, e.message);
        entry.didDecrypt = false;
        return;
    }

    if (!result || result.didDecrypt === false) {
        DEBUG('Failed to decrypt location value for %s', entry.message_id || entry.messageId);
        entry.didDecrypt = false;
        return;
    }

    wire.value = result.content;
    entry.content = JSON.stringify(wire);
    entry.didDecrypt = true;
}

function shouldSuppressErrorOnFailedDecrypt(contentType) {
    return isLocationSharing(contentType);
}

async function buildEncryptedEnvelope(action, coords, pgp, peerUri, envelopeId, extraFields = {}) {
    if (!pgp) return null;

    const plaintext = JSON.stringify(coords);
    let result;
    try {
        result = await pgp.encryptMessage(peerUri, { id: envelopeId, content: plaintext });
    } catch (e) {
        DEBUG('Location value encrypt threw for %s: %s', envelopeId, e.message);
        return null;
    }

    if (!result || result.didEncrypt !== true) {
        DEBUG('Location value did not encrypt for %s (no key?)', envelopeId);
        return null;
    }

    const envelope = {
        action,
        value: result.message,
        ...extraFields
    };
    return JSON.stringify(envelope);
}

export {
    CONTENT_TYPE,
    isLocationSharing,
    decryptInPlace,
    buildEncryptedEnvelope,
    shouldSuppressErrorOnFailedDecrypt
};
