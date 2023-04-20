'use strict';

/* globals openpgp: true */

import 'regenerator-runtime/runtime';
import * as openpgp from 'openpgp';

onmessage = async function({ data: { action, inputData, msg, pass }, ports: [port] }) {
    try {
        let result;
        let fileName;
        switch (action) {
            case 'generateKey': {
                result = await openpgp.generateKey({
                    // we have to use rsa, Rreact native can't use elliptic curves
                    type: 'rsa',
                    rsaBits: 2048,
                    // type: 'ecc',
                    // curve: 'curve25519',
                    userIDs: [{ name: inputData.name, email: inputData.email }], // you can pass multiple user IDs
                    format: 'armored'
                });
                break;
            }
            case 'decrypt': {
                let privateKey;
                if (pass) {
                    privateKey = await openpgp.decryptKey({
                        privateKey: await openpgp.readKey({ armoredKey: inputData.privateKey }),
                        passphrase: pass
                    });
                } else {
                    privateKey = await openpgp.readKey({ armoredKey: inputData.privateKey });
                }
                const { data } = await openpgp.decrypt({
                    message: await openpgp.readMessage({ armoredMessage: msg }),
                    decryptionKeys: privateKey,
                    ...(inputData.format) && { format: inputData.format }
                });
                result = data;
                fileName = filename
                break;
            }
        }
        port.postMessage({ result, filename: fileName });
    } catch (e) {
        port.postMessage({ error: e.message });
    }
};
