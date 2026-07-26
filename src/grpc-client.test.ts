import { expect } from 'chai';
import * as sinon from 'sinon';
import { GrpcClient } from './grpc-client';

describe('GrpcClient', () => {
    function makeClient(): GrpcClient {
        return new GrpcClient({
            onCommand: sinon.stub(),
            onConnected: sinon.stub(),
            onDisconnected: sinon.stub(),
            log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() },
            setTimeout: sinon.stub().returns(0),
            clearTimeout: sinon.stub(),
        });
    }

    /**
     * Regression test: conflating "GetSatellites failed/unreachable" with "Core reports zero
     * satellites" caused every satellite object to be deleted as stale whenever Core was merely
     * unreachable (2026-07-26 incident: hannah-core down, adapter's onConnected sync ran anyway,
     * getSatellites() resolved [], removeUnknownSatellites() deleted all three satellites).
     */
    it('resolves null (not an empty array) when there is no connection', async () => {
        const client = makeClient();
        const result = await client.getSatellites();
        expect(result).to.equal(null);
    });

    it('resolves null (not an empty array) when the RPC itself errors', async () => {
        const client = makeClient();
        const fakeGrpcClient = {
            getSatellites: (_req: unknown, cb: (err: Error | null, response?: { satellites: unknown[] }) => void) =>
                cb(new Error('14 UNAVAILABLE: No connection established')),
        };
        (client as unknown as { client: unknown }).client = fakeGrpcClient;

        const result = await client.getSatellites();
        expect(result).to.equal(null);
    });

    it('resolves the reported satellites when the RPC succeeds, including a genuinely empty list', async () => {
        const client = makeClient();
        const fakeGrpcClient = {
            getSatellites: (_req: unknown, cb: (err: Error | null, response?: { satellites: unknown[] }) => void) =>
                cb(null, { satellites: [] }),
        };
        (client as unknown as { client: unknown }).client = fakeGrpcClient;

        const result = await client.getSatellites();
        expect(result).to.deep.equal([]);
    });
});
