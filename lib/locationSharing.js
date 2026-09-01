'use strict';

import debug from 'debug';

const DEBUG = debug('sylkrtc:LocationSharing');

const CONTENT_TYPE = 'application/sylk-location-sharing';
const LOCATION_PAYLOAD_VERSION = '2.0';
const METADATA_ENVELOPE_VERSION = 2;
const VALUE_KEY = 'value';
const PGP_HEADER = '-----BEGIN PGP MESSAGE-----';

function jsonObject(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'object') {
        return Array.isArray(value) ? null : value;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const text = value.trim();
    if (!text.startsWith('{')) {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (e) {
        return null;
    }
}

function envelopeVersion(envelope) {
    if (!envelope || typeof envelope !== 'object') {
        return null;
    }
    const version = envelope.version;
    if (version === null || version === undefined || typeof version === 'boolean') {
        return null;
    }
    if (typeof version === 'number') {
        return Number.isFinite(version) ? Math.trunc(version) : null;
    }
    if (typeof version !== 'string') {
        return null;
    }
    const major = parseInt(version.trim().split('.')[0], 10);
    return Number.isNaN(major) ? null : major;
}

function locationMetadata(metadata) {
    const envelope = jsonObject(metadata);
    if (envelope === null) {
        return null;
    }
    const version = envelopeVersion(envelope);
    if (version === null || version < METADATA_ENVELOPE_VERSION) {
        return null;
    }
    return envelope;
}

function locationCoordinates(content, fromMetadata = null) {
    if (fromMetadata) {
        if (content !== null && typeof content === 'object') {
            try {
                return JSON.stringify(content);
            } catch (e) {
                return null;
            }
        }
        if (typeof content !== 'string') {
            return null;
        }
        return content.trim() ? content : null;
    }
    const body = jsonObject(content);
    if (body !== null) {
        const value = body[VALUE_KEY];
        return (typeof value === 'string' && value.trim()) ? value : null;
    }
    if (typeof content !== 'string') {
        return null;
    }
    const blob = content.trim();
    return blob ? blob : null;
}

function locationEnvelope(content, metadata) {
    const fromMetadata = locationMetadata(metadata);
    if (fromMetadata === null) {
        return jsonObject(content);
    }
    const coordinates = locationCoordinates(content, fromMetadata);
    const envelope = {};
    for (const key of Object.keys(fromMetadata)) {
        if (key === VALUE_KEY) {
            continue;
        }
        envelope[key] = fromMetadata[key];
        if (key === 'action' && coordinates) {
            envelope[VALUE_KEY] = coordinates;
        }
    }
    if (coordinates && !(VALUE_KEY in envelope)) {
        envelope[VALUE_KEY] = coordinates;
    }
    return envelope;
}

function splitLocationEnvelope(envelope) {
    const fields = jsonObject(envelope);
    if (fields === null) {
        return null;
    }
    const metadata = Object.assign({}, fields);
    const coordinates = (typeof fields[VALUE_KEY] === 'string' && fields[VALUE_KEY].trim())
        ? fields[VALUE_KEY] : '';
    delete metadata[VALUE_KEY];
    metadata.version = LOCATION_PAYLOAD_VERSION;
    return {content: coordinates, metadata: metadata};
}

function isArmouredBlob(content) {
    return typeof content === 'string' && content.trimStart().startsWith(PGP_HEADER);
}

function isLocationSharing(contentType) {
    return contentType === CONTENT_TYPE;
}

// Decrypt a location tick's coordinates in place. v2: content is the
// armoured blob, envelope rides in metadata. v1: content is a JSON
// envelope, blob is under `value`.
async function decryptInPlace(entry, pgp) {
    const contentType = entry.content_type || entry.contentType;
    if (!isLocationSharing(contentType)) return;

    const messageId = entry.message_id || entry.messageId;
    const envelope = locationMetadata(entry.metadata);

    if (envelope !== null) {
        const content = typeof entry.content === 'string' ? entry.content : '';
        if (content.trim() === '') {
            entry.didDecrypt = true;
            return;
        }
        if (!isArmouredBlob(content)) {
            entry.didDecrypt = true;
            return;
        }
        if (!pgp) {
            DEBUG('No PGP context, cannot decrypt location content for %s', messageId);
            entry.didDecrypt = false;
            return;
        }
        let result;
        try {
            result = await pgp.decryptMessage({ content: content, message_id: messageId });
        } catch (e) {
            DEBUG('Location content decrypt threw for %s: %s', messageId, e.message);
            entry.didDecrypt = false;
            return;
        }
        if (!result || result.didDecrypt === false) {
            DEBUG('Failed to decrypt location content for %s', messageId);
            entry.didDecrypt = false;
            return;
        }
        entry.content = result.content;
        entry.didDecrypt = true;
        return;
    }

    const wire = jsonObject(entry.content);
    if (wire === null) {
        DEBUG('Malformed location-sharing envelope for %s', messageId);
        entry.didDecrypt = false;
        return;
    }

    if (typeof wire.value !== 'string') {
        entry.didDecrypt = true;
        return;
    }

    if (!pgp) {
        DEBUG('No PGP context, cannot decrypt location value for %s', messageId);
        entry.didDecrypt = false;
        return;
    }

    let result;
    try {
        result = await pgp.decryptMessage({
            content: wire.value,
            message_id: messageId
        });
    } catch (e) {
        DEBUG('Location value decrypt threw for %s: %s', messageId, e.message);
        entry.didDecrypt = false;
        return;
    }

    if (!result || result.didDecrypt === false) {
        DEBUG('Failed to decrypt location value for %s', messageId);
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

// Encrypt a plaintext location envelope for sending, and split it into the
// v2 wire pair in one step. `envelope` is {action, value?, ...fields} where
// `value`, if present, is still PLAINTEXT (the caller's outgoing Message
// keeps this same plaintext string as its content - only the wire payload
// gets encrypted). Returns {content, metadata} for the wire, or null if
// `envelope` isn't a location envelope at all.
async function encryptEnvelopeForSend(envelope, pgp, peerUri, messageId) {
    const fields = jsonObject(envelope);
    if (fields === null) {
        return null;
    }
    const plaintext = typeof fields[VALUE_KEY] === 'string' ? fields[VALUE_KEY] : null;
    let encryptedValue = '';
    if (plaintext) {
        if (!pgp) {
            DEBUG('No PGP context, cannot encrypt location value for %s', messageId);
            return null;
        }
        let result;
        try {
            result = await pgp.encryptMessage(peerUri, { id: messageId, content: plaintext });
        } catch (e) {
            DEBUG('Location value encrypt threw for %s: %s', messageId, e.message);
            return null;
        }
        if (!result || result.didEncrypt !== true) {
            DEBUG('Location value did not encrypt for %s (no key?)', messageId);
            return null;
        }
        encryptedValue = result.message;
    }
    return splitLocationEnvelope({ ...fields, value: encryptedValue });
}

export {
    CONTENT_TYPE,
    isLocationSharing,
    locationEnvelope,
    splitLocationEnvelope,
    decryptInPlace,
    encryptEnvelopeForSend,
    shouldSuppressErrorOnFailedDecrypt
};
