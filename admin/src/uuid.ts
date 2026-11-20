/** The part of the Web Crypto API a UUID needs. `randomUUID` is only there in a secure context. */
export interface UuidCrypto {
    /** a random UUID v4, only in a secure context (HTTPS or localhost) */
    randomUUID?: () => string;
    /** fills the array with random values, in every context */
    getRandomValues: (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
}

/**
 * A random UUID v4. `crypto.randomUUID()` does not exist when the ioBroker admin is opened over
 * plain HTTP, so it falls back to `getRandomValues()`, which every context has.
 *
 * @param cryptoApi - The Web Crypto API, the one of the browser if not given
 */
export function newUuid(cryptoApi: UuidCrypto = globalThis.crypto): string {
    if (typeof cryptoApi.randomUUID === 'function') {
        return cryptoApi.randomUUID();
    }
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    // version 4 and the variant of RFC 4122
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
