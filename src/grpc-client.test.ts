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

    // #203/hannah-proto#16: ack_id round trip for the unknown-fields report
    describe('sendWithAck', () => {
        type Internals = {
            stream: { write: sinon.SinonStub } | null;
            versioned: { legacy: boolean; close: () => void } | null;
            _handleAck(ack: { ackId: bigint; unknownFields: unknown[] }): void;
            _closeConnection(): void;
        };

        function connectedClient(legacy = false): {
            client: GrpcClient;
            internals: Internals;
            write: sinon.SinonStub;
            timers: Array<() => void>;
        } {
            const timers: Array<() => void> = [];
            const client = new GrpcClient({
                onCommand: sinon.stub(),
                onConnected: sinon.stub(),
                onDisconnected: sinon.stub(),
                log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() },
                setTimeout: fn => timers.push(fn),
                clearTimeout: sinon.stub(),
            });
            const write = sinon.stub();
            const internals = client as unknown as Internals;
            internals.stream = { write };
            internals.versioned = { legacy, close: sinon.stub() };
            return { client, internals, write, timers };
        }

        it('sets increasing ack_ids and resolves with the matching AgentAck', async () => {
            const { client, internals, write } = connectedClient();

            const first = client.sendWithAck({ sendSnapshot: { devices: [] } });
            const second = client.sendWithAck({ sendSnapshot: { devices: [] } });
            expect(write.firstCall.args[0].ackId).to.equal(1n);
            expect(write.secondCall.args[0].ackId).to.equal(2n);

            const ack = { ackId: 2n, unknownFields: [] };
            internals._handleAck(ack);
            expect(await second).to.deep.equal({ kind: 'ack', ack });

            internals._handleAck({ ackId: 1n, unknownFields: [] });
            expect((await first).kind).to.equal('ack');
        });

        it('resolves timeout when Core never acks (too old for AgentAck)', async () => {
            const { client, timers } = connectedClient();

            const result = client.sendWithAck({ sendSnapshot: { devices: [] } });
            timers[0]();

            expect(await result).to.deep.equal({ kind: 'timeout' });
        });

        it('resolves legacy without setting ack_id on the unversioned API', async () => {
            const { client, write } = connectedClient(true);

            expect(await client.sendWithAck({ sendSnapshot: { devices: [] } })).to.deep.equal({ kind: 'legacy' });
            expect(write.firstCall.args[0].ackId).to.equal(undefined);
        });

        it('resolves pending acks as disconnected when the connection closes', async () => {
            const { client, internals } = connectedClient();

            const result = client.sendWithAck({ sendSnapshot: { devices: [] } });
            internals._closeConnection();

            expect(await result).to.deep.equal({ kind: 'disconnected' });
        });

        it('resolves disconnected without a stream', async () => {
            expect(await makeClient().sendWithAck({ sendSnapshot: { devices: [] } })).to.deep.equal({
                kind: 'disconnected',
            });
        });
    });
});
