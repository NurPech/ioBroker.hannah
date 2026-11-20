import * as https from 'node:https';
import * as http from 'node:http';
import AdmZip from 'adm-zip';

interface ManifestPart {
    path: string;
    offset: number;
}

interface ManifestBuild {
    chipFamily: string;
    parts: ManifestPart[];
}

interface Manifest {
    name: string;
    version: string;
    builds: ManifestBuild[];
}

/** A single binary file to be flashed, as returned by the firmware manager. */
export interface FirmwareFile {
    /** Filename from the manifest */
    name: string;
    /** Flash offset in bytes */
    offset: number;
    /** File contents as base64 string */
    data: string;
}

/** Result returned by FirmwareManager.getFirmwareFiles(). */
export interface FirmwareResult {
    /** Firmware version string from manifest */
    version: string;
    /** List of binary files to flash */
    files: FirmwareFile[];
}

/** What a download returned. */
interface Download {
    /** the body */
    data: Buffer;
    /** HTTP status of the answer that delivered the body (after redirects) */
    status: number;
    /** Content-Type header of that answer, empty if there was none */
    contentType: string;
}

function fetchBuffer(url: string, token?: string): Promise<Download> {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        };
        const req = mod.request(options, res => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchBuffer(res.headers.location, token).then(resolve).catch(reject);
                return;
            }
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () =>
                resolve({
                    data: Buffer.concat(chunks),
                    status: res.statusCode ?? 0,
                    contentType: String(res.headers['content-type'] ?? ''),
                }),
            );
            res.on('error', reject);
        });
        req.setTimeout(30_000, () => {
            req.destroy(new Error(`Timeout fetching ${url}`));
        });
        req.on('error', reject);
        req.end();
    });
}

/** How much of a text answer the error message shows. */
const SNIPPET_LENGTH = 200;

/**
 * Says what a download that is no ZIP archive is, so the admin does not have to guess: what the
 * server answered, the start of it if it is text, and what that usually means.
 *
 * @param download - What came back
 */
export function describeNotZip(download: Download): string {
    const { data, status, contentType } = download;
    const kind = contentType.split(';')[0].trim().toLowerCase();
    const head = `Downloaded file is not a valid ZIP archive (HTTP ${status}, ${kind || 'no content type'}, ${data.length} bytes)`;
    if (data.length === 0) {
        return `${head}: the answer is empty`;
    }
    // text if the start has no control characters other than line breaks and tabs
    const start = data.subarray(0, SNIPPET_LENGTH).toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f]/.test(start)) {
        return head;
    }
    const snippet = start.replace(/\s+/g, ' ').trim();
    const trimmed = data.length > SNIPPET_LENGTH ? `${snippet} ...` : snippet;
    const text = data.toString('utf8', 0, 1024).trimStart();
    let hint = '';
    if (kind.includes('json') || text.startsWith('{') || text.startsWith('[')) {
        hint =
            ' The URL points at information about the firmware, not at the file. The update server needs' +
            ' .../releases/latest?channel=<channel>.';
    } else if (kind.includes('html') || /^<(!doctype|html)/i.test(text)) {
        hint =
            ' A web page came back: the web interface of the update server, or a page of a proxy or' +
            ' firewall in between. Check the URL and the access to the server.';
    }
    return `${head}, it starts with: ${trimmed}.${hint}`;
}

/** Downloads firmware ZIPs from an update server and unpacks them for flashing. */
export class FirmwareManager {
    /** Firmware source URL (update server releases endpoint) */
    private url: string;
    /** Optional bearer token for authenticated update servers */
    private token: string | undefined;

    /**
     * @param url - Firmware source URL
     * @param token - Token
     */
    constructor(url: string, token?: string) {
        this.url = url;
        // Trim the token: a trailing newline/whitespace (e.g. from copy-paste into
        // the config) produces an invalid HTTP header value and Node's http.request
        // throws "Invalid character in header content".
        this.token = token?.trim() || undefined;
    }

    /** Download, unpack and return all firmware files ready for flashing. */
    async getFirmwareFiles(): Promise<FirmwareResult> {
        const download = await fetchBuffer(this.url, this.token);

        let zip: AdmZip;
        try {
            zip = new AdmZip(download.data);
        } catch {
            throw new Error(describeNotZip(download));
        }

        const manifestEntry = zip.getEntry('manifest.json');
        if (!manifestEntry) {
            throw new Error('manifest.json not found in firmware ZIP');
        }

        let manifest: Manifest;
        try {
            manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
        } catch {
            throw new Error('manifest.json is not valid JSON');
        }

        const build = manifest.builds?.find(b => b.chipFamily === 'ESP32-S3') ?? manifest.builds?.[0];
        if (!build) {
            throw new Error('No builds found in manifest.json');
        }

        const files: FirmwareFile[] = [];
        for (const part of build.parts) {
            const entry = zip.getEntry(part.path);
            if (!entry) {
                throw new Error(`Binary not found in ZIP: ${part.path}`);
            }
            files.push({
                name: part.path,
                offset: part.offset,
                data: entry.getData().toString('base64'),
            });
        }

        return { version: manifest.version, files };
    }
}
