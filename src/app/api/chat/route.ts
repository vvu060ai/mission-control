import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { gatewayUrl, token, agentId, messages } = await req.json();

        if (!gatewayUrl) {
            return new Response(JSON.stringify({ error: 'Missing gatewayUrl' }), { status: 400 });
        }

        // Convert ws:// -> http:// to get the HTTP base URL for the gateway
        const httpBase = gatewayUrl
            .replace(/^ws:\/\//i, 'http://')
            .replace(/^wss:\/\//i, 'https://')
            .replace(/\/$/, '');

        const lastUserMessage = messages.filter((m: { role: string }) => m.role === 'user').pop();
        const userText = lastUserMessage?.content || '';

        if (!userText) {
            return new Response(JSON.stringify({ error: 'No user message found' }), { status: 400 });
        }

        // Call the gateway's OpenAI-compatible chat completions endpoint
        // It uses Bearer token auth and supports streaming SSE
        const upstreamRes = await fetch(`${httpBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify({
                model: agentId || 'main',
                messages: [{ role: 'user', content: userText }],
                stream: true,
            }),
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            console.error('Gateway chat completions error:', upstreamRes.status, errText);

            // Try to parse as JSON for a cleaner error message
            let errMsg = `Gateway returned ${upstreamRes.status}`;
            try {
                const errJson = JSON.parse(errText);
                errMsg = errJson.error?.message || errJson.message || errMsg;
            } catch { /* not json */ }

            return new Response(JSON.stringify({ error: errMsg }), { status: upstreamRes.status });
        }

        // Pipe the SSE stream straight through to the browser
        return new Response(upstreamRes.body, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Chat proxy error:', message);
        return new Response(JSON.stringify({ error: message }), { status: 500 });
    }
}
