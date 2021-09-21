import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import utils from './utils';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Message');


class Message extends EventEmitter {
    constructor(message, identity, state=null) {
        super();
        this._id = message.message_id || uuidv4();
        this._contentType   = message.content_type || message.contentType;
        this._sender        = identity;
        this._receiver      = message.account || null;
        this._type          = message.type;
        this._dispositionNotification = message.disposition_notification || message.disposition || [];
        this._timestamp     = new Date(message.timestamp);
        this._dispositionState = null;
        this._state         = state;
        this._isSecure      = message.isSecure || false;
        if (message.content_type === 'text/html') {
            this._content = utils.sanatizeHtml(message.content);
        } else {
            this._content = message.content;
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

    get isSecure() {
        return this._isSecure;
    }

    toJSON() {
        return {
            id: this._id,
            content: this._content,
            contentType: this._contentType,
            dispositionNotification: this._dispositionNotification,
            dispositionState: this.dispositionState,
            sender: {uri: this._sender.uri, displayName: this._sender.displayName},
            receiver: this._receiver,
            timestamp: this._timestamp,
            type: this._type,
            state: this._state,
            isSecure: this._isSecure
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
