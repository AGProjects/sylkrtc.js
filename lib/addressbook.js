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
        return _serialize([...this._contacts.values()]);
    }

    get policies() {
        return _serialize([...this._policies.values()]);
    }

    get groups() {
        return _serialize([...this._groups.values()]);
    }

    getContact(contactId) {
        const contact = this._contacts.get(contactId);
        return contact ? _serialize(contact) : null;
    }

    addContact(contact) {
        if (!contact) {
            return;
        }
        this._contacts.set(contact.id, contact);
        this._applyToAllAccounts('add', 'contact', contact);
    }

    updateContact(contact) {
        if (!contact) {
            return;
        }
        this._contacts.set(contact.id, contact);
        this._applyToAllAccounts('update', 'contact', contact);
    }

    deleteContact(contactId) {
        const contact = this._contacts.get(contactId);
        if (contact) {
            this._contacts.delete(contactId);
        }
        this._applyToAllAccounts('delete', 'contact', contactId);
    }

    getPolicy(policyId) {
        const policy = this._policies.get(policyId);
        return policy ? _serialize(policy) : null;
    }

    addPolicy(policy) {
        if (!policy) {
            return;
        }
        this._policies.set(policy.id, policy);
        this._applyToAllAccounts('add', 'policy', policy);
    }

    updatePolicy(policy){
        if (!policy) {
            return;
        }
        this._policies.set(policy.id, policy);
        this._applyToAllAccounts('update', 'policy', policy);
    }

    deletePolicy(policyId) {
        const policy = this._policies.get(policyId);
        if (policy) {
            this._policies.delete(policyId);
        }
        this._applyToAllAccounts('delete', 'policy', policyId);
    }

    getGroup(groupId) {
        const group = this._groups.get(groupId);
        return group ? _serialize(group) : null;
    }

    addGroup(group) {
        if (!group) {
            return;
        }
        this._groups.set(group.id, group);
        this._applyToAllAccounts('add', 'group', group);
    }

    updateGroup(group) {
        if (!group) {
            return;
        }
        this._groups.set(group.id, group);
        this._applyToAllAccounts('update', 'group', group);
    }

    deleteGroup(groupId) {
        const group = this._groups.get(groupId);
        if (group) {
            this._groups.delete(groupId);
        }
        this._applyToAllAccounts('delete', 'group', groupId);
    }

    addGroupMember(groupId, contactId) {
        const group = this._groups.get(groupId);
        const contact = this._contacts.get(contactId);
        if (group && contact) {
            this._group.contacts.push(contact);
            this._applyToAllAccounts('add', 'groupMember', {groupId, contactId});
        }
    }

    deleteGroupMember(groupId, contactId) {
        const group = this._groups.get(groupId);
        if (group) {
            const index = group.contacts.findIndex(c => c.id === contactId);
            if (index > -1) {
                group.contacts.splice(index, 1);
                this._applyToAllAccounts('delete', 'groupMember', {groupId, contactId});
            }
        }
    }

    load(addressbookData) {
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

    // Private API

    _serialize(data) {
        return JSON.parse(JSON.stringify(data))
    }

    _load(addressbookData) {
        const data = {};
        this.load(addressbookData)
        this.emit('addressbookDataLoaded', data);
    }

    _update(addressbookData) {
        // Maybe this is not needed if the addressbook is already modified when the operation starts
        switch (addressbookData.type) {
            case 'contact':
                break;
            case 'policy':
                break;
            case 'group':
                break;
            default:
                break
        }

        this.emit('addressbookDataUpdated', data);
    }

    _applyToAllAccounts(action, type, data) {
        if (this._connection) {
            for (const account of this._connection._accounts) {
                account._updateAddressbook(action, type, data, (error) => {
                    this.emit('addressbookDataUpdateFailed', error, action, type, data, account);
                });
            }
        } else {
            this.emit('addressbookDataUpdateFailed', "No connection", action, type, data);
        }
    }
}

export { Addressbook };
