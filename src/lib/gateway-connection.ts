/**
 * GatewayConnection — one persistent, auto-reconnecting WebSocket per OpenClaw instance.
 *
 * Lifecycle:
 *   connect() → Ed25519 handshake → OPEN
 *   → ping every 30s (WS protocol frames, zero data overhead)
 *   → on disconnect → exponential backoff reconnect (2s → 4s → 8s → 30s cap)
 *
 * Usage:
 *   const conn = new GatewayConnection('ws://127.0.0.1:18789', 'token...');
 *   conn.onEvent = (evt) => { ... };
 *   await conn.connect();
 *   const result = await conn.call('config.get', {});
 */

import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const PROTOCOL_VERSION = 3;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;
const BACKOFF_STEPS = [2000, 4000, 8000, 16000, 30000];

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed';

export interface GatewayEvent {
    gatewayUrl: string;
    event: string;
    payload: unknown;
    seq: number;
}

interface InflightRequest {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class GatewayConnection extends EventEmitter {
    readonly url: string;
    private token: string;
    private ws: WebSocket | null = null;
    private status: ConnectionStatus = 'connecting';
    private deviceToken: string | null = null;
    private inflight = new Map<string, InflightRequest>();
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempt = 0;
    private seq = 0;
    private destroyed = false;

    // Identity (shared across all connections, same as gateway.ts)
    private static identityCache: { deviceId: string; publicKeyPem: string; privateKeyPem: string } | null = null;

    constructor(url: string, token: string) {
        super();
        this.url = url;
        this.token = token;
    }

    getStatus(): ConnectionStatus { return this.status; }
    getDeviceToken(): string | null { return this.deviceToken; }

    // ── Identity ──────────────────────────────────────────────────────────────

    private static getIdentityPath() {
        return path.join(os.homedir(), '.openclaw', 'identity', 'mission-control.json');
    }

    private static base64UrlEncode(buf: Buffer): string {
        return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    }

    private static deriveRawPublicKey(pem: string): Buffer {
        const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;
        if (der.length === ED25519_SPKI_PREFIX.length + 32 &&
            der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
            return der.subarray(ED25519_SPKI_PREFIX.length);
        }
        return der;
    }

    private static loadOrCreateIdentity() {
        if (GatewayConnection.identityCache) return GatewayConnection.identityCache;

        const p = GatewayConnection.getIdentityPath();
        try {
            if (fs.existsSync(p)) {
                const d = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (d.deviceId && d.publicKeyPem && d.privateKeyPem) {
                    GatewayConnection.identityCache = d;
                    return d;
                }
            }
        } catch { /* regenerate */ }

        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
        const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        const rawPub = GatewayConnection.deriveRawPublicKey(publicKeyPem);
        const deviceId = crypto.createHash('sha256').update(rawPub).digest('hex');
        const identity = { deviceId, publicKeyPem, privateKeyPem };

        try {
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify({ ...identity, version: 1 }, null, 2), { mode: 0o600 });
        } catch { /* best effort */ }

        GatewayConnection.identityCache = identity;
        return identity;
    }

