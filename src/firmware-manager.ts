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

function fetchBuffer(url: string, token?: string): Promise<Buffer> {
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
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        });
        req.setTimeout(30_000, () => {
            req.destroy(new Error(`Timeout fetching ${url}`));
        });
        req.on('error', reject);
        req.end();
    });
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
        const raw = await fetchBuffer(this.url, this.token);

        let zip: AdmZip;
        try {
            zip = new AdmZip(raw);
        } catch {
            throw new Error('Downloaded file is not a valid ZIP archive');
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
