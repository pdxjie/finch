import { useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  Lock,
  Network,
  Plug,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { ConnectionProfile } from '../types';
import { Select } from './Select';
import { Modal } from './Modal';
import { Segmented, Switch } from './ui';

type Draft = {
  name: string;
  group: string;
  category: 'local' | 'dev' | 'staging' | 'prod';
  color: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: 'disabled' | 'required' | 'verify';
  sslCaPath: string;
  sslCertPath: string;
  sslKeyPath: string;
  sslKeyPassphrase: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshAuth: 'password' | 'key';
  sshPassword: string;
  sshKeyPath: string;
  sshPassphrase: string;
  keepAliveSeconds: number;
  autoReconnect: boolean;
  readOnly: boolean;
  connectTimeout: number;
};

const COLORS = ['#5B7CFA', '#2BB673', '#F2994A', '#E45C7A', '#8B5CF6', '#0EA5E9', '#D4A017', '#71717A'];

function initialDraft(profile: ConnectionProfile | null): Draft {
  return {
    name: profile?.name || '',
    group: profile?.group || 'Local',
    category: profile?.category || 'local',
    color: profile?.color || COLORS[0],
    host: profile?.host || '127.0.0.1',
    port: profile?.port || 3306,
    user: profile?.user || 'root',
    password: '',
    database: profile?.database || '',
    sslMode: profile?.sslMode || 'disabled',
    sslCaPath: profile?.sslCaPath || '',
    sslCertPath: profile?.sslCertPath || '',
    sslKeyPath: profile?.sslKeyPath || '',
    sslKeyPassphrase: '',
    sshEnabled: profile?.sshEnabled || false,
    sshHost: profile?.sshHost || '',
    sshPort: profile?.sshPort || 22,
    sshUser: profile?.sshUser || '',
    sshAuth: profile?.sshAuth || 'password',
    sshPassword: '',
    sshKeyPath: profile?.sshKeyPath || '',
    sshPassphrase: '',
    keepAliveSeconds: profile?.keepAliveSeconds || 30,
    autoReconnect: profile?.autoReconnect !== false,
    readOnly: profile?.readOnly || false,
    connectTimeout: profile?.connectTimeout || 10000,
  };
}

type Tab = 'general' | 'ssh' | 'ssl' | 'advanced';

export function ConnectionModal() {
  const editing = useStore((state) => state.editingConnection);
  const setModal = useStore((state) => state.setModal);
  const saveConnection = useStore((state) => state.saveConnection);
  const connect = useStore((state) => state.connect);
  const deleteConnection = useStore((state) => state.deleteConnection);
  const askConfirm = useStore((state) => state.askConfirm);
  const toast = useStore((state) => state.toast);
  const [tab, setTab] = useState<Tab>('general');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(editing));
  const [showPassword, setShowPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<
    | { state: 'idle' }
    | { state: 'success'; latency: number; version: string; charset: string }
    | { state: 'error'; message: string }
  >({ state: 'idle' });

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const payload = () => {
    const body: Partial<ConnectionProfile> = {
      ...(editing ? { id: editing.id } : {}),
      name: draft.name.trim() || `${draft.user}@${draft.host}`,
      group: draft.group.trim() || 'Local',
      category: draft.category,
      color: draft.color,
      host: draft.host.trim(),
      port: Number(draft.port) || 3306,
      user: draft.user.trim(),
      database: draft.database.trim(),
      sslMode: draft.sslMode,
      sslCaPath: draft.sslCaPath.trim(),
      sslCertPath: draft.sslCertPath.trim(),
      sslKeyPath: draft.sslKeyPath.trim(),
      sshEnabled: draft.sshEnabled,
      sshHost: draft.sshHost.trim(),
      sshPort: Number(draft.sshPort) || 22,
      sshUser: draft.sshUser.trim(),
      sshAuth: draft.sshAuth,
      sshKeyPath: draft.sshKeyPath.trim(),
      keepAliveSeconds: Number(draft.keepAliveSeconds) || 30,
      autoReconnect: draft.autoReconnect,
      readOnly: draft.readOnly,
      connectTimeout: Number(draft.connectTimeout) || 10000,
    };
    if (draft.password) body.password = draft.password;
    if (draft.sshPassword) body.sshPassword = draft.sshPassword;
    if (draft.sshPassphrase) body.sshPassphrase = draft.sshPassphrase;
    if (draft.sslKeyPassphrase) body.sslKeyPassphrase = draft.sslKeyPassphrase;
    return body;
  };

  const validate = () => {
    if (!draft.host.trim()) return '主机地址不能为空';
    if (!draft.user.trim()) return '用户名不能为空';
    if (!draft.port || draft.port < 1 || draft.port > 65535) return '端口必须在 1–65535 之间';
    if (draft.sshEnabled && (!draft.sshHost.trim() || !draft.sshUser.trim())) return 'SSH 主机与用户名不能为空';
    return null;
  };

  const runTest = async () => {
    const problem = validate();
    if (problem) {
      setTest({ state: 'error', message: problem });
      return;
    }
    setTesting(true);
    setTest({ state: 'idle' });
    try {
      const result = await window.finch.connections.test(payload());
      setTest({ state: 'success', ...result });
    } catch (error) {
      setTest({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const save = async (andConnect: boolean) => {
    const problem = validate();
    if (problem) {
      setTest({ state: 'error', message: problem });
      setTab('general');
      return;
    }
    setSaving(true);
    try {
      const saved = await saveConnection(payload());
      setModal(null);
      toast('success', editing ? '连接已更新' : '连接已创建', saved.name);
      if (andConnect) await connect(saved.id);
    } catch (error) {
      toast('error', '保存失败', error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const pickFile = async (field: 'sshKeyPath' | 'sslCaPath' | 'sslCertPath' | 'sslKeyPath', title: string) => {
    const result = await window.finch.app.pickFile({ title });
    if (result.picked && result.filePath) update(field, result.filePath);
  };

  return (
    <Modal
      open
      onClose={() => setModal(null)}
      title={editing ? '编辑连接' : '新建 MySQL 连接'}
      subtitle={editing ? `${editing.user}@${editing.host}:${editing.port}` : '凭据使用 macOS 钥匙串加密，只保存在这台 Mac 上'}
      icon={<span className="connection-modal-icon" style={{ background: `${draft.color}1f`, color: draft.color }}><Database size={18} /></span>}
      size="lg"
      className="connection-modal"
      footer={
        <>
          {editing ? (
            <button
              className="btn btn-ghost btn-sm danger-text"
              onClick={() =>
                askConfirm({
                  title: '删除连接',
                  message: `删除 “${editing.name}”？`,
                  detail: '保存的密码也会从 macOS Keychain 中移除。',
                  confirmLabel: '删除连接',
                  onConfirm: async () => {
                    await deleteConnection(editing.id);
                    setModal(null);
                  },
                })
              }
            >
              <Trash2 size={13} /> 删除
            </button>
          ) : (
            <span className="modal-foot-hint"><Lock size={11} /> Keychain encrypted</span>
          )}
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={runTest} disabled={testing}>
            {testing ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} 测试连接
          </button>
          <button className="btn btn-ghost" onClick={() => save(false)} disabled={saving}>保存</button>
          <button className="btn btn-primary" onClick={() => save(true)} disabled={saving}>
            {saving ? <Loader2 size={13} className="spin" /> : <ChevronRight size={14} />} 保存并连接
          </button>
        </>
      }
    >
      <div className="connection-tabs">
        {[
          { id: 'general', label: '基本', icon: Server },
          { id: 'ssh', label: 'SSH 隧道', icon: Network },
          { id: 'ssl', label: 'SSL / TLS', icon: ShieldCheck },
          { id: 'advanced', label: '高级', icon: KeyRound },
        ].map((item) => (
          <button key={item.id} className={clsx('connection-tab', tab === item.id && 'is-active')} onClick={() => setTab(item.id as Tab)}>
            <item.icon size={13} />
            {item.label}
            {item.id === 'ssh' && draft.sshEnabled && <span className="tab-dot" />}
            {item.id === 'ssl' && draft.sslMode !== 'disabled' && <span className="tab-dot" />}
          </button>
        ))}
      </div>

      {tab === 'general' && (
        <div className="connection-form">
          <div className="form-row">
            <label className="field field-grow">
              <span>连接名称</span>
              <input value={draft.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：Production / 本地开发" autoFocus />
            </label>
            <label className="field field-env">
              <span>环境分类</span>
              <Select
                value={draft.category}
                onChange={(value) => update('category', value as Draft['category'])}
                width={112}
                ariaLabel="环境分类"
                options={[
                  { value: 'local', label: '本地' },
                  { value: 'dev', label: '开发' },
                  { value: 'staging', label: '预发' },
                  { value: 'prod', label: '生产' },
                ]}
              />
            </label>
          </div>

          <div className="field">
            <span>标记颜色</span>
            <div className="color-swatches">
              {COLORS.map((color) => (
                <button
                  key={color}
                  className={clsx('color-swatch', draft.color === color && 'is-active')}
                  style={{ background: color }}
                  onClick={() => update('color', color)}
                  aria-label={color}
                >
                  {draft.color === color && <Check size={11} strokeWidth={3} />}
                </button>
              ))}
            </div>
          </div>

          <div className="form-row">
            <label className="field field-grow">
              <span>主机</span>
              <input value={draft.host} onChange={(event) => update('host', event.target.value)} placeholder="127.0.0.1" spellCheck={false} />
            </label>
            <label className="field field-port">
              <span>端口</span>
              <input type="number" value={draft.port} onChange={(event) => update('port', Number(event.target.value))} />
            </label>
          </div>

          <div className="form-row">
            <label className="field">
              <span>用户名</span>
              <input value={draft.user} onChange={(event) => update('user', event.target.value)} placeholder="root" spellCheck={false} />
            </label>
            <label className="field field-grow">
              <span>密码 {editing?.hasPassword && <em>已保存 · 留空保持不变</em>}</span>
              <div className="input-with-action">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={draft.password}
                  onChange={(event) => update('password', event.target.value)}
                  placeholder={editing?.hasPassword ? '••••••••' : '可选'}
                  spellCheck={false}
                />
                <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label="Toggle password">
                  {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </label>
          </div>

          <label className="field">
            <span>默认数据库 <em>可选</em></span>
            <input value={draft.database} onChange={(event) => update('database', event.target.value)} placeholder="连接后自动展开的数据库" spellCheck={false} />
          </label>

          <div className="connection-preview">
            <span className="preview-dot" style={{ background: draft.color }} />
            <span className="preview-pill">mysql://{draft.user || 'user'}@{draft.host || 'host'}:{draft.port}/{draft.database || '—'}</span>
            {draft.sshEnabled && <span className="preview-tag"><Network size={10} /> SSH</span>}
            {draft.sslMode !== 'disabled' && <span className="preview-tag"><ShieldCheck size={10} /> TLS</span>}
            {draft.readOnly && <span className="preview-tag"><Lock size={10} /> Read-only</span>}
          </div>

          {test.state !== 'idle' && (
            <div className={clsx('test-result', test.state === 'success' ? 'is-success' : 'is-error')}>
              {test.state === 'success' ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              {test.state === 'success' ? (
                <span>
                  连接成功 · MySQL {test.version} · {test.latency} ms · {test.charset}
                </span>
              ) : (
                <span>{test.message}</span>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'ssh' && (
        <div className="connection-form">
          <div className="form-toggle">
            <div>
              <strong>通过 SSH 隧道连接</strong>
              <p>MySQL 端口无需暴露公网，Finch 会建立本地转发。</p>
            </div>
            <Switch checked={draft.sshEnabled} onChange={(value) => update('sshEnabled', value)} />
          </div>
          {draft.sshEnabled && (
            <>
              <div className="form-row">
                <label className="field field-grow">
                  <span>SSH 主机</span>
                  <input value={draft.sshHost} onChange={(event) => update('sshHost', event.target.value)} placeholder="bastion.example.com" spellCheck={false} />
                </label>
                <label className="field field-port">
                  <span>端口</span>
                  <input type="number" value={draft.sshPort} onChange={(event) => update('sshPort', Number(event.target.value))} />
                </label>
              </div>
              <div className="form-row">
                <label className="field">
                  <span>SSH 用户名</span>
                  <input value={draft.sshUser} onChange={(event) => update('sshUser', event.target.value)} placeholder="ec2-user" spellCheck={false} />
                </label>
                <label className="field field-grow">
                  <span>认证方式</span>
                  <Segmented
                    value="key"
                    options={[{ value: 'key', label: '私钥' }]}
                    onChange={(value) => update('sshAuth', value)}
                  />
                </label>
              </div>
              {false ? null : (
                <>
                  <label className="field">
                    <span>私钥文件</span>
                    <div className="input-with-file">
                      <input value={draft.sshKeyPath} onChange={(event) => update('sshKeyPath', event.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} />
                      <button type="button" onClick={() => pickFile('sshKeyPath', '选择 SSH 私钥')}><FolderOpen size={13} /></button>
                    </div>
                  </label>
                  <label className="field">
                    <span>私钥口令 <em>可选</em></span>
                    <input type="password" value={draft.sshPassphrase} onChange={(event) => update('sshPassphrase', event.target.value)} placeholder="如果私钥有 passphrase" />
                  </label>
                </>
              )}
              <div className="form-note">
                <Network size={13} />
                DB 主机 <code>{draft.host}:{draft.port}</code> 将从 SSH 服务器视角解析。当前 Tauri 版本使用私钥认证。
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'ssl' && (
        <div className="connection-form">
          <label className="field">
            <span>加密模式</span>
            <Segmented
              value={draft.sslMode}
              options={[
                { value: 'disabled', label: '关闭' },
                { value: 'required', label: '加密' },
                { value: 'verify', label: '加密并校验' },
              ]}
              onChange={(value) => update('sslMode', value)}
            />
          </label>
          {draft.sslMode === 'disabled' ? (
            <div className="form-note">
              <ShieldCheck size={13} />
              连接未启用 TLS。跨网络访问时建议开启加密，尤其是公有云数据库。
            </div>
          ) : (
            <>
              <div className="form-note">
                <ShieldCheck size={13} />
                {draft.sslMode === 'verify'
                  ? 'Finch 会验证服务器证书与主机名，建议同时提供 CA。'
                  : '流量会被加密，但不会校验证书链。'}
              </div>
              <label className="field">
                <span>CA 证书 <em>可选</em></span>
                <div className="input-with-file">
                  <input value={draft.sslCaPath} onChange={(event) => update('sslCaPath', event.target.value)} placeholder="/path/to/ca.pem" spellCheck={false} />
                  <button type="button" onClick={() => pickFile('sslCaPath', '选择 CA 证书')}><FolderOpen size={13} /></button>
                </div>
              </label>
              <div className="form-row">
                <label className="field field-grow">
                  <span>客户端证书 <em>可选</em></span>
                  <div className="input-with-file">
                    <input value={draft.sslCertPath} onChange={(event) => update('sslCertPath', event.target.value)} placeholder="/path/to/client-cert.pem" spellCheck={false} />
                    <button type="button" onClick={() => pickFile('sslCertPath', '选择客户端证书')}><FolderOpen size={13} /></button>
                  </div>
                </label>
                <label className="field field-grow">
                  <span>客户端私钥 <em>可选</em></span>
                  <div className="input-with-file">
                    <input value={draft.sslKeyPath} onChange={(event) => update('sslKeyPath', event.target.value)} placeholder="/path/to/client-key.pem" spellCheck={false} />
                    <button type="button" onClick={() => pickFile('sslKeyPath', '选择客户端私钥')}><FolderOpen size={13} /></button>
                  </div>
                </label>
              </div>
              <label className="field">
                <span>私钥口令 <em>可选</em></span>
                <input type="password" value={draft.sslKeyPassphrase} onChange={(event) => update('sslKeyPassphrase', event.target.value)} placeholder="如果客户端私钥有口令" />
              </label>
            </>
          )}
        </div>
      )}

      {tab === 'advanced' && (
        <div className="connection-form">
          <div className="advanced-grid">
            <div className="advanced-card">
              <span className="advanced-icon"><Server size={15} /></span>
              <div>
                <strong>Keep-alive 心跳</strong>
                <p>定期 ping，避免云数据库或防火墙掐断空闲连接。</p>
                <label className="inline-field">
                  <input
                    type="number"
                    min={10}
                    max={300}
                    value={draft.keepAliveSeconds}
                    onChange={(event) => update('keepAliveSeconds', Number(event.target.value))}
                  />
                  <span>秒</span>
                </label>
              </div>
            </div>
            <div className="advanced-card">
              <span className="advanced-icon"><RefreshCwIcon /></span>
              <div>
                <strong>自动重连</strong>
                <p>连接断开后立即尝试恢复，并保留查询标签页。</p>
                <Switch checked={draft.autoReconnect} onChange={(value) => update('autoReconnect', value)} />
              </div>
            </div>
            <div className="advanced-card">
              <span className="advanced-icon"><Lock size={15} /></span>
              <div>
                <strong>只读模式</strong>
                <p>阻止 INSERT / UPDATE / DELETE / DDL，适合生产排查。</p>
                <Switch checked={draft.readOnly} onChange={(value) => update('readOnly', value)} />
              </div>
            </div>
            <div className="advanced-card">
              <span className="advanced-icon"><Network size={15} /></span>
              <div>
                <strong>连接超时</strong>
                <p>建立 TCP + 认证的最长等待时间。</p>
                <label className="inline-field">
                  <input
                    type="number"
                    min={1500}
                    max={60000}
                    step={500}
                    value={draft.connectTimeout}
                    onChange={(event) => update('connectTimeout', Number(event.target.value))}
                  />
                  <span>ms</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RefreshCwIcon() {
  return <Database size={15} />;
}
