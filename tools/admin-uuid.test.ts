import { expect } from 'chai';
import { webcrypto } from 'node:crypto';
import { newUuid, type UuidCrypto } from '../admin/src/uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('admin uuid', () => {
    it('uses crypto.randomUUID where there is one (secure context)', () => {
        expect(newUuid({ randomUUID: () => 'from-the-browser', getRandomValues: a => a })).to.equal('from-the-browser');
    });

    it('makes a UUID v4 without crypto.randomUUID (plain HTTP)', () => {
        const insecure: UuidCrypto = { getRandomValues: a => webcrypto.getRandomValues(a) };

        for (let i = 0; i < 50; i++) {
            expect(newUuid(insecure)).to.match(V4);
        }
    });

    it('sets the version and variant bits whatever the random bytes are', () => {
        const zeros: UuidCrypto = { getRandomValues: a => a };
        const ones: UuidCrypto = {
            getRandomValues: a => a.fill(0xff),
        };

        expect(newUuid(zeros)).to.equal('00000000-0000-4000-8000-000000000000');
        expect(newUuid(ones)).to.equal('ffffffff-ffff-4fff-bfff-ffffffffffff');
    });

    it('does not repeat', () => {
        const insecure: UuidCrypto = { getRandomValues: a => webcrypto.getRandomValues(a) };

        expect(new Set(Array.from({ length: 200 }, () => newUuid(insecure))).size).to.equal(200);
    });
});
