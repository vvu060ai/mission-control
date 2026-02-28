"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Send, User, Bot, Loader2, MessageSquare, Shield, ChevronDown, Zap, Search, Check, Plus } from "lucide-react";

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

export interface AgentPersona {
    id: string;
    name: string;
    model: string;
}

interface Connection {
    url: string;
    token: string;
    deviceToken: string;
    agentId: string;
    port: string;
    status: 'connected' | 'error';
}

interface OpenRouterModel {
    id: string;
    name: string;
    description?: string;
    pricing?: {
        prompt: string;
        completion: string;
    };
    context_length?: number;
    architecture?: {
        modality: string;
    };
}

const STORAGE_KEY_MODEL = 'mission_control_openrouter_model';

export default function Chat({ connections }: { connections: Connection[] }) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [selectedConnection, setSelectedConnection] = useState<Connection | null>(connections[0] || null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const [gatewayAgents, setGatewayAgents] = useState<Record<string, AgentPersona[]>>({});

    // Real-time agent thought tracking
    const [activeThought, setActiveThought] = useState<{ icon: string, text: string } | null>(null);

    // Model selector state
    const [models, setModels] = useState<OpenRouterModel[]>([]);
    const [selectedModel, setSelectedModel] = useState<string>('');
    const [modelSearch, setModelSearch] = useState('');
    const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [isSavingModel, setIsSavingModel] = useState(false);
    const [modelSaveStatus, setModelSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Load persisted model on mount
    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY_MODEL);
        if (saved) setSelectedModel(saved);
    }, []);

    // Fetch OpenRouter models once on mount
    const fetchModels = useCallback(async () => {
        setIsFetchingModels(true);
        try {
            const res = await fetch('/api/models');
            const data = await res.json();
            if (data.models) {
                // Sort: by name alphabetically
                const sorted = [...data.models].sort((a: OpenRouterModel, b: OpenRouterModel) =>
                    a.name.localeCompare(b.name)
                );
                setModels(sorted);
            }
            // If no local preference, use what's in openclaw.json
            if (!localStorage.getItem(STORAGE_KEY_MODEL) && data.currentModel) {
                setSelectedModel(data.currentModel);
            }
        } catch (e) {
            console.error("Failed to fetch models", e);
        } finally {
            setIsFetchingModels(false);
        }
    }, []);

    useEffect(() => { fetchModels(); }, [fetchModels]);

    // Close dropdown on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setIsModelDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleSelectModel = async (modelId: string) => {
        setSelectedModel(modelId);
        localStorage.setItem(STORAGE_KEY_MODEL, modelId);
        setIsModelDropdownOpen(false);
        setIsSavingModel(true);
        setModelSaveStatus('idle');

        try {
            const res = await fetch('/api/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: modelId,
                    agentId: selectedConnection?.agentId
                }),
            });
            const data = await res.json();
            if (data.success) {
                setModelSaveStatus('saved');
                setTimeout(() => setModelSaveStatus('idle'), 2500);
            } else {
                setModelSaveStatus('error');
            }
        } catch {
            setModelSaveStatus('error');
        } finally {
            setIsSavingModel(false);
        }
    };

    // When connection/agentId changes, fetch the current model
    useEffect(() => {
        const fetchCurrentAgentModel = async () => {
            if (!selectedConnection) return;
            try {
                const res = await fetch(`/api/models?agentId=${encodeURIComponent(selectedConnection.agentId)}`);
                const data = await res.json();
                if (data.currentModel) {
                    setSelectedModel(data.currentModel);
                }
            } catch (e) {
                console.error("Failed to fetch agent model", e);
            }
        };
        fetchCurrentAgentModel();
    }, [selectedConnection?.agentId]);

    const filteredModels = models.filter(m =>
        m.id.toLowerCase().includes(modelSearch.toLowerCase()) ||
        m.name.toLowerCase().includes(modelSearch.toLowerCase())
    );

    const selectedModelInfo = models.find(m => m.id === selectedModel);

    const fetchAgents = useCallback(async () => {
        const newGatewayAgents: Record<string, AgentPersona[]> = {};
        for (const conn of connections) {
            try {
                const res = await fetch(`/api/agents?gatewayUrl=${encodeURIComponent(conn.url)}&token=${encodeURIComponent(conn.token)}`);
                if (res.ok) {
                    const data = await res.json();
                    newGatewayAgents[conn.url] = data.agents;
                }
            } catch (e) {
                console.error("Failed to fetch agents:", e);
            }
        }
        setGatewayAgents(newGatewayAgents);
    }, [connections]);

    useEffect(() => {
        fetchAgents();
    }, [fetchAgents]);

    useEffect(() => {
        if (!selectedConnection && connections.length > 0) {
            setSelectedConnection(connections[0]);
        }

        if (selectedConnection) {
            const saved = localStorage.getItem(`mission_control_msgs_${selectedConnection.url}_${selectedConnection.agentId}`);
            if (saved) {
                try {
                    setMessages(JSON.parse(saved));
                } catch (e) {
                    console.error("Failed to load chat history", e);
                }
            } else {
                setMessages([]);
            }
        }
    }, [connections, selectedConnection]);

    useEffect(() => {
        if (selectedConnection && messages.length > 0) {
            localStorage.setItem(`mission_control_msgs_${selectedConnection.url}_${selectedConnection.agentId}`, JSON.stringify(messages));
        }
    }, [messages, selectedConnection]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, activeThought]);

    // Track active agent background processes via SSE
    useEffect(() => {
        if (!selectedConnection) {
            setActiveThought(null);
            return;
        }

        const url = `/api/gateway/events?gateways=${encodeURIComponent(selectedConnection.url)}&token=${encodeURIComponent(selectedConnection.token)}`;
        const es = new EventSource(url);

        es.addEventListener('gateway-event', (e) => {
            try {
                const evt = JSON.parse(e.data);
                // The gateway emits events like agent.tool_call, agent.step, agent.output
                if (evt.event === 'agent.step') {
                    setActiveThought({ icon: '🧠', text: 'Analyzing request...' });
                } else if (evt.event === 'agent.tool_call') {
                    let toolName = '?';
                    if (typeof evt.payload?.tool === 'string') {
                        toolName = evt.payload.tool;
                    } else if (evt.payload?.tool?.name) {
                        toolName = evt.payload.tool.name;
                    }
                    setActiveThought({ icon: '🔧', text: `Using tool: ${toolName}` });
                } else if (evt.event === 'agent.tool_result') {
                    setActiveThought({ icon: '✅', text: `Tool returned data` });
                } else if (evt.event === 'agent.error') {
                    setActiveThought({ icon: '❌', text: 'Encountered error, checking paths...' });
                } else if (evt.event === 'agent.output') {
                    // Start of text generation
                    setActiveThought(null);
                }
            } catch (err) { }
        });

        return () => {
            es.close();
            setActiveThought(null);
        };
    }, [selectedConnection]);

    const handleShareContext = async () => {
        if (!selectedConnection) return;
        const newId = prompt("Enter new agent ID (e.g. data_analyst):");
        if (!newId) return;
        const newName = prompt("Enter new agent name:");
        if (!newName) return;

        setIsLoading(true);
        try {
            const res = await fetch('/api/agents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    gatewayUrl: selectedConnection.url,
                    token: selectedConnection.token,
                    id: newId,
                    name: newName,
                    model: selectedModel || 'openrouter/auto'
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed");

            // Copy messages to new agent's local storage
            const newStorageKey = `mission_control_msgs_${selectedConnection.url}_${newId}`;
            localStorage.setItem(newStorageKey, JSON.stringify(messages));

            await fetchAgents();
            setSelectedConnection({ ...selectedConnection, agentId: newId });
        } catch (e: any) {
            alert("Failed to spawn subagent: " + e.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleCreateAgent = async (conn: Connection) => {
        const newId = prompt("Enter new agent ID (e.g. researcher):");
        if (!newId) return;
        const newName = prompt(`Enter a name for the agent '${newId}':`);
        if (!newName) return;

        setIsLoading(true);
        try {
            const res = await fetch('/api/agents', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: newId,
                    name: newName,
                    model: selectedModel || 'openrouter/auto'
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed");

            await fetchAgents();
            setSelectedConnection({ ...conn, agentId: newId });
        } catch (e: any) {
            alert("Failed to create agent: " + e.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSend = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!input.trim() || !selectedConnection || isLoading) return;

        const userMessage: Message = {
            id: Date.now().toString(),
            role: 'user',
            content: input,
            timestamp: Date.now(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setIsLoading(true);

        const assistantMsgId = (Date.now() + 1).toString();
        const assistantMessage: Message = {
            id: assistantMsgId,
            role: 'assistant',
            content: "",
            timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMessage]);

        const executeChat = async () => {
            let fullContent = "";
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    gatewayUrl: selectedConnection.url,
                    token: selectedConnection.token,
                    agentId: selectedConnection.agentId,
                    // Full history — OpenClaw manages its own context window compression
                    messages: [...messages, userMessage],
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMsg = errorData.error || 'Failed to send message';
                throw new Error(errorMsg);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No stream available');
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.trim().startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                        try {
                            const data = JSON.parse(line.trim().slice(6));
                            if (data.choices?.[0]?.delta?.content) {
                                fullContent += data.choices[0].delta.content;
                                setMessages((prev) =>
                                    prev.map((msg) =>
                                        msg.id === assistantMsgId ? { ...msg, content: fullContent } : msg
                                    )
                                );
                                // As soon as text generation begins, clear the thinking state
                                setActiveThought(null);
                            }
                        } catch (e) { }
                    }
                }
            }
        };

        try {
            setActiveThought({ icon: '🚀', text: 'Initializing...' });
            await executeChat();
        } catch (error: any) {
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.id === assistantMsgId ? { ...msg, content: `[Error communicating with gateway: ${error.message}]` } : msg
                )
            );
        } finally {
            setIsLoading(false);
            setActiveThought(null);
        }
    };

    // Format pricing string to be human-readable
    const formatPrice = (price: string) => {
        const n = parseFloat(price);
        if (n === 0) return 'Free';
        if (n < 0.001) return `$${(n * 1_000_000).toFixed(2)}/M`;
        return `$${n.toFixed(4)}`;
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* ── Model Selector Bar ──────────────────────────────────────────── */}
            {/* relative + z-50 gives this bar its own stacking context ranked above the chat panel's backdrop-blur stacking context */}
            <div className="relative z-50 flex items-center gap-4 p-4 rounded-2xl bg-slate-900/40 border border-slate-800">
                <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="p-1.5 rounded-lg bg-violet-600/20 text-violet-400">
                        <Zap size={14} />
                    </div>
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">OpenRouter Model</span>
                </div>

                {/* Dropdown */}
                <div className="relative flex-1" ref={dropdownRef}>
                    <button
                        onClick={() => setIsModelDropdownOpen(prev => !prev)}
                        disabled={isFetchingModels}
                        className="w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-black/40 border border-slate-700/60 rounded-xl hover:border-violet-500/50 transition-all text-left disabled:opacity-50 group"
                        id="model-selector-btn"
                    >
                        <div className="flex items-center gap-2 min-w-0">
                            {isFetchingModels ? (
                                <Loader2 size={14} className="animate-spin text-slate-500 flex-shrink-0" />
                            ) : (
                                <div className="w-2 h-2 rounded-full bg-violet-500 flex-shrink-0 shadow-[0_0_6px_rgba(139,92,246,0.6)]" />
                            )}
                            <span className="text-sm font-semibold text-white truncate">
                                {isFetchingModels ? 'Loading models...' : (selectedModelInfo?.name || selectedModel || 'Select a model...')}
                            </span>
                            {selectedModelInfo?.pricing && (
                                <span className="text-[10px] font-bold text-violet-400/70 bg-violet-500/10 px-2 py-0.5 rounded-full flex-shrink-0">
                                    {formatPrice(selectedModelInfo.pricing.prompt)}/tok
                                </span>
                            )}
                        </div>
                        <ChevronDown
                            size={16}
                            className={`text-slate-500 flex-shrink-0 transition-transform duration-200 ${isModelDropdownOpen ? 'rotate-180' : ''}`}
                        />
                    </button>

                    {/* Status indicator */}
                    {modelSaveStatus === 'saved' && (
                        <div className="absolute right-12 top-1/2 -translate-y-1/2 flex items-center gap-1 text-emerald-400 text-[10px] font-bold">
                            <Check size={12} />
                            <span>Saved to OpenClaw</span>
                        </div>
                    )}

                    {/* Dropdown panel – absolute, works because parent bar has z-50 stacking context */}
                    {isModelDropdownOpen && (
                        <div
                            id="model-dropdown-panel"
                            className="absolute top-full mt-2 left-0 right-0 z-50 bg-slate-950 border border-slate-700/80 rounded-2xl shadow-2xl shadow-black/80 overflow-hidden"
                        >
                            {/* Search */}
                            <div className="p-3 border-b border-slate-800">
                                <div className="flex items-center gap-2 px-3 py-2 bg-black/40 rounded-xl border border-slate-700/50">
                                    <Search size={14} className="text-slate-500 flex-shrink-0" />
                                    <input
                                        autoFocus
                                        type="text"
                                        value={modelSearch}
                                        onChange={e => setModelSearch(e.target.value)}
                                        placeholder="Search models..."
                                        className="flex-1 bg-transparent text-sm text-white placeholder:text-slate-600 outline-none"
                                        id="model-search-input"
                                    />
                                </div>
                            </div>

                            {/* Model list */}
                            <div className="max-h-72 overflow-y-auto custom-scrollbar">
                                {filteredModels.length === 0 ? (
                                    <div className="p-6 text-center text-slate-500 text-sm">No models found</div>
                                ) : (
                                    filteredModels.map(model => (
                                        <button
                                            key={model.id}
                                            onClick={() => handleSelectModel(model.id)}
                                            className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-slate-800/60 transition-colors border-b border-slate-800/40 last:border-0 ${selectedModel === model.id ? 'bg-violet-600/10' : ''}`}
                                        >
                                            <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${selectedModel === model.id ? 'bg-violet-500 shadow-[0_0_6px_rgba(139,92,246,0.6)]' : 'bg-slate-700'}`} />
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="text-sm font-semibold text-white truncate">{model.name}</span>
                                                    {model.pricing && (
                                                        <span className="text-[10px] font-bold text-slate-500 bg-slate-800 px-2 py-0.5 rounded-full flex-shrink-0">
                                                            {formatPrice(model.pricing.prompt)}/tok
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">{model.id}</p>
                                            </div>
                                            {selectedModel === model.id && (
                                                <Check size={14} className="text-violet-400 flex-shrink-0 mt-1" />
                                            )}
                                        </button>
                                    ))
                                )}
                            </div>

                            {/* Footer hint */}
                            <div className="p-3 border-t border-slate-800 flex items-center justify-between text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                                <span>{filteredModels.length} models available</span>
                                <span>Saved to openclaw.json ✦</span>
                            </div>
                        </div>
                    )}
                </div>

                {isSavingModel && (
                    <Loader2 size={16} className="animate-spin text-violet-400 flex-shrink-0" />
                )}
            </div>

            {/* ── Chat Panel ─────────────────────────────────────────────────── */}
            <div className="flex flex-col lg:flex-row h-[660px] gap-6">
                {/* Sidebar - Agent Selection */}
                <aside className="lg:w-72 flex flex-col gap-4">
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest px-2">Active Agents</h3>
                    <div className="flex flex-col gap-2 overflow-y-auto pr-2 custom-scrollbar">
                        {connections.length === 0 ? (
                            <div className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800 text-slate-500 text-xs text-center border-dashed">
                                No gateways connected.
                            </div>
                        ) : (
                            connections.map((conn) => {
                                const agents = gatewayAgents[conn.url] || [{ id: 'main', name: 'Main Agent', model: '' }];
                                return (
                                    <div key={conn.url} className="mb-4">
                                        <div className="flex items-center justify-between mb-2 pl-2 pr-1">
                                            <div className="text-[10px] text-slate-600 font-mono truncate">{conn.url}</div>
                                            <button
                                                onClick={() => handleCreateAgent(conn)}
                                                className="p-1 rounded bg-slate-800/50 text-slate-400 hover:text-white hover:bg-orange-500/20 transition-colors"
                                                title="Create New Agent Persona"
                                            >
                                                <Plus size={12} />
                                            </button>
                                        </div>
                                        <div className="flex flex-col gap-2">
                                            {agents.map((agent: AgentPersona) => (
                                                <button
                                                    key={`${conn.url}-${agent.id}`}
                                                    onClick={() => setSelectedConnection({ ...conn, agentId: agent.id })}
                                                    className={`p-3 rounded-2xl border transition-all text-left flex items-center gap-3 group ${selectedConnection?.url === conn.url && selectedConnection?.agentId === agent.id
                                                        ? 'bg-orange-600/10 border-orange-500/50 text-white shadow-lg shadow-orange-950/10'
                                                        : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-900/60'
                                                        }`}
                                                >
                                                    <div className={`p-2 rounded-lg ${selectedConnection?.url === conn.url && selectedConnection?.agentId === agent.id ? 'bg-orange-600 text-white' : 'bg-slate-800 text-slate-400 group-hover:text-white transition-colors'}`}>
                                                        <Bot size={16} />
                                                    </div>
                                                    <div className="overflow-hidden">
                                                        <p className="font-bold text-sm truncate uppercase tracking-tight">{agent.name || agent.id}</p>
                                                        <p className="text-[10px] opacity-60 font-mono truncate">ID: {agent.id}</p>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </aside>

                {/* Main Chat Window */}
                <section className="flex-1 flex flex-col bg-slate-900/30 border border-slate-800 rounded-3xl overflow-hidden backdrop-blur-xl relative">
                    {/* Chat Header */}
                    <div className="p-5 border-b border-slate-800 bg-slate-900/50 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-orange-500 to-orange-700 flex items-center justify-center text-white shadow-lg shadow-orange-900/20">
                                <MessageSquare size={20} />
                            </div>
                            <div>
                                <h4 className="font-bold text-white uppercase tracking-tight">
                                    {selectedConnection ? `Agent ${selectedConnection.agentId}` : 'Mission Interface'}
                                </h4>
                                <div className="flex items-center gap-2">
                                    <div className={`w-1.5 h-1.5 rounded-full ${selectedConnection ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`} />
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest leading-none">
                                        {selectedConnection ? 'Live Link' : 'Standby'}
                                    </span>
                                    {selectedModel && (
                                        <>
                                            <span className="text-slate-700">·</span>
                                            <span className="text-[10px] font-bold text-violet-500/80 uppercase tracking-widest truncate max-w-[160px]">
                                                {selectedModelInfo?.name || selectedModel}
                                            </span>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                        {selectedConnection && (
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={handleShareContext}
                                    className="px-3 py-1.5 rounded-full bg-violet-500/10 hover:bg-violet-500/20 border border-violet-500/20 text-[10px] font-bold text-violet-400 Transition-all uppercase flex items-center gap-2"
                                >
                                    Share Context
                                </button>
                                <div className="px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2 group cursor-help">
                                    <Shield size={12} className="text-emerald-500" />
                                    <span className="text-[10px] font-bold text-emerald-500/80 uppercase">Secured</span>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Messages Space */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                        {messages.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-center p-10 opacity-40">
                                <div className="w-16 h-16 rounded-3xl bg-slate-800 flex items-center justify-center mb-6">
                                    <Bot size={32} />
                                </div>
                                <h5 className="text-lg font-bold text-white">Interface Ready</h5>
                                <p className="text-sm max-w-[280px]">Select an agent and transmit your query to begin the mission.</p>
                            </div>
                        ) : (
                            messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`flex gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''} animate-in fade-in slide-in-from-bottom-2 duration-300`}
                                >
                                    <div className={`w-10 h-10 rounded-2xl flex-shrink-0 flex items-center justify-center shadow-lg ${msg.role === 'user'
                                        ? 'bg-blue-600 text-white shadow-blue-900/20'
                                        : 'bg-slate-800 text-slate-300 shadow-black/20'
                                        }`}>
                                        {msg.role === 'user' ? <User size={18} /> : <Bot size={18} />}
                                    </div>
                                    <div className={`flex flex-col max-w-[80%] ${msg.role === 'user' ? 'items-end' : ''}`}>
                                        <div className={`px-5 py-4 rounded-2xl text-sm leading-relaxed ${msg.role === 'user'
                                            ? 'bg-blue-600/10 border border-blue-500/30 text-white bubble-user'
                                            : 'bg-slate-800/50 border border-slate-700/50 text-slate-200 bubble-bot'
                                            }`}>

                                            {msg.content}

                                            {/* Process / Thought Indicator for active assistant messages */}
                                            {msg.role === 'assistant' && isLoading && msg.id === messages[messages.length - 1].id && (
                                                <div className={`flex items-center gap-3 ${msg.content ? 'mt-4 pt-4 border-t border-slate-700/50' : ''}`}>
                                                    <Loader2 className="animate-spin text-orange-500 flex-shrink-0" size={16} />
                                                    {activeThought && (
                                                        <div className="flex items-center gap-2 text-orange-400 font-mono text-[11px] uppercase tracking-wider animate-pulse bg-orange-500/10 px-3 py-1.5 rounded-lg border border-orange-500/20">
                                                            <span>{activeThought.icon}</span>
                                                            <span>{activeThought.text}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <span className="text-[10px] font-bold text-slate-600 uppercase mt-2 px-1">
                                            {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </div>
                                </div>
                            ))
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Area */}
                    <div className="p-6 bg-slate-900/50 border-t border-slate-800">
                        <form onSubmit={handleSend} className="relative">
                            <input
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                placeholder={selectedConnection ? "Transmit message..." : "Select an agent to begin..."}
                                disabled={!selectedConnection || isLoading}
                                className="w-full pl-6 pr-16 py-4 bg-black/40 border border-slate-700/50 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none transition-all text-white placeholder:text-slate-600 text-sm disabled:opacity-50"
                                id="chat-input"
                            />
                            <button
                                type="submit"
                                disabled={!selectedConnection || isLoading || !input.trim()}
                                className="absolute right-2 top-2 bottom-2 px-4 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl transition-all active:scale-95 flex items-center justify-center"
                                id="chat-send-btn"
                            >
                                {isLoading ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
                            </button>
                        </form>
                        <div className="mt-3 flex items-center justify-between text-[10px] font-bold text-slate-600 uppercase tracking-widest px-2">
                            <span>Satellite Uplink: Active</span>
                            <span className="flex items-center gap-2">
                                {selectedModel ? (
                                    <span className="text-violet-500/60">via OpenRouter · {selectedModelInfo?.name || selectedModel}</span>
                                ) : (
                                    <span>via OpenClaw Gateway</span>
                                )}
                            </span>
                        </div>
                    </div>
                </section>
            </div>

            <style jsx>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #334155;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #475569;
        }
        .bubble-user {
          border-top-right-radius: 4px;
        }
        .bubble-bot {
          border-top-left-radius: 4px;
        }
      `}</style>
        </div>
    );
}
