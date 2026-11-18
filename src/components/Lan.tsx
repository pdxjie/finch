import { useEffect, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  Check,
  FileUp,
  FolderOpen,
  Loader2,
  MonitorSmartphone,
  Send,
  Unplug,
  Wifi,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import { formatNumber } from '../lib/format';
import { Modal } from './Modal';
import { Select } from './Select';
import { Switch } from './ui';

function useLan() {
  const lanStatus = useStore((state) => state.lanStatus);
  const refreshLan = useStore((state) => state.refreshLan);
  useEffect(() => {
    refreshLan();
    const timer = setInterval(() => {
      if (useStore.getState().lanStatus?.enabled) refreshLan();
    }, 2500);
    return () => clearInterval(timer);
  }, [refreshLan]);
  return lanStatus;
}

export function LanSettings() {
  const status = useLan();
  const connections = useStore((state) => state.connections);
  const sessions = useStore((state) => state.sessions);
  const databases = useStore((state) => state.databases);
  const connect = useStore((state) => state.connect);
  const loadDatabases = useStore((state) => state.loadDatabases);
  const startLan = useStore((state) => state.startLan);
  const stopLan = useStore((state) => state.stopLan);
  const setDeviceName = useStore((state) => state.setLanDeviceName);
  const connectPeer = useStore((state) => state.connectLanPeer);
  const toast = useStore((state) => state.toast);
  const lanSessions = useStore((state) => state.lanSessions);
  const setLanActiveSession = useStore((state) => state.setLanActiveSession);
  const appInfo = useStore((state) => state.appInfo);

  const candidates = useMemo(() => connections.filter((item) => item.category !== 'prod'), [connections]);
  const [name, setName] = useState(status?.deviceName || '');
  const [peer, setPeer] = useState<string>('');
  const [connectionId, setConnectionId] = useState(candidates[0]?.id || '');
  const [database, setDatabase] = useState(candidates[0]?.database || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(status?.deviceName || ''), [status?.deviceName]);
  const profile = candidates.find((item) => item.id === connectionId);
  useEffect(() => {
    if (profile?.database) setDatabase(profile.database);
    const load = async () => {
      if (!connectionId) return;
      if (useStore.getState().sessions[connectionId]?.status !== 'connected') {
        await connect(connectionId, { silent: true }).catch(() => null);
      }
      await loadDatabases(connectionId).catch(() => []);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId]);

  const request = async () => {
    if (!peer || !connectionId || !database) return;
    setBusy(true);
    const session = await connectPeer(peer, connectionId, database);
    setBusy(false);
    if (session) {
      setPeer('');
      setLanActiveSession(session.id);
      toast('success', '会话已建立', `${session.peerName} · ${session.peerConnection}`);
    }
  };

  const enabled = Boolean(status?.enabled);
  return (
    <div className="lan-settings">
      <div className="settings-section">
        <div className="settings-section-head">
          <h3>局域网传输</h3>
          <p>直接连接同一局域网内的 Finch，双向传表或传文件；密码永远不会离开本机。</p>
        </div>
        <div className="settings-row">
          <div><strong>启用局域网发现</strong><p>关闭后不会广播，也不会接受任何请求。</p></div>
          <Switch checked={enabled} onChange={(value) => (value ? startLan() : stopLan())} />
        </div>
        <div className="settings-row">
          <div><strong>设备名称</strong><p>对方在请求列表中看到的名字。</p></div>
          <input
            className="lan-name-input"
            value={name}
            maxLength={48}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => name.trim() && setDeviceName(name.trim())}
            placeholder="我的 MacBook"
          />
        </div>
        <div className="settings-row">
          <div><strong>状态</strong><p>已发现 {status?.peers.length ?? 0} 台设备 · 端口 {status?.port || '—'}</p></div>
          <span className={clsx('lan-status', enabled && 'is-on')}>
            {enabled ? <Wifi size={12} /> : <Unplug size={12} />}
            {enabled ? '可被发现' : '已关闭'}
          </span>
        </div>
      </div>

      {enabled && (
        <div className="settings-section">
          <div className="settings-section-head">
            <h3>附近的设备</h3>
            <p>选择对方，再选择你这次要使用的连接与数据库。</p>
          </div>
          {status?.peers.length === 0 ? (
            <div className="lan-radar">
              <span className="lan-radar-ring" />
              <span className="lan-radar-ring" />
              <span className="lan-radar-ring" />
              <div className="lan-radar-core">
                <Wifi size={16} />
              </div>
              <p>正在寻找附近设备…</p>
            </div>
          ) : (
            <div className="lan-peers">
              {status?.peers.map((item, index) => (
                <button
                  key={item.id}
                  className={clsx('lan-peer', peer === item.id && 'is-active')}
                  style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
                  onClick={() => setPeer(item.id)}
                >
                  <MonitorSmartphone size={15} />
                  <span>{item.name}</span>
                  <em>{item.address}</em>
                  {peer === item.id && <Check size={13} />}
                </button>
              ))}
            </div>
          )}

          {peer && (
            <div className="lan-request-form">
              <div className="settings-row">
                <div><strong>我的连接</strong><p>只允许非生产连接。</p></div>
                <Select
                  className="settings-select"
                  value={connectionId}
                  width={190}
                  onChange={setConnectionId}
                  options={candidates.map((item) => ({ value: item.id, label: item.name, hint: item.category }))}
                />
              </div>
              <div className="settings-row">
                <div><strong>数据库</strong><p>本次会话默认读写的库。</p></div>
                <Select
                  className="settings-select"
                  value={database}
                  width={190}
                  onChange={setDatabase}
                  options={(databases[connectionId] || []).map((item) => ({ value: item.name, label: item.name }))}
                />
              </div>
              <button className="btn btn-primary" onClick={request} disabled={busy || !database}>
                {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} 请求建立会话
              </button>
            </div>
          )}

          {lanSessions.length > 0 && (
            <div className="lan-sessions">
              <strong>当前会话</strong>
              {lanSessions.map((session) => (
                <button key={session.id} onClick={() => setLanActiveSession(session.id)}>
                  <MonitorSmartphone size={13} />
                  {session.peerName} · {session.peerConnection}
                  <span>{session.myDatabase} ↔ {session.peerDatabase}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="lan-hint">
        <FolderOpen size={13} />
        接收的文件默认保存到 <code>{appInfo?.dataDir}/LanDownloads</code>；表数据只写入你选择的非生产连接。
      </div>
    </div>
  );
}

export function LanIncomingDialog() {
  const request = useStore((state) => state.lanRequest);
  const connections = useStore((state) => state.connections);
  const databases = useStore((state) => state.databases);
  const sessions = useStore((state) => state.sessions);
  const connect = useStore((state) => state.connect);
  const loadDatabases = useStore((state) => state.loadDatabases);
  const respond = useStore((state) => state.respondLan);
  const dismiss = useStore((state) => state.dismissLanRequest);
  const appInfo = useStore((state) => state.appInfo);

  const candidates = useMemo(() => connections.filter((item) => item.category !== 'prod'), [connections]);
  const [connectionId, setConnectionId] = useState(candidates[0]?.id || '');
  const [database, setDatabase] = useState(candidates[0]?.database || '');
  const [downloadDir, setDownloadDir] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!request) return;
    const first = candidates[0];
    setConnectionId(first?.id || '');
    setDatabase(first?.database || '');
    setDownloadDir(appInfo?.dataDir ? `${appInfo.dataDir}/LanDownloads` : '');
    if (first) {
      const load = async () => {
        if (sessions[first.id]?.status !== 'connected') await connect(first.id, { silent: true }).catch(() => null);
        await loadDatabases(first.id).catch(() => []);
      };
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  if (!request) return null;

  const pickDir = async () => {
    const path = await openDialog({ title: '选择接收目录', directory: true, multiple: false });
    if (typeof path === 'string') setDownloadDir(path);
  };

  const accept = async () => {
    if (!connectionId || !database) return;
    setBusy(true);
    if (sessions[connectionId]?.status !== 'connected') await connect(connectionId, { silent: true }).catch(() => null);
    const ok = await respond({ requestId: request.id, accept: true, connectionId, database, downloadDir });
    setBusy(false);
    if (ok) {
      window.setTimeout(() => {
        const latest = useStore.getState().lanSessions.at(-1);
        if (latest) useStore.getState().setLanActiveSession(latest.id);
      }, 350);
    }
  };

  return (
    <Modal
      open
      onClose={dismiss}
      title="局域网传输请求"
      subtitle={`${request.peerName} 请求建立传输会话`}
      icon={<Wifi size={17} />}
      size="sm"
      footer={
        <>
          <span className="modal-foot-hint">双方仅共享本次选中的连接</span>
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={dismiss} disabled={busy}>拒绝</button>
          <button className="btn btn-primary" onClick={accept} disabled={busy || !database}>
            {busy ? <Loader2 size={13} className="spin" /> : <Check size={13} />} 接受
          </button>
        </>
      }
    >
      <div className="lan-accept">
        <div className="lan-accept-peer">
          <MonitorSmartphone size={18} />
          <div>
            <strong>{request.peerName}</strong>
            <span>对方使用连接：{request.connectionName} · {request.database}</span>
          </div>
        </div>
        <div className="settings-row">
          <div><strong>我的连接</strong><p>生产连接不会出现在这里。</p></div>
          <Select
            className="settings-select"
            value={connectionId}
            width={190}
            onChange={(value) => {
              setConnectionId(value);
              const profile = candidates.find((item) => item.id === value);
              if (profile?.database) setDatabase(profile.database);
            }}
            options={candidates.map((item) => ({ value: item.id, label: item.name, hint: item.category }))}
          />
        </div>
        <div className="settings-row">
          <div><strong>目标数据库</strong><p>表数据将写入这个库。</p></div>
          <Select
            className="settings-select"
            value={database}
            width={190}
            onChange={setDatabase}
            options={(databases[connectionId] || []).map((item) => ({ value: item.name, label: item.name }))}
          />
        </div>
        <div className="settings-row">
          <div><strong>文件接收目录</strong><p>对方发来的普通文件会保存在这里。</p></div>
          <div className="lan-dir">
            <code>{downloadDir || '未选择'}</code>
            <button className="btn btn-ghost btn-sm" onClick={pickDir}>选择</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function LanSessionDialog() {
  const sessionId = useStore((state) => state.lanActiveSessionId);
  const sessions = useStore((state) => state.lanSessions);
  const session = sessions.find((item) => item.id === sessionId);
  const tablesMap = useStore((state) => state.tables);
  const loadTables = useStore((state) => state.loadTables);
  const sendFile = useStore((state) => state.sendLanFile);
  const sendTables = useStore((state) => state.sendLanTables);
  const disconnect = useStore((state) => state.disconnectLan);
  const setActive = useStore((state) => state.setLanActiveSession);
  const progress = useStore((state) => (sessionId ? state.lanProgress[sessionId] : undefined));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [structure, setStructure] = useState(true);
  const [data, setData] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!session) return;
    setSelected(new Set());
    const load = async () => {
      if (useStore.getState().sessions[session.myConnectionId]?.status !== 'connected') {
        await useStore.getState().connect(session.myConnectionId, { silent: true }).catch(() => null);
      }
      await loadTables(session.myConnectionId, session.myDatabase).catch(() => []);
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  if (!session) return null;
  const tables = tablesMap[`${session.myConnectionId}::${session.myDatabase}`] || [];

  const pickFile = async () => {
    const path = await openDialog({ title: '选择要发送的文件', multiple: false, directory: false });
    if (typeof path === 'string') await sendFile(session.id, path);
  };

  const toggle = (name: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const send = async () => {
    if (!selected.size) return;
    setSending(true);
    await sendTables(session.id, [...selected], structure, data);
    setSending(false);
    setSelected(new Set());
  };

  const percent = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0;

  return (
    <Modal
      open
      onClose={() => setActive(null)}
      title="局域网会话"
      subtitle={`${session.peerName} · 双向传输`}
      icon={<Wifi size={17} />}
      size="lg"
      footer={
        <>
          <button className="btn btn-ghost btn-sm" onClick={() => disconnect(session.id)}>
            <Unplug size={13} /> 断开
          </button>
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={() => setActive(null)}>关闭</button>
        </>
      }
    >
      <div className="lan-session">
        <div className="lan-link">
          <div className="lan-link-node">
            <MonitorSmartphone size={15} />
            <span>我的连接</span>
            <strong>{session.myDatabase}</strong>
          </div>
          <div className="lan-link-track">
            <i />
            <i />
            <i />
            <span className="lan-link-arrow">⇄</span>
          </div>
          <div className="lan-link-node">
            <MonitorSmartphone size={15} />
            <span>对方连接</span>
            <strong>{session.peerConnection}</strong>
          </div>
        </div>
        <div className="lan-session-meta">
          <div><span>我的连接</span><strong>{session.myDatabase}</strong></div>
          <div><span>对方连接</span><strong>{session.peerConnection} · {session.peerDatabase}</strong></div>
          <div><span>接收目录</span><strong>{session.downloadDir || '默认目录'}</strong></div>
        </div>

        <div className="lan-send-row">
          <button className="btn btn-primary" onClick={pickFile}>
            <FileUp size={13} /> 发送文件
          </button>
          <span>不限制大小，直接流式传输</span>
        </div>

        {progress && (
          <div className={clsx('lan-progress', progress.kind === 'done' && 'is-done', progress.kind === 'error' && 'is-error')}>
            <div>
              <span>
                {progress.kind === 'done' ? <Check size={11} /> : progress.kind === 'error' ? <X size={11} /> : null}
                {progress.kind === 'done' ? '已完成' : progress.kind === 'error' ? '传输失败' : progress.kind === 'table' ? '表传输' : '传输中'} · {progress.name}
              </span>
              <strong>{progress.total ? `${percent}%` : formatNumber(progress.done)}</strong>
            </div>
            <div className="lan-progress-bar"><span style={{ width: `${progress.total ? percent : 100}%` }} /></div>
          </div>
        )}

        <div className="lan-table-picker">
          <div className="lan-table-head">
            <strong>发送表</strong>
            <span>已选 {selected.size} 张</span>
            <span className="lan-spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set(tables.map((item) => item.name)))}>全选</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>清空</button>
          </div>
          <div className="lan-table-list">
            {tables.length === 0 && <div className="lan-empty"><Loader2 size={13} className="spin" /> 读取表…</div>}
            {tables.map((table) => (
              <button
                key={table.name}
                className={clsx('lan-table', selected.has(table.name) && 'is-checked')}
                onClick={() => toggle(table.name)}
              >
                <span className={clsx('grid-check', selected.has(table.name) && 'is-checked')}>
                  {selected.has(table.name) && <Check size={9} />}
                </span>
                {table.name}
              </button>
            ))}
          </div>
          <div className="lan-table-foot">
            <label className="sync-option sync-switch"><span>结构</span><Switch checked={structure} onChange={setStructure} /></label>
            <label className="sync-option sync-switch"><span>数据</span><Switch checked={data} onChange={setData} /></label>
            <span className="lan-spacer" />
            <button className="btn btn-primary btn-sm" onClick={send} disabled={sending || !selected.size || (!structure && !data)}>
              {sending ? <Loader2 size={12} className="spin" /> : <Send size={12} />} 发送所选表
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
