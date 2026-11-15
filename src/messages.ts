import { randomUUID } from 'node:crypto';
import type * as utils from '@iobroker/adapter-core';
import type { AgentMessageSender } from './grpc-client';

interface NotificationMessage {
    category?: {
        severity?: string;
        description?: string | { de?: string; en?: string };
        name?: string | { de?: string; en?: string };
        instances?: Record<string, { messages?: Array<{ message?: string }> }>;
    };
    instances?: Record<string, { messages?: Array<{ message?: string }> }>;
}

/** How long the same ioBroker notification is announced only once (`severity: alert` excepted). */
const ANNOUNCE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface DirectPayload {
    text?: string;
}

interface AnnouncePayload {
    rooms?: string | string[];
    room?: string;
    text?: string;
    /**
     * roomie_id (e.g. "leonie") — routes via the Announce RPC's room_id/user_id (#31) instead of the
     * room-only satellite_control stream path. Combined with room/rooms: AND semantics (only the
     * satellite that's both in that room AND owned by that Person), one Announce call per room.
     */
    person?: string;
}

interface AskPayload {
    room?: string;
    text?: string;
}

/** Function that sends a notification to Hannah Core via unary gRPC and returns the acknowledgement. */
export type NotifyFn = (
    /** Notification text */
    text: string,
    /** Skip LLM reformulation if true */
    direct: boolean,
    /** Tone hint: "alert" | "notify" | "info" */
    severity: string,
) => Promise<{ ok: boolean; message?: string }>;

/** Function that sends a TTS announcement targeted by device, room, and/or Person via the Announce RPC (#31). */
export type AnnounceFn = (
    text: string,
    opts: { device?: string; roomId?: string; userId?: number },
) => Promise<{ ok: boolean; message?: string }>;

/** Resolves a roomie_id to Hannah's numeric User.id, or null if not found. */
export type ResolveRoomieUserIdFn = (roomieId: string) => Promise<number | null>;

/** Handles sendDirect, sendNotification, and announce adapter messages. */
export class MessagesHandler {
    private adapter: utils.AdapterInstance;
    private notify: NotifyFn;
    private announceRpc: AnnounceFn;
    private resolveRoomieUserId: ResolveRoomieUserIdFn;
    private send: AgentMessageSender;
    private readonly _pending = new Map<string, { from: string; command: string; cb: ioBroker.MessageCallbackInfo }>();
    /** notification key → when it was announced; in memory only, so a restart announces everything once more */
    private readonly _announced = new Map<string, number>();
    private readonly now: () => number;

    /**
     * @param adapter - ioBroker adapter instance
     * @param notify - Unary gRPC call to Hannah Core (for notifications)
     * @param send - Stream send for satellite control messages
     * @param announceRpc - Unary Announce RPC call, used for person-targeted announcements (#31)
     * @param resolveRoomieUserId - Resolves a roomie_id to Hannah's numeric User.id (#31)
     * @param now - Clock in milliseconds, replaced in tests
     */
    constructor(
        adapter: utils.AdapterInstance,
        notify: NotifyFn,
        send: AgentMessageSender,
        announceRpc: AnnounceFn,
        resolveRoomieUserId: ResolveRoomieUserIdFn,
        now: () => number = Date.now,
    ) {
        this.now = now;
        this.adapter = adapter;
        this.notify = notify;
        this.send = send;
        this.announceRpc = announceRpc;
        this.resolveRoomieUserId = resolveRoomieUserId;
    }

