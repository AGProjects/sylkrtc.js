'use strict';

import debug from 'debug';
import { EventEmitter } from 'events';
import 'regenerator-runtime/runtime';
import * as openpgp from 'openpgp';

const DEBUG = debug('sylkrtc:PGP');

const worker = new Worker('./worker.js');

class PGP extends EventEmitter {
    constructor(options={}, connection) {
        super();
        this._privateKey = options.privateKey || null;
        this._publicKey = options.publicKey || null;
        this._armoredPrivateKey = options.privateKey || null;
        this._armoredPublicKey = options.publicKey || null;
        this._cachedPublicKeys = new Map();
        this._connection = connection;

        if (this._privateKey !== null) {
            openpgp.readPrivateKey({armoredKey: this._privateKey}).then(privateKey => {
                if (options.password) {
                    return openpgp.decryptKey({privateKey: privateKey, passphrase: options.password});
                }
                return Promise.resolve(privateKey);
            }).then(privateKey => {
                this._privateKey = privateKey;
            });
        }

        if (this._publicKey !== null) {
            openpgp.readKey({ armoredKey: this._publicKey }).then(publicKey =>
                this._publicKey = publicKey
            );
        }

        if (this._privateKey && this._publicKey) {
            DEBUG('PGP messaging loaded and enabled');
        }
    }

    addPublicPGPKeys(keys) {
        for (let key of Object.keys(keys)) {
            this._cachedPublicKeys.set(key, keys[key]);
            this.emit('publicKeyAdded', {contact: key, key: keys[key]});
        }
    }

    generatePGPKeys(cb=null) {
        DEBUG('Generating PGP key');
        openpgp.generateKey({
            // we have to use rsa, Rreact native can't use elliptic curves
            type: 'rsa',
            rsaBits: 2048,
            // type: 'ecc',
            // curve: 'curve25519',
            userIDs: [{ name: this._displayName, email: this._id }], // you can pass multiple user IDs
            format: 'armored'
        }).then(result => {
            DEBUG('PGP key generated');

            this._armoredPublicKey = result.publicKey;
            this._armoredPrivateKey = result.privateKey;

            openpgp.readPrivateKey({ armoredKey: result.privateKey }).then(privateKey =>
                this._privateKey = privateKey
            );
            openpgp.readKey({ armoredKey: result.publicKey }).then(publicKey =>
                this._publicKey = publicKey
            );
            cb(result);
        });
    }

    exportKeys(password) {
        // let message = `${this._armoredPublicKey}\n${this._armoredPrivateKey}`.trim()
        const message = `${this._armoredPrivateKey}`.trim();
        return openpgp.createMessage({ text: message}).then(pgpMessage => {
            return openpgp.encrypt({
                message: pgpMessage,
                passwords: [password],
                config: { preferredCompressionAlgorithm: openpgp.enums.compression.zlib }
            });
        }).then(encryptedMessage => {
            let fullMessage = `${this._armoredPublicKey}\n${encryptedMessage}`;
            return {message: fullMessage, didEncrypt: true};
        }).catch(() => {
            return {message: '', didEncrypt: false};
        });
    }

    decryptKeyImport(message, password, cb=null) {
        const regexp = /(?<before>[^]*)(?<pgpMessage>-----BEGIN PGP MESSAGE-----[^]*-----END PGP MESSAGE-----)(?<after>[^]*)/ig;
        let pgpMessage, after, before = null;
        let match = regexp.exec(message.content);
        do {
            pgpMessage = match.groups.pgpMessage;
            before = match.groups.before;
            after = match.groups.after;
        } while((match = regexp.exec(message.content)) !== null);

        return openpgp.readMessage({
            armoredMessage: pgpMessage // parse armored message
        }).then(message => {
            return openpgp.decrypt({message, passwords: [password]});
        }).then(data => {
            message._content = `${before}${data.data}${after}`;
            message.didDecrypt = true;
            cb(message);
            return message;
        }).catch((error) => {
            DEBUG("Can't decrypt key: %s", error);
            let result = Object.assign({}, {didDecrypt: false});
            cb(result);
            return result;
        });
    }

    encryptMessage(uri, message) {
        let pgpMessage = '';
        let key = '';

        DEBUG("Attempt to encrypt message (%s)", message.id);
        return this._lookupPublicKey(uri).then(publicKey => {
            key = publicKey;
            if (key === null) {
                DEBUG("No public key found");
            }
            return openpgp.createMessage({ text: message.content});
        }).then(message => {
            pgpMessage = message;
            return openpgp.readKey({ armoredKey: key });
        }).then(publicKey => {
            return openpgp.encrypt({message: pgpMessage, encryptionKeys: [this._publicKey, publicKey]});
        }).then(encryptedMessage => {
            DEBUG("Message encrypted (%s)", message.id);
            return {message: encryptedMessage, didEncrypt: true};
        }).catch((error) => {
            DEBUG("Message not encrypted (%s): %s", message.id, error);
            return {message: message, didEncrypt: false};
        });
    }

    terminateWorker() {
        worker.terminate();
    }

    decryptMessage(message) {
        DEBUG("Attempt to decrypt message (%s)", message.message_id);
        return new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = function({ data }) {
                if (data.error !== undefined) {
                    DEBUG("Can't decrypt message (%s) %s", message.message_id, data.error);
                    resolve(Object.assign(message, {didDecrypt: false}));
                } else {
                    DEBUG("Message decrypted (%s)", message.message_id);
                    resolve(Object.assign(message, {content: data.result, didDecrypt: true}));
                }
            };
            let action = 'decrypt';
            let keys = { privateKey: this._armoredPrivateKey, publicKey: this._publicKey};
            const msg = message.content;
            worker.postMessage({ action, keys, msg }, [channel.port2]);
        });
    }

    _lookupPublicKey(uri) {
        let key = this._cachedPublicKeys.get(uri);
        if (key === undefined) {
            this._connection.lookupPublicKey(uri);
            return new Promise((resolve, reject) => {
                this._connection.once('publicKey', (message) => {
                    DEBUG("Fetched public key from server for %s", message.uri);
                    this.addPublicPGPKeys({[message.uri]: message.publicKey});
                    resolve(message.public_key);
                });
            });
        }
        return Promise.resolve(key);
    }
}


export { PGP };
