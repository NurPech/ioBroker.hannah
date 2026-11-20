import { expect } from 'chai';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';
import { describeNotZip, FirmwareManager } from './firmware-manager';

const download = (body: string | Buffer, contentType = '', status = 200): Parameters<typeof describeNotZip>[0] => ({
    data: Buffer.from(body),
    status,
    contentType,
});

describe('firmware-manager', () => {
    describe('describeNotZip', () => {
        it('names status, type and size', () => {
            const msg = describeNotZip(download('hello', 'text/plain; charset=utf-8'));

            expect(msg).to.contain('not a valid ZIP archive (HTTP 200, text/plain, 5 bytes)');
            expect(msg).to.contain('it starts with: hello.');
        });

        it('says that the URL points at information when the answer is JSON', () => {
            const msg = describeNotZip(download('{"version":"0.105.0","url":"https://x/y"}', 'application/json'));

            expect(msg).to.contain('application/json');
            expect(msg).to.contain('{"version":"0.105.0"');
            expect(msg).to.contain('.../releases/latest?channel=<channel>');
        });

        it('says that a web page came back when the answer is HTML', () => {
            const msg = describeNotZip(download('<!DOCTYPE html>\n<html><title>Blocked</title></html>', 'text/html'));

            expect(msg).to.contain('<!DOCTYPE html> <html><title>Blocked</title></html>');
            expect(msg).to.contain('A web page came back');
        });

        it('knows JSON and HTML without a content type', () => {
            expect(describeNotZip(download('  [1,2]'))).to.contain('no content type');
            expect(describeNotZip(download('  [1,2]'))).to.contain('information about the firmware');
            expect(describeNotZip(download('<html></html>'))).to.contain('A web page came back');
        });

        it('cuts a long text', () => {
            const msg = describeNotZip(download('a'.repeat(5000), 'text/plain'));

            expect(msg).to.contain(`${'a'.repeat(200)} ...`);
            expect(msg).to.not.contain('a'.repeat(201));
        });

        it('shows no start of a binary answer', () => {
            const msg = describeNotZip(
                download(Buffer.from([0x50, 0x00, 0x01, 0xff, 0x02]), 'application/octet-stream'),
            );

            expect(msg).to.equal(
                'Downloaded file is not a valid ZIP archive (HTTP 200, application/octet-stream, 5 bytes)',
            );
        });

        it('says that an empty answer is empty', () => {
            expect(describeNotZip(download(''))).to.contain('the answer is empty');
        });
    });

    describe('getFirmwareFiles', () => {
        let server: http.Server;
        let base: string;
        let zipBody: Buffer;
        let tokenSeen: string | undefined;

        before(async () => {
            const zip = new AdmZip();
            zip.addFile(
                'manifest.json',
                Buffer.from(
                    JSON.stringify({
                        name: 'x',
                        version: '1.2.3',
                        builds: [{ chipFamily: 'ESP32-S3', parts: [{ path: 'a.bin', offset: 0 }] }],
                    }),
                ),
            );
            zip.addFile('a.bin', Buffer.from([1, 2, 3]));
            zipBody = zip.toBuffer();
            server = http.createServer((req, res) => {
                tokenSeen = req.headers.authorization;
                if (req.url === '/zip') {
                    res.writeHead(200, { 'Content-Type': 'application/zip' });
                    res.end(zipBody);
                } else if (req.url === '/json') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end('{"version":"1.2.3"}');
                } else {
                    res.writeHead(429, { 'Retry-After': '60' });
                    res.end();
                }
            });
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        });

        after(() => {
            server.close();
        });

        it('unpacks a ZIP', async () => {
            const result = await new FirmwareManager(`${base}/zip`, ' secret\n').getFirmwareFiles();

            expect(result.version).to.equal('1.2.3');
            expect(result.files).to.deep.equal([{ name: 'a.bin', offset: 0, data: 'AQID' }]);
            expect(tokenSeen).to.equal('Bearer secret');
        });

        it('says what came back when it is no ZIP, and never the token', async () => {
            let message = '';
            try {
                await new FirmwareManager(`${base}/json`, 'secret').getFirmwareFiles();
            } catch (err) {
                message = (err as Error).message;
            }

            expect(message).to.contain('HTTP 200, application/json');
            expect(message).to.contain('{"version":"1.2.3"}');
            expect(message).to.not.contain('secret');
        });

        it('keeps reporting the status of a refused request', async () => {
            let message = '';
            try {
                await new FirmwareManager(`${base}/limited`).getFirmwareFiles();
            } catch (err) {
                message = (err as Error).message;
            }

            expect(message).to.equal(`HTTP 429 for ${base}/limited`);
        });
    });
});
