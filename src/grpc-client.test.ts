import { EventEmitter } from 'node:events';
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

    // A sync after the connect that throws or hangs must not leave the adapter connected but without
    // the device snapshot in Core (Redis restarting while the adapter reconnects)
    describe('sync after connect', () => {
        const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

        type Opened = {
            client: GrpcClient;
            internals: {
                running: boolean;
                reconnectTimer: number | null;
                _openStream(resolved: unknown, host: string, port: number): void;
            };
            stream: EventEmitter & { write: sinon.SinonStub; end: sinon.SinonStub };
            timers: Array<{ fn: () => void; ms: number }>;
            log: { info: sinon.SinonStub; warn: sinon.SinonStub; error: sinon.SinonStub; debug: sinon.SinonStub };
        };

        function open(
            onConnected: () => void | Promise<void>,
            onDisconnected: () => void | Promise<void> = sinon.stub(),
        ): Opened {
            const timers: Array<{ fn: () => void; ms: number }> = [];
            const log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub(), debug: sinon.stub() };
            const client = new GrpcClient({
                onCommand: sinon.stub(),
                onConnected,
                onDisconnected,
                log,
                setTimeout: (fn, ms) => timers.push({ fn, ms }),
                clearTimeout: sinon.stub(),
            });
            const stream = Object.assign(new EventEmitter(), { write: sinon.stub(), end: sinon.stub() });
            const internals = client as unknown as Opened['internals'];
            internals.running = true;
            internals._openStream({ client: { agentConnect: () => stream } }, 'core', 50051);
            return { client, internals, stream, timers, log };
        }

        it('closes the stream and reconnects when the sync throws', async () => {
            const onDisconnected = sinon.stub();
            const { client, stream, timers, log } = open(() => Promise.reject(new Error('boom')), onDisconnected);
            await flush();

            expect(stream.end.calledOnce).to.equal(true);
            expect(client.generation).to.equal(null);
            expect(onDisconnected.calledOnce).to.equal(true);
            expect(timers.some(t => t.ms === 10_000)).to.equal(true);
            expect(log.error.firstCall.args[0]).to.match(/onConnected error: boom/);
        });

        it('closes the stream and reconnects when the sync does not settle in time', async () => {
            const onDisconnected = sinon.stub();
            const { client, stream, timers } = open(() => new Promise<void>(() => {}), onDisconnected);
            await flush();
            expect(client.generation).to.equal('v2');

            timers.find(t => t.ms === 120_000)!.fn();

            expect(stream.end.calledOnce).to.equal(true);
            expect(client.generation).to.equal(null);
            expect(onDisconnected.calledOnce).to.equal(true);
            expect(timers.some(t => t.ms === 10_000)).to.equal(true);
        });

        it('leaves the connection alone when the sync goes through, even if its timer fires later', async () => {
            const onDisconnected = sinon.stub();
            const { client, stream, timers } = open(() => Promise.resolve(), onDisconnected);
            await flush();

            timers.find(t => t.ms === 120_000)!.fn();

            expect(stream.end.called).to.equal(false);
            expect(client.generation).to.equal('v2');
            expect(onDisconnected.called).to.equal(false);
        });

        it('retries a sync that throws synchronously', async () => {
            const { client, timers } = open(() => {
                throw new Error('sync boom');
            });
            await flush();

            expect(client.generation).to.equal(null);
            expect(timers.some(t => t.ms === 10_000)).to.equal(true);
        });

        it('does not let a failing onDisconnected escape', async () => {
            const { timers, log } = open(
                () => Promise.reject(new Error('boom')),
                () => Promise.reject(new Error('db down')),
            );
            await flush();

            expect(log.warn.firstCall.args[0]).to.match(/onDisconnected error: db down/);
            expect(timers.some(t => t.ms === 10_000)).to.equal(true);
        });

        it('ignores the end of a stream that was closed already, instead of scheduling another reconnect', async () => {
            const onDisconnected = sinon.stub();
            const { internals, stream, timers } = open(() => Promise.reject(new Error('boom')), onDisconnected);
            await flush();
            const scheduled = timers.length;
            // the reconnect timer fired and cleared itself meanwhile
            internals.reconnectTimer = null;

            stream.emit('end');

            expect(onDisconnected.calledOnce).to.equal(true);
            expect(timers.length).to.equal(scheduled);
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
