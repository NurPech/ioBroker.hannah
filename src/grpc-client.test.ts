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
            stream: { write: sinon.SinonStub; end?: () => void } | null;
            streamGeneration: 'v1' | 'v2';
            versioned: { close: () => void } | null;
            _handleAck(ack: { ackId: bigint; unknownFields: unknown[] }): void;
            _closeConnection(): void;
        };

        function connectedClient(generation: 'v1' | 'v2' = 'v2'): {
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
            internals.streamGeneration = generation;
            internals.versioned = { close: sinon.stub() };
            return { client, internals, write, timers };
        }

        const typedSnapshot = { typedSnapshot: { devices: [] } };

        it('sets increasing ack_ids and resolves with the matching AgentAck', async () => {
            const { client, internals, write } = connectedClient();

            const first = client.sendWithAck(typedSnapshot);
            const second = client.sendWithAck(typedSnapshot);
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

            const result = client.sendWithAck(typedSnapshot);
            timers[0]();

            expect(await result).to.deep.equal({ kind: 'timeout' });
        });

        it('resolves pending acks as disconnected when the connection closes', async () => {
            const { client, internals } = connectedClient();

            const result = client.sendWithAck(typedSnapshot);
            internals._closeConnection();

            expect(await result).to.deep.equal({ kind: 'disconnected' });
        });

        it('resolves disconnected without a stream', async () => {
            expect(await makeClient().sendWithAck(typedSnapshot)).to.deep.equal({ kind: 'disconnected' });
        });
    });

    describe('generations', () => {
        function streamOn(generation: 'v1' | 'v2'): { client: GrpcClient; write: sinon.SinonStub } {
            const client = makeClient();
            const write = sinon.stub();
            (client as unknown as { stream: unknown }).stream = { write };
            (client as unknown as { streamGeneration: string }).streamGeneration = generation;
            return { client, write };
        }

        it('knows the generation of the open stream, none without one', () => {
            expect(makeClient().generation).to.equal(null);
            expect(streamOn('v1').client.generation).to.equal('v1');
            expect(streamOn('v2').client.generation).to.equal('v2');
        });

        it('sends hannah.v2 messages on a hannah.v2 stream as they are', () => {
            const { client, write } = streamOn('v2');
            const msg = { textCommand: { text: 'Licht an' } };

            client.send(msg);

            expect(write.firstCall.args[0]).to.equal(msg);
        });

        it('bridges a message to hannah.v1 on a hannah.v1 stream', () => {
            const { client, write } = streamOn('v1');

            client.send({ textCommand: { text: 'Licht an' } });

            expect(write.firstCall.args[0].textCommand?.text).to.equal('Licht an');
            expect(write.firstCall.args[0]).to.not.have.property('typedSnapshot');
        });

        it('sends nothing for typed device messages on a hannah.v1 stream', () => {
            const { client, write } = streamOn('v1');

            client.send({ typedSnapshot: { devices: [] } });
            client.send({ slotUpdate: { deviceId: 'a', slotId: 'on', value: { boolean: true }, ack: true, ts: 1n } });

            expect(write.called).to.equal(false);
        });

        it('sends a legacy message as it is on a hannah.v1 stream, and drops it on a hannah.v2 stream', () => {
            const onV1 = streamOn('v1');
            const onV2 = streamOn('v2');
            const msg = { sendSnapshot: { devices: [] } };

            onV1.client.sendLegacy(msg);
            onV2.client.sendLegacy(msg);

            expect(onV1.write.firstCall.args[0]).to.equal(msg);
            expect(onV2.write.called).to.equal(false);
        });

        it('sets the ack_id of a legacy message and resolves with the ack', async () => {
            const { client, write } = streamOn('v1');

            const result = client.sendLegacyWithAck({ sendSnapshot: { devices: [] } });
            expect(write.firstCall.args[0].ackId).to.equal(1n);

            const ack = { ackId: 1n, unknownFields: [] };
            (client as unknown as { _handleAck(a: unknown): void })._handleAck(ack);
            expect(await result).to.deep.equal({ kind: 'ack', ack });
        });
    });
});
