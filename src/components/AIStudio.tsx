import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronRight,
  Cloud,
  Cpu,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  ArrowUp,
  Square,
  X,
} from 'lucide-react';
import { useStore } from '../store';
import type { AiProvider, WorkspaceTab } from '../types';
import { Select } from './Select';
import { Modal } from './Modal';

const KINDS: {
  value: AiProvider['kind'];
  label: string;
  baseUrl: string;
  model: string;
  protocol: AiProvider['protocol'];
}[] = [
  {
    value: 'openai',
    label: 'OpenAI · Chat Completions',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    protocol: 'chat',
  },
  {
    value: 'openai',
    label: 'OpenAI · Responses API',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    protocol: 'responses',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek · Chat Completions',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    protocol: 'chat',
  },
  {
    value: 'anthropic',
    label: 'Anthropic · Messages',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-20250514',
    protocol: 'anthropic',
  },
  {
    value: 'custom',
    label: '自定义网关',
    baseUrl: 'https://your-gateway.example.com/v1',
    model: 'model-name',
    protocol: 'chat',
  },
];

const PROTOCOLS: { value: AiProvider['protocol']; label: string; endpoint: string; note: string }[] = [
  {
    value: 'chat',
    label: 'Chat Completions',
    endpoint: '/chat/completions',
    note: 'OpenAI、DeepSeek、Moonshot 等绝大多数兼容网关',
  },
  {
    value: 'responses',
    label: 'Responses API',
    endpoint: '/responses',
    note: 'OpenAI 原生 Responses 协议（支持 reasoning 输出）',
  },
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    endpoint: '/messages',
    note: 'Anthropic 原生 Messages 协议（x-api-key + anthropic-version）',
  },
];

function presetFor(kind: AiProvider['kind'], protocol: AiProvider['protocol']) {
  return KINDS.find((item) => item.value === kind && item.protocol === protocol) || KINDS[0];
}

function protocolLabel(protocol: string) {
  return PROTOCOLS.find((item) => item.value === protocol)?.label || 'Chat Completions';
}

