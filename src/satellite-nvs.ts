import * as http from 'node:http';

/**
 * Push a key-value map to a satellite's `POST /nvs` endpoint (Refs #36).
 * The satellite writes the whitelisted keys into NVS and restarts.
 *
 * @param ip - Satellite IP address (no port/scheme)
 * @param token - Bearer token, must match the satellite's configured `nvs_token`
 * @param values - Key-value pairs to write (e.g. wifi_ssid, mqtt_broker, ww_threshold)
 */
export function updateSatelliteNvs(ip: string, token: string, values: Record<string, string | number>): Promise<void> {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(values), 'utf8');
        const options: http.RequestOptions = {
            hostname: ip,
            port: 80,
            path: '/nvs',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': body.length,
            },
        };
        const req = http.request(options, res => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                    const text = Buffer.concat(chunks).toString('utf8');
                    reject(new Error(`HTTP ${res.statusCode} from ${ip}/nvs: ${text}`));
                    return;
                }
                resolve();
            });
            res.on('error', reject);
        });
        req.setTimeout(10_000, () => {
            req.destroy(new Error(`Timeout waiting for ${ip}/nvs`));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
