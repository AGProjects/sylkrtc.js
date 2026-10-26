'use strict';

class Avatars {
    constructor() {
        this._source = null;
    }

    // fn returns [{id, etag}] of the pictures the app has cached.
    setSource(fn) {
        this._source = typeof fn === 'function' ? fn : null;
    }

    // For the fetch request: null when no source is set (no avatars requested).
    etags() {
        if (!this._source) return null;
        try {
            const list = this._source();
            return Array.isArray(list) ? list.filter((a) => a && a.id && a.etag) : [];
        } catch (e) {
            return [];
        }
    }

    // A contact as cached: metadata only, never picture data or a remove
    // instruction. Without an avatar, keep `previous`'s. Picture data is pushed
    // onto `pictures`, when given, for the caller to emit once.
    cache(contact, previous = null, pictures = null) {
        let avatar = null;
        if (contact.avatar) {
            const {data, remove, ...meta} = contact.avatar;
            if (pictures && (data || meta.code)) {
                pictures.push({id: contact.id, avatar: meta, data: data || null});
            }
            avatar = (meta.etag || meta.code) ? meta : null;
        }
        if (!avatar && previous && previous.avatar && previous.avatar.etag) {
            avatar = previous.avatar;
        }
        if (!avatar && !contact.avatar) return contact;
        return {...contact, avatar};
    }

    redact(data) {
        if (!data || !data.avatar || !data.avatar.data) return data;
        return {...data, avatar: {...data.avatar, data: undefined}};
    }
}

export { Avatars };
