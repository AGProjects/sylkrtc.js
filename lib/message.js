import debug from 'debug';
import { v4 as uuidv4 } from 'uuid';
import utils from './utils';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Message');


class Message extends EventEmitter {
    constructor(message, identity, state=null) {
        super();
        this._id = uuidv4();
        this._contentType   = message.content_type || message.contentType;
        this._sender        = identity;
        this._receiver      = message.account || null;
        this._type          = message.type;
        this._timestamp     = new Date(message.timestamp);
        this._state         = state;
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

    get state() {
        return this._state;
    }

    _setState(newState) {
        const oldState = this._state;
        this._state = newState;
        DEBUG(`Message ${this.id} state change: ${oldState} -> ${newState}`);
        this.emit('stateChanged', oldState, newState);
    }
}


export { Message };
