import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');

function readOpenClawConfig(): Record<string, any> {
    try {
        return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function writeOpenClawConfig(config: Record<string, any>) {
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * GET /api/models
 * Returns list of available OpenRouter models + the currently active model
 */
export async function GET() {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
        return NextResponse.json({ error: 'OPENROUTER_API_KEY not configured' }, { status: 500 });
    }

    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'Mission Control',
            },
        });

        if (!res.ok) {
            const errText = await res.text();
            return NextResponse.json({ error: `OpenRouter error: ${errText}` }, { status: res.status });
        }

        const data = await res.json();

        // Read current model from openclaw.json
        const config = readOpenClawConfig();
        const currentModel: string = config?.agents?.defaults?.model?.primary || 'google/gemini-3-flash-preview';

        return NextResponse.json({
            models: data.data || [],
            currentModel,
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to fetch models' }, { status: 500 });
    }
}

/**
 * POST /api/models
 * Body: { model: string }
 * Updates the primary model in openclaw.json and returns success
 */
export async function POST(req: NextRequest) {
    try {
        const { model } = await req.json();
        if (!model || typeof model !== 'string') {
            return NextResponse.json({ error: 'Missing or invalid model field' }, { status: 400 });
        }

        const config = readOpenClawConfig();

        // Ensure the nested structure exists
        if (!config.agents) config.agents = {};
        if (!config.agents.defaults) config.agents.defaults = {};
        if (!config.agents.defaults.model) config.agents.defaults.model = {};
        if (!config.agents.defaults.models) config.agents.defaults.models = {};

        // Set the primary model
        const previousModel = config.agents.defaults.model.primary;
        config.agents.defaults.model.primary = model;

        // Keep the models map in sync (add the new model if it doesn't exist)
        if (!config.agents.defaults.models[model]) {
            config.agents.defaults.models[model] = {};
        }

        // Update meta
        config.meta = {
            ...(config.meta || {}),
            lastTouchedAt: new Date().toISOString(),
            lastTouchedBy: 'mission-control',
        };

        writeOpenClawConfig(config);

        return NextResponse.json({
            success: true,
            previousModel,
            currentModel: model,
            message: `Model updated to ${model}`,
        });
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to update model' }, { status: 500 });
    }
}
