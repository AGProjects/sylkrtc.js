'use strict';

/* globals openpgp: true */

import 'regenerator-runtime/runtime';
import * as openpgp from 'openpgp';

onmessage = async function({ data: { action, keys, msg, pass}, ports: [port] }) {
    try {
        let result;
        switch (action) {
            case 'decrypt': {
                let privateKey;
                if (pass) {
                    privateKey = await openpgp.decryptKey({
                        privateKey: await openpgp.readKey({ armoredKey: keys.privateKey }),
                        passphrase: pass
                    });
                } else {
                    privateKey = await openpgp.readKey({ armoredKey: keys.privateKey });
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
