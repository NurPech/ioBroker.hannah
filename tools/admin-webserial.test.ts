import { expect } from 'chai';
import { missingWebSerialMessage, WEBSERIAL_INSECURE, WEBSERIAL_UNSUPPORTED } from '../admin/src/webserial';

describe('admin webserial', () => {
    it('names the secure connection when the page is not in a secure context (plain HTTP)', () => {
        expect(missingWebSerialMessage(false)).to.equal(WEBSERIAL_INSECURE);
        expect(WEBSERIAL_INSECURE)
            .to.contain('HTTPS')
            .and.to.contain('localhost')
            .and.to.contain('Download image')
            .and.to.contain('espressif.github.io/esptool-js');
    });

    it('names the browser when the page is secure and there is still no WebSerial', () => {
        expect(missingWebSerialMessage(true)).to.equal(WEBSERIAL_UNSUPPORTED);
    });

    it('keeps the old text where the browser cannot tell', () => {
        expect(missingWebSerialMessage(undefined)).to.equal(WEBSERIAL_UNSUPPORTED);
    });
});
