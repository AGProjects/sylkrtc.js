'use strict';

/* globals openpgp: true */

import 'regenerator-runtime/runtime';
import * as openpgp from 'openpgp';

onmessage = async function({ data: { action, data, msg, pass}, ports: [port] }) {
    try {
        let result;
        switch (action) {
            case 'generateKey': {
                result = await openpgp.generateKey({
                    // we have to use rsa, Rreact native can't use elliptic curves
                    type: 'rsa',
                    rsaBits: 2048,
                    // type: 'ecc',
                    // curve: 'curve25519',
                    userIDs: [{ name: data.name, email: data.email}], // you can pass multiple user IDs
                    format: 'armored'
                });
                break;
            }
            case 'decrypt': {
                let privateKey;
                if (pass) {
                    privateKey = await openpgp.decryptKey({
                        privateKey: await openpgp.readKey({ armoredKey: data.privateKey }),
                        passphrase: pass
                    });
                } else {
                    privateKey = await openpgp.readKey({ armoredKey: data.privateKey });
                }
                const { data } = await openpgp.decrypt({
                    message: await openpgp.readMessage({ armoredMessage: msg }),
                    decryptionKeys: privateKey
                });
                result = data;
                break;
            }
        }
        port.postMessage({ result });
    } catch (e) {
        port.postMessage({ error: e.message });
    }
};
