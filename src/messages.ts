import type * as utils from '@iobroker/adapter-core';

interface NotificationMessage {
    category?: {
        severity?: string;
        description?: string | { de?: string; en?: string };
        name?: string | { de?: string; en?: string };
        instances?: Record<string, { messages?: Array<{ message?: string }> }>;
    };
    instances?: Record<string, { messages?: Array<{ message?: string }> }>;
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

export class MessagesHandler {
    private adapter: utils.AdapterInstance;
    private notify: NotifyFn;

    /**
     * @param adapter - ioBroker adapter instance
     * @param notify - Unary gRPC call to Hannah Core
     */
    constructor(adapter: utils.AdapterInstance, notify: NotifyFn) {
        this.adapter = adapter;
        this.notify = notify;
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
            const { text } = (obj.message ?? {}) as { text?: string };
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
            void this.notify(text, false, severity)

                .then(resp => {
                    if (obj.callback) {
                        this.adapter.sendTo(obj.from, obj.command, { sent: resp.ok }, obj.callback);
                    }
                })
                .catch((err: Error) => {
                    this.adapter.log.warn(`[messages] sendNotification failed: ${err.message}`);
                    if (obj.callback) {
                        this.adapter.sendTo(obj.from, obj.command, { sent: false, error: err.message }, obj.callback);
                    }
                });
        }
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
                return parts.join('. ');
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