/** Lightweight command input; streamed SQL is written directly to the editor. */
export function AIComposer({ tab, onClose }: { tab: WorkspaceTab; onClose: () => void }) {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [providerId, setProviderId] = useState(() => localStorage.getItem('finch.ai.provider') || '');
  const [prompt, setPrompt] = useState('');
  const [loadError, setLoadError] = useState('');
  const generateAiSql = useStore((state) => state.generateAiSql);
  const cancelAiSql = useStore((state) => state.cancelAiSql);
  const setModal = useStore((state) => state.setModal);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let disposed = false;
    window.finch.ai.listProviders().then((items) => {
      if (disposed) return;
      setProviders(items);
      setProviderId((id) => items.some((item) => item.id === id) ? id : items[0]?.id || '');
    }).catch((error) => { if (!disposed) setLoadError(String(error.message || error)); });
    inputRef.current?.focus();
    return () => { disposed = true; };
  }, []);

  const close = () => {
    if (tab.aiGenerating) cancelAiSql(tab.id);
    onClose();
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!providerId || !prompt.trim() || tab.aiGenerating) return;
    localStorage.setItem('finch.ai.provider', providerId);
    const ok = await generateAiSql(tab.id, prompt, providerId);
    if (ok && useStore.getState().activeTabId === tab.id) onClose();
  };
  const error = tab.aiError || loadError;
  return (
    <form className="ai-composer" onSubmit={submit} aria-label="AI SQL 输入"
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <div className="ai-composer-input">
        <Sparkles size={16} />
        <input ref={inputRef} value={prompt} onChange={(event) => setPrompt(event.target.value)}
          aria-label="用自然语言描述 SQL" placeholder="描述你想查询的数据，Enter 生成 SQL…"
          readOnly={tab.aiGenerating} autoComplete="off" />
        {tab.aiGenerating ? (
          <button key="stop" type="button" className="ai-composer-stop" onClick={(event) => { event.preventDefault(); cancelAiSql(tab.id); }} aria-label="停止生成">
            <Loader2 size={14} className="spin" /><Square size={10} />
          </button>
        ) : (
          <button key="submit" type="submit" className="ai-composer-submit" disabled={!providerId || !prompt.trim() || tab.running || tab.switchingConnection} aria-label="生成 SQL">
            <ArrowUp size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" onClick={close} aria-label="关闭 AI 输入"><X size={14} /></button>
      </div>
      <div className="ai-composer-meta">
        <span>{tab.aiGenerating ? '正在生成，SQL 将逐步写入编辑器…' : `${tab.database || '当前数据库'} · Enter 生成 · Esc 关闭`}</span>
        {providers.length > 1 ? <Select value={providerId} onChange={setProviderId} ariaLabel="AI 服务商" disabled={tab.aiGenerating}
          size="sm" width={160} options={providers.map((provider) => ({ value:provider.id, label:provider.name, hint:provider.model }))} />
          : providers[0] ? <span title={providers[0].model}>{providers[0].name}</span>
          : <button type="button" onClick={() => { setModal('settings'); onClose(); }}>配置 AI 服务商</button>}
      </div>
      {error && <div className="ai-composer-error" role="alert">{error}</div>}
    </form>
  );
}

export function AIProvidersPanel() {
  const askConfirm = useStore((store) => store.askConfirm);
  const toast = useStore((store) => store.toast);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [editing, setEditing] = useState<AiProvider | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AiProvider['kind']>('openai');
  const [protocol, setProtocol] = useState<AiProvider['protocol']>('chat');
  const [baseUrl, setBaseUrl] = useState(KINDS[0].baseUrl);
  const [model, setModel] = useState(KINDS[0].model);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = () => {
    window.finch.ai
      .listProviders()
      .then(setProviders)
      .catch((err) => toast('error', '读取 AI 服务商失败', err.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resetForm = (provider?: AiProvider) => {
    setEditing(provider || null);
    const preset = provider
      ? presetFor(provider.kind, provider.protocol)
      : KINDS[0];
    setName(provider?.name || preset.label);
    setKind(provider?.kind || 'openai');
    setProtocol(provider?.protocol || preset.protocol);
    setBaseUrl(provider?.baseUrl || preset.baseUrl);
    setModel(provider?.model || preset.model);
    setApiKey('');
    setShowKey(false);
    setOpen(true);
  };

  const save = async () => {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) return;
    setSaving(true);
    try {
      const saved = await window.finch.ai.saveProvider({
        provider: {
          id: editing?.id,
          name: name.trim(),
          kind,
          protocol,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
        },
        apiKey: apiKey.trim() || undefined,
      });
      setProviders((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved];
      });
      setOpen(false);
      toast('success', 'AI 服务商已保存', `${saved.name} · ${saved.model}`);
    } catch (err) {
      toast('error', '保存失败', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ai-providers">
      <div className="ai-providers-head">
        <div>
          <h3>AI 服务商</h3>
          <p>支持 Chat Completions、Responses API、Anthropic Messages 三种协议。密钥只写入 macOS Keychain。</p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => resetForm()}>
          <Plus size={13} /> 添加
        </button>
      </div>
      {loading ? (
        <div className="ai-provider-loading"><Loader2 size={16} className="spin" /> 读取中…</div>
      ) : providers.length === 0 ? (
        <div className="ai-empty">
          <span className="ai-empty-icon"><Cpu size={20} /></span>
          <div>
            <strong>还没有 AI 服务商</strong>
            <p>协议三选一：Chat Completions（OpenAI / DeepSeek / 兼容网关）、Responses API、Anthropic Messages。</p>
          </div>
        </div>
      ) : (
        <div className="ai-provider-list">
          {providers.map((provider) => (
            <button key={provider.id} className="ai-provider-card" onClick={() => resetForm(provider)}>
              <span className="ai-provider-icon"><Sparkles size={15} /></span>
              <span className="ai-provider-copy">
                <strong>{provider.name}</strong>
                <small>{protocolLabel(provider.protocol)} · {provider.model}</small>
              </span>
              <span className={provider.hasKey ? 'ai-key-ok' : 'ai-key-missing'}>
                {provider.hasKey ? 'Key 已保存' : '未配置 Key'}
              </span>
              <ChevronRight size={13} className="ai-provider-arrow" />
            </button>
          ))}
        </div>
      )}
      {open && (
        <Modal
          open
          onClose={() => setOpen(false)}
          title={editing ? '编辑 AI 服务商' : '添加 AI 服务商'}
          subtitle="模型只会收到当前数据库的 schema 和你的问题"
          icon={<Sparkles size={17} />}
          size="md"
          footer={
            <>
              {editing && (
                <button
                  className="btn btn-ghost btn-sm danger-text"
                  onClick={() =>
                    askConfirm({
                      title: '删除 AI 服务商',
                      message: `删除 “${editing.name}”？`,
                      detail: 'API Key 也会从钥匙串中移除。',
                      confirmLabel: '删除',
                      onConfirm: async () => {
                        await window.finch.ai.deleteProvider(editing.id);
                        setProviders((current) => current.filter((item) => item.id !== editing.id));
                        setOpen(false);
                      },
                    })
                  }
                >
                  <Trash2 size={13} /> 删除
                </button>
              )}
              <span className="modal-foot-spacer" />
              <button className="btn btn-ghost" onClick={() => setOpen(false)}>取消</button>
              <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim() || !model.trim()}>
                {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />} 保存
              </button>
            </>
          }
        >
          <div className="connection-form">
            <label className="field">
              <span>预设</span>
              <Select
                value={`${kind}:${protocol}`}
                onChange={(value) => {
                  const [nextKind, nextProtocol] = value.split(':') as [
                    AiProvider['kind'],
                    AiProvider['protocol'],
                  ];
                  const preset = presetFor(nextKind, nextProtocol);
                  setKind(nextKind);
                  setProtocol(nextProtocol);
                  setName(preset.label);
                  setBaseUrl(preset.baseUrl);
                  setModel(preset.model);
                }}
                ariaLabel="服务商预设"
                options={KINDS.map((item) => ({
                  value: `${item.value}:${item.protocol}`,
                  label: item.label,
                  hint: `${item.model} · ${PROTOCOLS.find((p) => p.value === item.protocol)?.endpoint}`,
                }))}
              />
            </label>
            <label className="field">
              <span>协议</span>
              <Select
                value={protocol}
                onChange={(value) => setProtocol(value as AiProvider['protocol'])}
                ariaLabel="协议"
                options={PROTOCOLS.map((item) => ({
                  value: item.value,
                  label: item.label,
                  hint: item.endpoint,
                }))}
              />
              <em className="field-hint">
                POST <code>{PROTOCOLS.find((item) => item.value === protocol)?.endpoint}</code>
                {' · '}
                {PROTOCOLS.find((item) => item.value === protocol)?.note}
              </em>
            </label>
            <label className="field">
              <span>显示名称</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：团队 OpenAI" />
            </label>
            <label className="field">
              <span>Base URL</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span>模型</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
            </label>
            <label className="field">
              <span>API Key {editing?.hasKey && <em>已保存 · 留空保持不变</em>}</span>
              <div className="input-with-action">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={editing?.hasKey ? '••••••••' : 'sk-…'}
                  spellCheck={false}
                />
                <button type="button" onClick={() => setShowKey((value) => !value)} aria-label="Toggle key">
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
