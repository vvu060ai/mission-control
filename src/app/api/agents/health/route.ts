import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { url } = body;

        if (!url) {
            return NextResponse.json({ online: false, error: 'Missing url' }, { status: 400 });
        }

        // Convert ws:// -> http:// to probe the gateway's HTTP server
        const httpBase = url
            .replace(/^ws:\/\//i, 'http://')
            .replace(/^wss:\/\//i, 'https://')
            .replace(/\/$/, '');

        // Any HTTP response at all (even 404/400/101) means the gateway process
        // is up and listening. Only a connection refused or timeout means it's offline.
        const res = await fetch(`${httpBase}/`, {
            method: 'HEAD',
            signal: AbortSignal.timeout(4000),
        });

        // The gateway responds with any HTTP status — it's online
        // (it returns 404 for unknown routes, which is fine)
        if (res.status > 0) {
            return NextResponse.json({ online: true });
        }

        return NextResponse.json({ online: false, error: 'No response' });
    } catch (error: unknown) {
        // ECONNREFUSED or timeout = gateway truly offline
        const message = error instanceof Error ? error.message : 'Unreachable';
        return NextResponse.json({ online: false, error: message });
    }
}
