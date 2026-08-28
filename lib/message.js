import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

import utils from './utils';
import { isLocationSharing, locationEnvelope } from './locationSharing.js';

const DEBUG = debug('sylkrtc:Message');

const PARSED_CONTENT_TYPES = new Set([
    'application/sylk-file-transfer',
    'application/sylk-message-metadata',
    'application/sylk-location-sharing'
]);

class Message extends EventEmitter {
    constructor(message, identity, state = null) {
        super();
        this._id = message.message_id || uuidv4();
        this._contentType = message.content_type || message.contentType;
        this._sender = identity;
        this._receiver = message.account || null;
        this._type = message.type;
        this._dispositionNotification = message.disposition_notification || message.disposition || [];
        this._timestamp = new Date(message.timestamp);
        this._dispositionState = null;
        this._state = state;
        this._jsonError = false;

        this._wireMetadata = Message._parseWireMetadata(message.metadata);

        this._json = undefined;
        if (PARSED_CONTENT_TYPES.has(this._contentType)) {
            this._parseContent(message.content);
        }

        this._metadata = [];
        this._isSecure = message.isSecure || this._isSecure || false;
        this._chunkIds = message.chunkIds || [];
        this._content = this._contentType === 'text/html'
            ? utils.sanatizeHtml(message.content)
            : message.content;
    }

    // The cleartext per-message side-band carried beside the content (the
    // CPIM `Metadata` body header) - distinct from `metadata`, the
    // application/sylk-message-metadata bag the app maintains for a message.
    // Revives dates here so locationEnvelope() can just copy fields through.
    static _parseWireMetadata(metadata) {
        if (typeof metadata === 'string') {
            try {
                return JSON.parse(metadata, utils.parseDates);
            } catch (e) {
                return metadata;
            }
        }
        if (metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)) {
            // Pre-parsed metadata still needs the reviver pass; stringifying
            // it and parsing it back is the only way to run a JSON.parse
            // reviver on an object that didn't arrive as JSON text.
            try {
                return JSON.parse(JSON.stringify(metadata), utils.parseDates);
            } catch (e) {
                return metadata;
            }
        }
        return null;
    }

    _parseContent(content) {
        if (isLocationSharing(this._contentType)) {
            // One whole envelope, whichever payload version it arrived in.
            const envelope = locationEnvelope(content, this._wireMetadata);
            if (envelope === null) {
                this._json = {};
                this._jsonError = true;
                return;
            }
            this._json = envelope;
            return;
        }
        try {
            this._json = JSON.parse(content, utils.parseDates);
            this._isSecure = this._json.filename && this._json.filename.endsWith('.asc');
        } catch (e) {
            this._json = {};
            this._jsonError = true;
        }
    }

    get id() {
        return this._id;
    }

    get content() {
        return this._content;
    }

    get contentType() {
        return this._contentType;
    }

    get dispositionNotification() {
        return this._dispositionNotification;
    }

    get sender() {
        return this._sender;
    }

    get receiver() {
        return this._receiver;
    }

    get timestamp() {
        return this._timestamp;
    }

    get type() {
        return this._type;
    }

    get dispositionState() {
        return this._dispositionState;
    }

    get state() {
        return this._state;
    }

    get json() {
        return this._json;
    }

    get jsonError() {
        return this._jsonError;
    }

    get isSecure() {
        return this._isSecure;
    }

    get chunkIds() {
        return this._chunkIds;
    }

    get metadata() {
        return this._metadata;
    }

    get wireMetadata() {
        return this._wireMetadata;
    }

    toJSON() {
        return {
            id: this._id,
            content: this._content,
            contentType: this._contentType,
            dispositionNotification: this._dispositionNotification,
            dispositionState: this.dispositionState,
            sender: { uri: this._sender.uri, displayName: this._sender.displayName },
            receiver: this._receiver,
            timestamp: this._timestamp,
            type: this._type,
            state: this._state,
            isSecure: this._isSecure,
            chunkIds: this._chunkIds,
            metadata: this._metadata
        };
    }

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;
        DEBUG(`Message ${this.id} state change: ${oldState} -> ${newState}`);
        this.emit('stateChanged', oldState, newState);
    }

    _setDispositionState(newState) {
        const oldState = this._dispositionState;
        this._dispositionState = newState;
        DEBUG(`Message ${this.id} dispositionState state change: ${oldState} -> ${newState}`);
        this.emit('dispositionStateChanged', oldState, newState);
    }
}


export { Message };
