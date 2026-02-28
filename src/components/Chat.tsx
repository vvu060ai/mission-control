"use client";

import { useState, useEffect, useRef } from "react";
import { Send, User, Bot, Loader2, MessageSquare, Shield } from "lucide-react";
interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

interface Connection {
    url: string;
    token: string;
    deviceToken: string;
    agentId: string;
    port: string;
    status: 'connected' | 'error';
}

export default function Chat({ connections }: { connections: Connection[] }) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [selectedConnection, setSelectedConnection] = useState<Connection | null>(connections[0] || null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!selectedConnection && connections.length > 0) {
            setSelectedConnection(connections[0]);
        }

        // Load messages for the selected agent
        if (selectedConnection) {
            const saved = localStorage.getItem(`mission_control_msgs_${selectedConnection.url}`);
            if (saved) {
                try {
                    setMessages(JSON.parse(saved));
                } catch (e) {
                    console.error("Failed to load chat history", e);
                }
            } else {
                setMessages([]); // Clear if no history for this one
            }
        }
    }, [connections, selectedConnection]);

    // Persist messages whenever they change
    useEffect(() => {
        if (selectedConnection && messages.length > 0) {
            localStorage.setItem(`mission_control_msgs_${selectedConnection.url}`, JSON.stringify(messages));
        }
    }, [messages, selectedConnection]);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

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
                    // Only send the last 10 messages (5 exchanges) to keep context small and fast.
                    // The full history is kept in state/localStorage for display only.
                    messages: [...messages, userMessage].slice(-10)
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
                            }
                        } catch (e) { }
                    }
                }
            }
        };

        try {
            await executeChat();
        } catch (error: any) {
            console.error("Chat error:", error);
            setMessages((prev) =>
                prev.map((msg) =>
                    msg.id === assistantMsgId
                        ? { ...msg, content: `Error: ${error.message}` }
                        : msg
                )
            );
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col lg:flex-row h-[700px] gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Sidebar - Agent Selection */}
            <aside className="lg:w-72 flex flex-col gap-4">
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest px-2">Active Agents</h3>
                <div className="flex flex-col gap-2 overflow-y-auto pr-2 custom-scrollbar">
                    {connections.length === 0 ? (
                        <div className="p-4 rounded-2xl bg-slate-900/50 border border-slate-800 text-slate-500 text-xs text-center border-dashed">
                            No agents connected.
                        </div>
                    ) : (
                        connections.map((conn) => (
                            <button
                                key={conn.url}
                                onClick={() => setSelectedConnection(conn)}
                                className={`p-4 rounded-2xl border transition-all text-left flex items-center gap-3 group ${selectedConnection?.url === conn.url
                                    ? 'bg-orange-600/10 border-orange-500/50 text-white shadow-lg shadow-orange-950/10'
                                    : 'bg-slate-900/40 border-slate-800 text-slate-400 hover:border-slate-700 hover:bg-slate-900/60'
                                    }`}
                            >
                                <div className={`p-2 rounded-lg ${selectedConnection?.url === conn.url ? 'bg-orange-600 text-white' : 'bg-slate-800 text-slate-400 group-hover:text-white transition-colors'}`}>
                                    <Bot size={18} />
                                </div>
                                <div className="overflow-hidden">
                                    <p className="font-bold text-sm truncate uppercase tracking-tight">{conn.agentId}</p>
                                    <p className="text-[10px] opacity-60 font-mono truncate">{conn.url}</p>
                                </div>
                            </button>
                        ))
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
                            </div>
                        </div>
                    </div>
                    {selectedConnection && (
                        <div className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center gap-2 group cursor-help">
                            <Shield size={12} className="text-emerald-500" />
                            <span className="text-[10px] font-bold text-emerald-500/80 uppercase">Secured</span>
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
                                    <div className={`px-5 py-3 rounded-2xl text-sm leading-relaxed ${msg.role === 'user'
                                        ? 'bg-blue-600/10 border border-blue-500/30 text-white bubble-user'
                                        : 'bg-slate-800/50 border border-slate-700/50 text-slate-200 bubble-bot'
                                        }`}>
                                        {msg.content || (isLoading && <Loader2 className="animate-spin text-slate-500" size={18} />)}
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
                        />
                        <button
                            type="submit"
                            disabled={!selectedConnection || isLoading || !input.trim()}
                            className="absolute right-2 top-2 bottom-2 px-4 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-xl transition-all active:scale-95 flex items-center justify-center"
                        >
                            {isLoading ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
                        </button>
                    </form>
                    <div className="mt-3 flex items-center justify-between text-[10px] font-bold text-slate-600 uppercase tracking-widest px-2">
                        <span>Satellite Uplink: Active</span>
                        <span>Encryption: AES-256</span>
                    </div>
                </div>
            </section>

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
