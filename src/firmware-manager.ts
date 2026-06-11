import * as https from 'https';
import * as http from 'http';
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

export interface FirmwareFile {
    name: string;
    offset: number;
    data: string; // base64
}

export interface FirmwareResult {
    version: string;
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
        req.on('error', reject);
        req.end();
    });
}

export class FirmwareManager {
    private url: string;
    private token: string | undefined;

    constructor(url: string, token?: string) {
        this.url = url;
        this.token = token || undefined;
    }

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
