/**
 * GET /api/gateway/events
 *
 * Server-Sent Events (SSE) stream — pushes all OpenClaw gateway events
 * to the browser in real time.
 *
 * Query params:
 *   gateways  - comma-separated gateway URLs to register (optional, for auto-register)
 *   token     - auth token (used when registering gateways)
 *
 * Each SSE message format:
 *   event: gateway-event
 *   data: {"gatewayUrl":"ws://...","event":"agent.output","payload":{...},"seq":1}
 *
 * Browser usage:
 *   const es = new EventSource('/api/gateway/events');
 *   es.addEventListener('gateway-event', (e) => {
 *     const evt = JSON.parse(e.data);
 *     // evt.gatewayUrl, evt.event, evt.payload, evt.seq
 *   });
 *   es.addEventListener('status', (e) => {
 *     const s = JSON.parse(e.data); // { gateways: GatewayStatus[] }
 *   });
 */
import { NextRequest } from 'next/server';
import { gatewayHub, GatewayEvent } from '@/lib/gateway-hub';

// Next.js edge-compatible streaming response
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    const url = new URL(req.url);
    const gatewayUrls = url.searchParams.get('gateways')?.split(',').filter(Boolean) ?? [];
    const token = url.searchParams.get('token') ?? '';

    // Register any gateways passed in the query (idempotent)
    if (gatewayUrls.length > 0 && token) {
        await Promise.all(gatewayUrls.map((u) => gatewayHub.register(u.trim(), token)));
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            // Helper to send SSE frames
            const send = (eventName: string, data: unknown) => {
                try {
                    controller.enqueue(
                        encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
                    );
                } catch {
                    // Controller is closed (browser disconnected)
                }
            };

            // Send initial status snapshot
            send('status', { gateways: gatewayHub.getStatus() });

            // Subscribe to all gateway events
            const unsubscribe = gatewayHub.subscribe((evt: GatewayEvent) => {
                send('gateway-event', evt);
            });

            // Push status updates every 30s so the browser knows the connection is alive
            const statusInterval = setInterval(() => {
                send('status', { gateways: gatewayHub.getStatus() });
            }, 30_000);

            // Cleanup when browser disconnects
            req.signal.addEventListener('abort', () => {
                unsubscribe();
                clearInterval(statusInterval);
                try { controller.close(); } catch { /* already closed */ }
            });
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no', // Disable Nginx buffering for SSE
        },
    });
}
