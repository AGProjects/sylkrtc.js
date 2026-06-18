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
        this._contactsByAccount = new Map();
        this._policiesByAccount = new Map();
        this._groupsByAccount = new Map();
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
        }
        this._applyToAllAccounts('delete', 'groupMember', { groupId, contactId }, cb);
    }

    load(accountId, addressbookData) {
        this._populate(accountId, addressbookData);
        this.emit('dataCacheLoaded');
    }


    // Private API
    _serialize(data) {
        return JSON.parse(JSON.stringify(data));
    }

    _rebuild() {
        this._contacts.clear();
        this._policies.clear();
        this._groups.clear();

        for (const map of this._contactsByAccount.values()) {
            for (const [id, c] of map) {
                this._contacts.set(id, c);
            }
        }

        for (const map of this._policiesByAccount.values()) {
            for (const [id, p] of map) {
                this._policies.set(id, p);
            }
        }

        for (const map of this._groupsByAccount.values()) {
            for (const [id, g] of map) {
                this._groups.set(id, g);
            }
        }
    }

    _populate(accountId, addressbookData) {
        const contacts = new Map();
        for (const c of addressbookData.contacts) {
            contacts.set(c.id, c);
        }

        const policies = new Map();
        for (const p of addressbookData.policies) {
            policies.set(p.id, p);
        }

        const groups = new Map();
        for (const g of addressbookData.groups) {
            groups.set(g.id, g);
        }
        if (contacts.size > 0) {
            this._contactsByAccount.set(accountId, contacts);
        }
        if (policies.size > 0) {
            this._policiesByAccount.set(accountId, policies);
        }
        if (groups.size > 0) {
            this._groupsByAccount.set(accountId, groups);
        }
        this._rebuild();
    }

    _load(accountId, addressbookData) {
        const hasCache = this._contactsByAccount.has(accountId)
              || this._policiesByAccount.has(accountId)
              || this._groupsByAccount.has(accountId);
        const isEmpty  = addressbookData.contacts.length === 0
            && addressbookData.policies.length === 0
            && addressbookData.groups.length === 0;

        if (hasCache && isEmpty) {
            DEBUG('Ignoring empty server response, keeping cached data for %s', accountId);
            return;
        }

        this._populate(accountId, addressbookData);
        this.emit('dataLoaded');
    }

    _update(accountId, addressbookData) {
        const {action, type} = addressbookData;
        const store =
            type === 'contact' ? this._contactsByAccount :
            type === 'policy'  ? this._policiesByAccount :
            this._groupsByAccount;

        const flat =
            type === 'contact' ? this._contacts :
            type === 'policy'  ? this._policies :
            this._groups;

        const bucket = store.get(accountId);
        if (!bucket) return; // no snapshot yet → ignore safely

        const item = addressbookData[type];

        if (!item) return;

        if (action === 'delete') {
            bucket.delete(item.id);
            if (![...store.values()].some(b => b.has(item.id))) {
                flat.delete(item.id);
            }
            this.emit('dataDeleted', { type, data: item });
        } else {
            const item = addressbookData[type];
            bucket.set(item.id, item);
            flat.set(item.id, item);
            this.emit('dataUpdated');
        }
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
