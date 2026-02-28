/**
 * GatewayHub — singleton pool of GatewayConnections.
 *
 * One instance lives for the lifetime of the Next.js server process.
 * All API routes import this singleton to call RPC methods or subscribe to events.
 *
 * Usage:
 *   import { gatewayHub } from '@/lib/gateway-hub';
 *
 *   // Register a gateway (idempotent — reuses existing connection)
 *   await gatewayHub.register('ws://127.0.0.1:18789', 'token...');
 *
 *   // Call an RPC method on a specific gateway
 *   const config = await gatewayHub.call('ws://127.0.0.1:18789', 'config.get', {});
 *
 *   // Subscribe to all events from all gateways
 *   const unsub = gatewayHub.subscribe((event) => console.log(event));
 */

import { GatewayConnection, GatewayEvent, ConnectionStatus } from './gateway-connection';

export type { GatewayEvent, ConnectionStatus };

export interface GatewayStatus {
    url: string;
    status: ConnectionStatus;
    deviceToken: string | null;
}

class GatewayHub {
    private connections = new Map<string, GatewayConnection>();
    private subscribers = new Set<(event: GatewayEvent) => void>();

    /**
     * Register a gateway URL. If a connection already exists for this URL,
     * returns the existing one (idempotent). Creates and connects if new.
     */
    async register(url: string, token: string): Promise<GatewayConnection> {
        const existing = this.connections.get(url);
        if (existing) {
            // Update token in case it changed (e.g. re-pairing)
            (existing as unknown as { token: string }).token = token;
            return existing;
        }

        const conn = new GatewayConnection(url, token);

        // Fan all events from this connection to hub subscribers
        conn.on('gateway-event', (evt: GatewayEvent) => {
            for (const sub of this.subscribers) {
                try { sub(evt); } catch { /* don't let one bad subscriber break others */ }
            }
        });

        conn.on('status', (status: ConnectionStatus) => {
            console.log(`[GatewayHub] ${url} → ${status}`);
        });

        this.connections.set(url, conn);

        // Connect in background — caller gets the connection object immediately.
        // The connection will auto-reconnect if the first attempt fails.
        conn.connect().catch((err) => {
            console.error(`[GatewayHub] Initial connect to ${url} failed:`, err.message);
            // GatewayConnection already schedules reconnects internally.
        });

        return conn;
    }

    /**
     * Call an RPC method on a specific gateway.
     * @throws if the gateway is not registered or not connected.
     */
    async call<T = unknown>(url: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
        const conn = this.connections.get(url);
        if (!conn) throw new Error(`Gateway not registered: ${url}. Call register() first.`);
        return conn.call<T>(method, params);
    }

    /**
     * Subscribe to all gateway events from all connections.
     * Returns an unsubscribe function.
     */
    subscribe(handler: (event: GatewayEvent) => void): () => void {
        this.subscribers.add(handler);
        return () => this.subscribers.delete(handler);
    }

    /**
     * Get status of all registered gateways.
     */
    getStatus(): GatewayStatus[] {
        return Array.from(this.connections.entries()).map(([url, conn]) => ({
            url,
            status: conn.getStatus(),
            deviceToken: conn.getDeviceToken(),
        }));
    }

    /**
     * Get a specific connection (for advanced use).
     */
    getConnection(url: string): GatewayConnection | undefined {
        return this.connections.get(url);
    }

    /**
     * Check if a gateway is registered and connected.
     */
    isConnected(url: string): boolean {
        return this.connections.get(url)?.getStatus() === 'connected';
    }

    /**
     * Remove and destroy a gateway connection.
     */
    unregister(url: string): void {
        const conn = this.connections.get(url);
        if (conn) {
            conn.destroy();
            this.connections.delete(url);
        }
    }
}

// Singleton — one hub for the lifetime of the Next.js server process.
// In dev with HMR, Next.js re-evaluates modules but we attach to globalThis
// to survive hot reloads without dangling connections.

declare global {
    // eslint-disable-next-line no-var
    var __gatewayHub: GatewayHub | undefined;
}

export const gatewayHub: GatewayHub = globalThis.__gatewayHub ?? (globalThis.__gatewayHub = new GatewayHub());