    /**
     * Handle an incoming ioBroker message (sendDirect / sendNotification).
     *
     * @param obj - The ioBroker message object
     */
    public onMessage(obj: ioBroker.Message): void {
        if (!obj) {
            return;
        }

        if (obj.command === 'sendDirect') {
            const { text } = (obj.message ?? {}) as DirectPayload;
            if (!text) {
                if (obj.callback) {
                    this.adapter.sendTo(obj.from, obj.command, { sent: false, error: 'no payload' }, obj.callback);
                }
                return;
            }
            void this.notify(text, true, 'notify')
                .then(resp => {
                    if (obj.callback) {
                        this.adapter.sendTo(obj.from, obj.command, { sent: resp.ok }, obj.callback);
                    }
                })
                .catch((err: Error) => {
                    this.adapter.log.warn(`[messages] sendDirect failed: ${err.message}`);
                    if (obj.callback) {
                        this.adapter.sendTo(obj.from, obj.command, { sent: false, error: err.message }, obj.callback);
                    }
                });
        } else if (obj.command === 'sendNotification') {
            this.adapter.log.debug(`sendNotification: ${JSON.stringify(obj.message)}`);
            const notification = obj.message as NotificationMessage | undefined;
            const text = this.extractText(notification);

            if (!text) {
                this.adapter.log.warn('Received notification without content — ignored.');
                if (obj.callback) {
                    this.adapter.sendTo(obj.from, obj.command, { sent: false, error: 'no payload' }, obj.callback);
                }
                return;
            }

            const severity = notification?.category?.severity ?? 'notify';
            const key = this.dedupeKey(notification, text);
            // Alerts are never held back: a repeated alert can be wanted, a swallowed one is worse than a doubled one.
            if (severity !== 'alert' && this.isRepeat(key)) {
                this.adapter.log.debug(
                    `[messages] sendNotification already announced within 24 h, not repeated: ${text}`,
                );
                if (obj.callback) {
                    // from the sender's view it is delivered, so it has no reason to retry
                    this.adapter.sendTo(obj.from, obj.command, { sent: true }, obj.callback);
                }
                return;
            }
            this._announced.set(key, this.now());
            void this.notify(text, false, severity)
                .then(resp => {
                    if (!resp.ok) {
                        this._announced.delete(key);
                    }
                    if (obj.callback) {
                        this.adapter.sendTo(obj.from, obj.command, { sent: resp.ok }, obj.callback);
                    }
                })
                .catch((err: Error) => {
                    // not announced, so the next one may try again
                    this._announced.delete(key);
                    this.adapter.log.warn(`[messages] sendNotification failed: ${err.message}`);
                    if (obj.callback) {
                        this.adapter.sendTo(obj.from, obj.command, { sent: false, error: err.message }, obj.callback);
                    }
                });
        } else if (obj.command === 'announce') {
            const { rooms, room, text, person } = (obj.message ?? {}) as AnnouncePayload;
            if (!text) {
                if (obj.callback) {
                    this.adapter.sendTo(obj.from, obj.command, { sent: false, error: 'no payload' }, obj.callback);
                }
                return;
            }
            if (person) {
                // Person-targeted: routes via the Announce RPC's room_id/user_id (#31) instead of
                // the room-only satellite_control stream path used below. room/rooms combined with
                // person is AND semantics — one Announce call per room, see AnnounceFn/hannah.proto.
                void (async (): Promise<void> => {
                    const userId = await this.resolveRoomieUserId(person);
                    if (userId === null) {
                        this.adapter.log.warn(`[messages] announce: unknown person '${person}'`);
                        if (obj.callback) {
                            this.adapter.sendTo(
                                obj.from,
                                obj.command,
                                { sent: false, error: `unknown person '${person}'` },
                                obj.callback,
                            );
                        }
                        return;
                    }
                    const roomIds: string[] = Array.isArray(rooms) ? rooms : rooms ? [rooms] : room ? [room] : [];
                    const targets = roomIds.length ? roomIds : [''];
                    const results = await Promise.all(targets.map(r => this.announceRpc(text, { roomId: r, userId })));
                    const ok = results.every(r => r.ok);
                    this.adapter.log.debug(
                        `[messages] announce person=${person} userId=${userId} rooms=${JSON.stringify(roomIds)} text=${text}`,
                    );
                    if (obj.callback) {
                        this.adapter.sendTo(obj.from, obj.command, { sent: ok }, obj.callback);
                    }
                })();
                return;
            }
            const roomList: string[] = Array.isArray(rooms) ? rooms : rooms ? [rooms] : room ? [room] : ['all'];
            for (const r of roomList) {
                this.send({ satelliteControl: { room: r, deviceId: '', announcement: text } });
            }
            this.adapter.log.debug(`[messages] announce rooms=${JSON.stringify(roomList)} text=${text}`);
            if (obj.callback) {
                this.adapter.sendTo(obj.from, obj.command, { sent: true }, obj.callback);
            }
        } else if (obj.command === 'ask') {
            const { room, text } = (obj.message ?? {}) as AskPayload;
            if (!text) {
                if (obj.callback) {
                    this.adapter.sendTo(obj.from, obj.command, { sent: false, error: 'no payload' }, obj.callback);
                }
                return;
            }
            const correlationId = randomUUID();
            if (obj.callback) {
                this._pending.set(correlationId, { from: obj.from, command: obj.command, cb: obj.callback });
            }
            const roomValue = room || 'all';
            this.send({ askResident: { correlationId, room: roomValue, question: text } });
            this.adapter.log.debug(`[messages] ask corr=${correlationId} room=${roomValue} text=${text}`);
        }
    }

