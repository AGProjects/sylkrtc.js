'use strict';

import debug from 'debug';

import { EventEmitter } from 'events';

const DEBUG = debug('sylkrtc:Addressbook');

class Addressbook extends EventEmitter {
    constructor(connection) {
        super();
        this._connection = connection
        this._contacts = new Map();
        this._groups = new Map();
        this._policies = new Map();
    }

    get contacts() {
        return this._serialize([...this._contacts.values()]);
    }

    get policies() {
        return this._serialize([...this._policies.values()]);
    }

    get groups() {
        return this._serialize([...this._groups.values()]);
    }

    getContact(contactId) {
        const contact = this._contacts.get(contactId);
        return contact ? this._serialize(contact) : null;
    }

    addContact(contact, cb = null) {
        if (!contact) {
            if (cb) cb(new Error('No contact provided'));
            return;
        }
        this._contacts.set(contact.id, contact);
        this._applyToAllAccounts('add', 'contact', contact, cb);
    }

    updateContact(contact, cb = null) {
        if (!contact) {
            if (cb) cb(new Error('No contact provided'));
            return;
        }
        this._contacts.set(contact.id, contact);
        this._applyToAllAccounts('update', 'contact', contact, cb);
    }

    deleteContact(contactId, cb = null) {
        const contact = this._contacts.get(contactId);
        if (contact) {
            this._contacts.delete(contactId);
        }
        this._applyToAllAccounts('delete', 'contact', contact || { id: contactId }, cb);
    }

    getPolicy(policyId) {
        const policy = this._policies.get(policyId);
        return policy ? this._serialize(policy) : null;
    }

    addPolicy(policy, cb = null) {
        if (!policy) {
            if (cb) cb(new Error('No policy provided'));
            return;
        }
        this._policies.set(policy.id, policy);
        this._applyToAllAccounts('add', 'policy', policy, cb);
    }

    updatePolicy(policy, cb = null) {
        if (!policy) {
            if (cb) cb(new Error('No policy provided'));
            return;
        }
        this._policies.set(policy.id, policy);
        this._applyToAllAccounts('update', 'policy', policy, cb);
    }

    deletePolicy(policyId, cb = null) {
        const policy = this._policies.get(policyId);
        if (policy) {
            this._policies.delete(policyId);
        }
        this._applyToAllAccounts('delete', 'policy', policy || {id: policyId}, cb);
    }

    getGroup(groupId) {
        const group = this._groups.get(groupId);
        return group ? this._serialize(group) : null;
    }

    addGroup(group, cb = null) {
        if (!group) {
            if (cb) cb(new Error('No group provided'));
            return;
        }
        this._groups.set(group.id, group);
        this._applyToAllAccounts('add', 'group', group, cb);
    }

    updateGroup(group, cb = null) {
        if (!group) {
            if (cb) cb(new Error('No group provided'));
            return;
        }
        this._groups.set(group.id, group);
        this._applyToAllAccounts('update', 'group', group, cb);
    }

    deleteGroup(groupId, cb = null) {
        const group = this._groups.get(groupId);
        if (group) {
            this._groups.delete(groupId);
        }
        this._applyToAllAccounts('delete', 'group', group || {id: groupId}, cb);
    }

    addGroupMember(groupId, contactId, cb = null) {
        const group = this._groups.get(groupId);
        const contact = this._contacts.get(contactId);
        if (group && contact) {
            group.contacts.push(contact);
        }
        this._applyToAllAccounts('add', 'groupMember', { groupId, contactId }, cb);
    }

    deleteGroupMember(groupId, contactId, cb = null) {
        const group = this._groups.get(groupId);
        if (group) {
            const index = group.contacts.findIndex(c => c.id === contactId);
            if (index > -1) {
                group.contacts.splice(index, 1);
            }
            this._applyToAllAccounts('delete', 'groupMember', { groupId, contactId }, cb);
        }
    }

    load(addressbookData) {
        this._populate(addressbookData);
        this.emit('dataCacheLoaded');
    }


    // Private API
    _serialize(data) {
        return JSON.parse(JSON.stringify(data));
    }

    _populate(addressbookData) {
        for (const contact of addressbookData.contacts) {
            this._contacts.set(contact.id, contact);
        }
        for (const policy of addressbookData.policies) {
            this._policies.set(policy.id, policy);
        }
        for (const group of addressbookData.groups) {
            this._groups.set(group.id, group);
        }
    }

    _load(addressbookData) {
        this._populate(addressbookData);
        this.emit('dataLoaded');
    }

    _update(addressbookData) {
        if (addressbookData.action === 'delete') {
            this.emit('dataDeleted', { type: addressbookData.type, data: addressbookData[addressbookData.type] });
        } else {
            if (addressbookData.type && addressbookData[addressbookData.type]) {
                switch (addressbookData.type) {
                    case 'contact':
                        this._contacts.set(addressbookData.contact.id, addressbookData.contact);
                        break;
                    case 'policy':
                        this._policies.set(addressbookData.policy.id, addressbookData.policy);
                        break;
                    case 'group':
                        this._groups.set(addressbookData.group.id, addressbookData.group);
                        break;
                    default:
                        break;
                }
            }
        }
        this.emit('dataUpdated');
    }

    _updateFailed(errorData) {
        const { error, action, type, id } = errorData;
        this.emit('dataUpdateFailed', { error, action, type, id });
    }

    async _applyToAllAccounts(action, type, data, cb = null) {
        if (!this._connection || this._connection.state !== 'ready') {
            if (cb) {
                cb(new Error('Connection is not ready'));
            }
            return;
        }

        const accounts = [...this._connection._accounts.values()]
            .filter(account => account._addressbookFetched);

        if (accounts.length === 0) {
            if (cb) cb(null);
            return;
        }

        try {
            for (const account of accounts) {
                await account._updateAddressbook(action, type, data);
            }
            if (cb) {
                cb(null);
            }
        } catch (error) {
            if (action === 'add' && type !== 'groupMember') {
                DEBUG("Reverting: %s - %s - %s", data.id, action, type);
                const target = this[`_${type}s`];
                target.delete(data.id);
                this.emit('dataLoaded');
            }
            if (cb) {
                cb(error);
            }
        }
    }
}

export { Addressbook };
