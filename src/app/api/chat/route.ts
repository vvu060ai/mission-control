import { NextRequest } from 'next/server';

export async function POST(req: NextRequest) {
    try {
        const { gatewayUrl, token, agentId, messages, openrouterModel } = await req.json();

        if (!gatewayUrl) {
            return new Response(JSON.stringify({ error: 'Missing gatewayUrl' }), { status: 400 });
        }

        const lastUserMessage = messages.filter((m: { role: string }) => m.role === 'user').pop();
        const userText = lastUserMessage?.content || '';

        if (!userText) {
            return new Response(JSON.stringify({ error: 'No user message found' }), { status: 400 });
        }

        // ─── Route via OpenRouter if a model is selected ────────────────────────
        if (openrouterModel) {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
                return new Response(JSON.stringify({ error: 'OPENROUTER_API_KEY not configured on server' }), { status: 500 });
            }

            // Build full conversation history for OpenRouter (not just last message)
            const history = messages.map((m: { role: string; content: string }) => ({
                role: m.role,
                content: m.content,
            }));

            const upstreamRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-Title': 'Mission Control',
                },
                body: JSON.stringify({
                    model: openrouterModel,
                    messages: history,
                    stream: true,
                }),
            });

            if (!upstreamRes.ok) {
                const errText = await upstreamRes.text();
                console.error('OpenRouter chat error:', upstreamRes.status, errText);
                let errMsg = `OpenRouter returned ${upstreamRes.status}`;
                try {
                    const errJson = JSON.parse(errText);
                    errMsg = errJson.error?.message || errJson.message || errMsg;
                } catch { /* not json */ }
                return new Response(JSON.stringify({ error: errMsg }), { status: upstreamRes.status });
            }

            // Pipe the SSE stream straight through
            return new Response(upstreamRes.body, {
                headers: {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                },
            });
        }

        // ─── Fallback: Route via OpenClaw Gateway (original behaviour) ──────────
        const httpBase = gatewayUrl
            .replace(/^ws:\/\//i, 'http://')
            .replace(/^wss:\/\//i, 'https://')
            .replace(/\/$/, '');

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