    private buildAndSignAuth(nonce: string) {
        const identity = GatewayConnection.loadOrCreateIdentity();
        const signedAt = Date.now();
        const scopes = ['operator.admin', 'operator.read', 'operator.write', 'operator.pairing', 'operator.approvals'];
        const role = 'operator';

        const payload = [
            'v3',
            identity.deviceId,
            'gateway-client',
            'backend',
            role,
            scopes.join(','),
            String(signedAt),
            this.token ?? '',
            nonce,
            'darwin',
            '',
        ].join('|');

        const signature = GatewayConnection.base64UrlEncode(
            crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem))
        );
        const rawPub = GatewayConnection.deriveRawPublicKey(identity.publicKeyPem);
        const publicKeyB64 = GatewayConnection.base64UrlEncode(rawPub);

        return { identity, signedAt, role, scopes, signature, publicKeyB64 };
    }

    // ── Connect & Handshake ───────────────────────────────────────────────────

    connect(): Promise<void> {
        if (this.destroyed) return Promise.reject(new Error('Connection is closed'));
        if (this.status === 'connected') return Promise.resolve();

        return new Promise((resolve, reject) => {
            this.setStatus('connecting');

            const ws = new WebSocket(this.url, {
                headers: {
                    'User-Agent': 'mission-control/2.0.0',
                    'Origin': 'http://127.0.0.1:18789',
                },
            });
            this.ws = ws;

            const onceReady = (err?: Error) => {
                ws.off('error', onceError);
                if (err) reject(err); else resolve();
            };
            const onceError = (err: Error) => {
                ws.off('open', () => { /* no-op */ });
                onceReady(err);
            };

            ws.once('error', onceError);

            ws.on('message', (raw) => {
                let msg: Record<string, unknown>;
                try { msg = JSON.parse(raw.toString()); } catch { return; }

                // Handshake challenge
                if (msg.type === 'event' && msg.event === 'connect.challenge') {
                    const nonce = (msg.payload as Record<string, string>).nonce;
                    const { identity, signedAt, role, scopes, signature, publicKeyB64 } = this.buildAndSignAuth(nonce);

                    ws.send(JSON.stringify({
                        type: 'req',
                        id: crypto.randomUUID(),
                        method: 'connect',
                        params: {
                            minProtocol: PROTOCOL_VERSION,
                            maxProtocol: PROTOCOL_VERSION,
                            role,
                            scopes,
                            client: { id: 'gateway-client', version: '2.0.0', platform: 'darwin', mode: 'backend' },
                            device: { id: identity.deviceId, publicKey: publicKeyB64, signature, signedAt, nonce },
                            auth: { token: this.token },
                        },
                    }));
                }

                // Handshake accepted
                if (msg.type === 'res' && msg.ok) {
                    const payload = msg.payload as Record<string, unknown> | undefined;
                    const auth = payload?.auth as Record<string, string> | undefined;
                    if (auth?.deviceToken) this.deviceToken = auth.deviceToken;
                    this.setStatus('connected');
                    this.reconnectAttempt = 0;
                    this.startPing();
                    onceReady();
                    return;
                }

                // Handshake rejected
                if (msg.type === 'res' && !msg.ok && this.status !== 'connected') {
                    const err = msg.error as Record<string, string> | undefined;
                    onceReady(new Error(err?.message || 'Handshake failed'));
                    return;
                }

                // RPC response (correlation by id)
                if (msg.type === 'res' && typeof msg.id === 'string') {
                    const inflight = this.inflight.get(msg.id as string);
                    if (inflight) {
                        clearTimeout(inflight.timer);
                        this.inflight.delete(msg.id as string);
                        if (msg.ok) inflight.resolve(msg.payload);
                        else {
                            const e = msg.error as Record<string, string> | undefined;
                            inflight.reject(new Error(e?.message || 'RPC failed'));
                        }
                    }
                }

                // Application event — fan out
                if (msg.type === 'event' && msg.event !== 'connect.challenge') {
                    const evt: GatewayEvent = {
                        gatewayUrl: this.url,
                        event: msg.event as string,
                        payload: msg.payload,
                        seq: ++this.seq,
                    };
                    try {
                        fs.appendFileSync('/tmp/mission-control-events.log', JSON.stringify(evt) + '\n');
                    } catch (e) { }
                    this.emit('gateway-event', evt);
                }

                // Pong received (application-level, not WS pong)
                if (msg.type === 'pong') {
                    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
                }
            });

            ws.on('pong', () => {
                // WS protocol-level pong received → connection is alive
                if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
            });

            ws.on('close', () => {
                this.stopPing();
                this.drainInflight(new Error('Connection closed'));
                if (!this.destroyed) {
                    this.setStatus('reconnecting');
                    this.scheduleReconnect();
                }
            });

            ws.on('error', (err) => {
                console.error(`[GatewayConnection] ${this.url} error:`, err.message);
                if (this.status === 'connected') {
                    this.stopPing();
                    this.drainInflight(err);
                    this.setStatus('reconnecting');
                    this.scheduleReconnect();
                }
            });
        });
    }

    // ── RPC Call ──────────────────────────────────────────────────────────────

    call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        if (this.destroyed) return Promise.reject(new Error('Connection is closed'));
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error(`Not connected to ${this.url}`));
        }

        return new Promise<T>((resolve, reject) => {
            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
                this.inflight.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, CALL_TIMEOUT_MS);

            this.inflight.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
                timer,
            });

            this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
        });
    }

    // ── Heartbeat (WS protocol-level ping — zero application overhead) ────────

    private startPing() {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            // WS protocol ping — the gateway's WS stack responds with pong automatically.
            // No application payload. This is NOT an application message.
            this.ws.ping();

            this.pongTimer = setTimeout(() => {
                console.warn(`[GatewayConnection] ${this.url} pong timeout — reconnecting`);
                this.ws?.terminate();
            }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
    }

    private stopPing() {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    }

    // ── Reconnect ─────────────────────────────────────────────────────────────

    private scheduleReconnect() {
        if (this.destroyed) return;
        const delay = BACKOFF_STEPS[Math.min(this.reconnectAttempt, BACKOFF_STEPS.length - 1)];
        this.reconnectAttempt++;
        console.log(`[GatewayConnection] ${this.url} reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch((err) => {
                console.error(`[GatewayConnection] ${this.url} reconnect failed:`, err.message);
                this.scheduleReconnect();
            });
        }, delay);
    }

    // ── Drain in-flight on disconnect ─────────────────────────────────────────

    private drainInflight(err: Error) {
        for (const [id, req] of this.inflight) {
            clearTimeout(req.timer);
            req.reject(err);
            this.inflight.delete(id);
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    private setStatus(s: ConnectionStatus) {
        this.status = s;
        this.emit('status', s);
    }

    destroy() {
        this.destroyed = true;
        this.setStatus('closed');
        this.stopPing();
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.drainInflight(new Error('Connection destroyed'));
        this.ws?.terminate();
        this.ws = null;
    }
}