    /**
     * Called when the gRPC connection to Hannah Core drops. Any `ask` still waiting on an answer
     * can never receive one over the dead stream (askResident/resident_answered both travel over
     * the AgentConnect stream) — without this, its correlation entry and the caller's sendTo
     * callback would stay in `_pending` forever.
     */
    public onDisconnected(): void {
        for (const [correlationId, cb] of this._pending) {
            this.adapter.log.warn(`[messages] ask corr=${correlationId} abandoned — Hannah Core disconnected`);
            this.adapter.sendTo(cb.from, cb.command, { sent: false, error: 'Hannah Core disconnected' }, cb.cb);
        }
        this._pending.clear();
    }

    /**
     * Called when Hannah sends back a resident's spoken answer for a pending ask.
     *
     * @param cmd - callback command payload
     * @param cmd.correlationId - correlation id for the pending ask
     * @param cmd.answer - resident's spoken answer
     */
    public onResidentAnswered(cmd: { correlationId: string; answer: string }): void {
        const { correlationId, answer } = cmd;
        const cb = this._pending.get(correlationId);
        if (!cb) {
            this.adapter.log.warn(`[messages] resident_answered: unknown correlation_id ${correlationId}`);
            return;
        }
        this._pending.delete(correlationId);
        this.adapter.log.debug(`[messages] resident_answered corr=${correlationId} answer=${answer}`);
        this.adapter.sendTo(cb.from, cb.command, { answer }, cb.cb);
    }

    /**
     * What makes a notification the same one again: who sent it and what it says, not when (the
     * `ts` of a message is new at every repetition, `shelly` repeats its firmware notice every 15 minutes).
     *
     * @param notification - The notification as ioBroker sends it
     * @param text - The text that is forwarded for it
     */
    private dedupeKey(notification: NotificationMessage | undefined, text: string): string {
        const instances = notification?.category?.instances ?? notification?.instances ?? {};
        const messages = Object.values(instances).flatMap(data => (data.messages ?? []).map(m => m.message ?? ''));
        return JSON.stringify([
            Object.keys(instances).sort(),
            this.titleOf(notification?.category?.name),
            messages.length ? [...new Set(messages)].sort() : text,
        ]);
    }

    /**
     * Whether a notification was announced within the window already. Counted from the first
     * announcement, so a notification that stays pending is announced again once a day. Entries
     * older than the window are dropped on the way, the map does not grow.
     *
     * @param key - `dedupeKey()` of the notification
     */
    private isRepeat(key: string): boolean {
        const now = this.now();
        for (const [known, at] of this._announced) {
            if (now - at >= ANNOUNCE_WINDOW_MS) {
                this._announced.delete(known);
            }
        }
        return this._announced.has(key);
    }

    /**
     * The title of a notification category as a plain string, without a trailing full stop.
     *
     * @param name - `category.name`: a text, or a text per language
     */
    private titleOf(name: string | { de?: string; en?: string } | undefined): string {
        const text = typeof name === 'string' ? name : (name?.de ?? name?.en ?? '');
        return text.trim().replace(/\.+$/, '');
    }

    private extractText(notification: NotificationMessage | undefined): string | null {
        try {
            const instances = notification?.category?.instances ?? notification?.instances ?? {};
            const parts: string[] = [];
            for (const data of Object.values(instances)) {
                for (const msg of data.messages ?? []) {
                    if (msg.message) {
                        parts.push(msg.message);
                    }
                }
            }
            if (parts.length) {
                const text = [...new Set(parts)].join('. ');
                // The message alone is often only a value (a date, a device name): the title of the
                // category says what it is about, and Core's LLM has nothing else to go on.
                const title = this.titleOf(notification?.category?.name);
                return title && !text.toLowerCase().includes(title.toLowerCase()) ? `${title}: ${text}` : text;
            }

            const desc = notification?.category?.description;
            if (typeof desc === 'string') {
                return desc;
            }
            if (desc && typeof desc === 'object') {
                return desc.de ?? desc.en ?? null;
            }

            const name = notification?.category?.name;
            if (typeof name === 'string') {
                return name;
            }
            if (name && typeof name === 'object') {
                return name.de ?? name.en ?? null;
            }
        } catch (e) {
            this.adapter.log.warn(`Failed to extract text: ${(e as Error).message}`);
        }
        return null;
    }
}
