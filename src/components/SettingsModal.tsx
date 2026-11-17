import { useState } from 'react';
import {
  BookMarked,
  Check,
  Copy,
  Database,
  FileCode2,
  FolderOpen,
  HardDrive,
  Info,
  Keyboard,
  Lock,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Type,
  Zap,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useStore } from '../store';
import type { AppSettings } from '../types';
import type { ThemeMode } from '../types';
import { splitSqlPreview } from '../lib/format';
import { Select } from './Select';

const UI_FONTS = [
  { label: '系统', value: '' },
  { label: '苹方', value: 'PingFang SC' },
  { label: 'Helvetica', value: 'Helvetica Neue' },
  { label: '宋体', value: 'Songti SC' },
  { label: '圆体', value: 'Yuanti SC' },
];

const MONO_FONTS = [
  { label: '系统', value: '' },
  { label: 'Menlo', value: 'Menlo' },
  { label: 'Monaco', value: 'Monaco' },
  { label: 'JetBrains', value: 'JetBrains Mono' },
  { label: 'Fira Code', value: 'Fira Code' },
];

const ACCENTS = ['#5068f0', '#2563eb', '#0d9488', '#16a34a', '#ea580c', '#e11d48', '#7c3aed', '#475569'];
import { Modal } from './Modal';
import { Kbd, Segmented, Switch } from './ui';
import { Logo } from './Logo';
import { AIProvidersPanel } from './AIStudio';

export function SettingsModal() {
  const setModal = useStore((state) => state.setModal);
  const settings = useStore((state) => state.settings);
  const updateSettings = useStore((state) => state.updateSettings);
  const themeResolved = useStore((state) => state.themeResolved);
  const appInfo = useStore((state) => state.appInfo);
  const history = useStore((state) => state.history);
  const clearHistory = useStore((state) => state.clearHistory);
  const askConfirm = useStore((state) => state.askConfirm);
  const toast = useStore((state) => state.toast);
  const [section, setSection] = useState<'appearance' | 'query' | 'ai' | 'data' | 'about'>('appearance');

  return (
    <Modal
      open
      onClose={() => setModal(null)}
      title="设置"
      subtitle="所有设置自动保存，只作用于这台 Mac"
      icon={<SlidersHorizontal size={17} />}
      size="xl"
      className="settings-modal"
      footer={
        <>
          <span className="modal-foot-hint"><Lock size={11} /> 本地优先 · 无账号 · 无遥测</span>
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={() => setModal('shortcuts')}>
            <Keyboard size={13} /> 快捷键
          </button>
          <button className="btn btn-primary" onClick={() => setModal(null)}>完成</button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav">
          {[
            { id: 'appearance', label: '外观', icon: Palette },
            { id: 'query', label: '查询与结果', icon: FileCode2 },
            { id: 'ai', label: 'AI 服务商', icon: Sparkles },
            { id: 'data', label: '数据与隐私', icon: HardDrive },
            { id: 'about', label: '关于 Finch', icon: Info },
          ].map((item) => (
            <button key={item.id} className={clsx('settings-nav-item', section === item.id && 'is-active')} onClick={() => setSection(item.id as typeof section)}>
              <item.icon size={14} />
              {item.label}
            </button>
          ))}
          <div className="settings-nav-spacer" />
          <div className="settings-version">
            <Logo size={24} />
            <div><strong>Finch {appInfo?.version || '0.2.0'}</strong><span>MySQL Workbench</span></div>
          </div>
        </nav>

        <div className="settings-body">
          {section === 'appearance' && (
            <>
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>主题</h3>
                  <p>跟随系统，或在任何光线下都保持舒适。</p>
                </div>
                <div className="theme-grid">
                  {[
                    { id: 'light', label: '浅色', icon: Sun, preview: 'light' },
                    { id: 'dark', label: '深色', icon: Moon, preview: 'dark' },
                    { id: 'system', label: '跟随系统', icon: Monitor, preview: themeResolved },
                  ].map((item) => (
                    <button
                      key={item.id}
                      className={clsx('theme-card', settings.theme === item.id && 'is-active')}
                      onClick={() => updateSettings({ theme: item.id as ThemeMode })}
                    >
                      <span className={clsx('theme-preview', `preview-${item.preview}`)}>
                        <span className="theme-preview-rail" />
                        <span className="theme-preview-side" />
                        <span className="theme-preview-main"><i /><i /><i /></span>
                      </span>
                      <span className="theme-label"><item.icon size={13} /> {item.label} {settings.theme === item.id && <Check size={11} />}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>字体与颜色</h3>
                  <p>所有改动即时生效，保存在本机。</p>
                </div>
                <div className="settings-row">
                  <div><strong>界面字体</strong><p>侧栏、按钮、表格等 UI 文本；留空使用系统字体。</p></div>
                  <div className="font-field">
                    <input
                      value={settings.uiFont}
                      placeholder="系统默认（SF Pro）"
                      spellCheck={false}
                      onChange={(event) => updateSettings({ uiFont: event.target.value })}
                    />
                    <div className="font-presets">
                      {UI_FONTS.map((font) => (
                        <button
                          key={font.label}
                          className={clsx(settings.uiFont === font.value && 'is-active')}
                          onClick={() => updateSettings({ uiFont: font.value })}
                        >
                          {font.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="settings-row">
                  <div><strong>代码字体</strong><p>SQL 编辑器、DDL 与结果网格里的代码。</p></div>
                  <div className="font-field">
                    <input
                      value={settings.monoFont}
                      placeholder="系统默认（SF Mono）"
                      spellCheck={false}
                      onChange={(event) => updateSettings({ monoFont: event.target.value })}
                    />
                    <div className="font-presets">
                      {MONO_FONTS.map((font) => (
                        <button
                          key={font.label}
                          className={clsx(settings.monoFont === font.value && 'is-active')}
                          onClick={() => updateSettings({ monoFont: font.value })}
                        >
                          {font.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="settings-row">
                  <div><strong>界面字号</strong><p>整体文字大小，会同时按比例缩放布局。</p></div>
                  <div className="stepper">
                    <button onClick={() => updateSettings({ uiFontSize: Math.max(11, settings.uiFontSize - 1) })}>−</button>
                    <span>{settings.uiFontSize} px</span>
                    <button onClick={() => updateSettings({ uiFontSize: Math.min(17, settings.uiFontSize + 1) })}>+</button>
                  </div>
                </div>
                <div className="settings-row">
                  <div><strong>主题色</strong><p>按钮、选中态、焦点环等强调色。</p></div>
                  <div className="accent-field">
                    <div className="accent-swatches">
                      {ACCENTS.map((color) => (
                        <button
                          key={color}
                          className={clsx('accent-swatch', settings.accentColor.toLowerCase() === color && 'is-active')}
                          style={{ background: color }}
                          title={color}
                          onClick={() => updateSettings({ accentColor: color })}
                        />
                      ))}
                    </div>
                    <label className="accent-custom" title="自定义颜色">
                      <input
                        type="color"
                        value={settings.accentColor}
                        onChange={(event) => updateSettings({ accentColor: event.target.value })}
                      />
                      <span>{settings.accentColor.toUpperCase()}</span>
                    </label>
                  </div>
                </div>
                <div className="settings-row">
                  <div><strong>动画效果</strong><p>柔和模式缩短过渡；关闭后保留加载指示。</p></div>
                  <Segmented
                    value={settings.motion}
                    options={[
                      { value: 'full', label: '完整' },
                      { value: 'reduced', label: '柔和' },
                      { value: 'off', label: '关闭' },
                    ]}
                    onChange={(value) => updateSettings({ motion: value as AppSettings['motion'] })}
                  />
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-row">
                  <div><strong>数据网格密度</strong><p>紧凑模式在 MacBook 屏幕上能多显示约 20% 行。</p></div>
                  <Segmented
                    value={settings.gridDensity}
                    options={[{ value: 'comfortable', label: '舒适' }, { value: 'compact', label: '紧凑' }]}
                    onChange={(value) => updateSettings({ gridDensity: value })}
                  />
                </div>
                <div className="settings-row">
                  <div><strong>编辑器字号</strong><p>SQL 编辑器的代码大小。</p></div>
                  <div className="stepper">
                    <button onClick={() => updateSettings({ editorFontSize: Math.max(11, settings.editorFontSize - 1) })}>−</button>
                    <span>{settings.editorFontSize} px</span>
                    <button onClick={() => updateSettings({ editorFontSize: Math.min(20, settings.editorFontSize + 1) })}>+</button>
                  </div>
                </div>
                <div className="settings-row">
                  <div><strong>界面缩放</strong><p>调整整个窗口的显示比例。</p></div>
                  <div className="stepper">
                    <button onClick={() => updateSettings({ zoomFactor: Math.max(0.8, Math.round((settings.zoomFactor - 0.05) * 100) / 100) })}>−</button>
                    <span>{Math.round(settings.zoomFactor * 100)}%</span>
                    <button onClick={() => updateSettings({ zoomFactor: Math.min(1.4, Math.round((settings.zoomFactor + 0.05) * 100) / 100) })}>+</button>
                  </div>
                </div>
              </div>
            </>
          )}

          {section === 'query' && (
            <>
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>查询</h3>
                  <p>让结果加载得更快，也更容易控制。</p>
                </div>
                <div className="settings-row">
                  <div><strong>最大返回行数</strong><p>超出后会截断显示，避免一次查询拖垮界面。</p></div>
                  <Select
                    className="settings-select"
                    value={settings.maxRows}
                    onChange={(value) => updateSettings({ maxRows: Number(value) })}
                    width={132}
                    options={[500, 1000, 2000, 5000, 10000, 20000].map((value) => ({
                      value: String(value),
                      label: `${value.toLocaleString()} 行`,
                    }))}
                  />
                </div>
                <div className="settings-row">
                  <div><strong>自动限制无 LIMIT 的 SELECT</strong><p>自动追加结果上限，避免一次查询把数万行拉进内存。会显示截断提示。</p></div>
                  <Switch checked={settings.autoLimitSelects} onChange={(value) => updateSettings({ autoLimitSelects: value })} />
                </div>
                <div className="settings-row">
                  <div><strong>查询超时</strong><p>超过这个时间由 MySQL 中止查询，避免一条 SQL 卡住几分钟。0 表示不限制。</p></div>
                  <Select
                    className="settings-select"
                    value={settings.queryTimeoutSeconds}
                    onChange={(value) => updateSettings({ queryTimeoutSeconds: Number(value) })}
                    width={132}
                    options={[0, 10, 30, 60, 120, 300].map((value) => ({
                      value: String(value),
                      label: value === 0 ? '不限制' : `${value} 秒`,
                    }))}
                  />
                </div>
                <div className="settings-row">
                  <div><strong>自动重连</strong><p>所有连接共享的行为，可在单个连接中覆盖。</p></div>
                  <span className="settings-static"><Zap size={12} /> 已启用</span>
                </div>
                <div className="settings-row">
                  <div><strong>显示系统数据库</strong><p>在侧边栏显示 mysql、sys、information_schema 等。</p></div>
                  <Switch checked={settings.showSystemSchemas} onChange={(value) => updateSettings({ showSystemSchemas: value })} />
                </div>
              </div>
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>编辑器</h3>
                </div>
                <div className="settings-tips">
                  <div><Kbd>⌘↵</Kbd><span>运行光标所在语句，或运行选中内容</span></div>
                  <div><Kbd>⇧⌘↵</Kbd><span>运行编辑器中的全部 SQL</span></div>
                  <div><Kbd>⇧⌘F</Kbd><span>格式化 SQL</span></div>
                  <div><Kbd>⌘E</Kbd><span>查看执行计划</span></div>
                  <div><Kbd>⌘P</Kbd><span>打开 AI 生成 SQL</span></div>
                  <div><Kbd>⌘S</Kbd><span>保存当前查询到「已保存」</span></div>
                </div>
              </div>
            </>
          )}

          {section === 'ai' && <AIProvidersPanel />}

          {section === 'data' && (
            <>
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>凭据与隐私</h3>
                  <p>Finch 没有服务器、没有账号系统，也不会上传你的数据。</p>
                </div>
                <div className="privacy-card">
                  <span className="privacy-icon"><ShieldCheck size={18} /></span>
                  <div>
                    <strong>macOS Keychain 加密</strong>
                    <p>密码、SSH 口令和私钥口令使用系统安全存储加密，写入本机应用数据目录。</p>
                  </div>
                </div>
                <div className="privacy-card">
                  <span className="privacy-icon"><Database size={18} /></span>
                  <div>
                    <strong>查询历史仅保存在本地</strong>
                    <p>保留最近 500 条 SQL，不会同步到任何地方。当前有 {history.length} 条记录。</p>
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>存储</h3>
                </div>
                <div className="path-row">
                  <span className="path-label"><FolderOpen size={13} /> 应用数据</span>
                  <code>{appInfo?.dataDir || '—'}</code>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      if (appInfo?.dataDir) {
                        navigator.clipboard.writeText(appInfo.dataDir);
                        toast('success', '路径已复制');
                      }
                    }}
                  >
                    <Copy size={12} /> 复制
                  </button>
                </div>
                <div className="settings-row">
                  <div><strong>清空查询历史</strong><p>删除全部本地 SQL 历史，操作不可撤销。</p></div>
                  <button
                    className="btn btn-ghost btn-sm danger-text"
                    onClick={() =>
                      askConfirm({
                        title: '清空查询历史',
                        message: '清空全部查询历史？',
                        detail: '此操作无法撤销，但不会影响数据库中的数据。',
                        confirmLabel: '清空历史',
                        onConfirm: () => clearHistory(),
                      })
                    }
                  >
                    <Trash2 size={12} /> 清空历史
                  </button>
                </div>
              </div>
            </>
          )}

          {section === 'about' && (
            <div className="about-panel">
              <div className="about-mark"><Logo size={56} /></div>
              <h2>Finch</h2>
              <p className="about-tagline">MySQL，不等待。</p>
              <span className="about-version">Version {appInfo?.version || '0.2.0'} · {appInfo?.arch || 'arm64'}</span>
              <div className="about-grid">
                <div><span>Runtime</span><strong>Tauri 2</strong></div>
                <div><span>WebView</span><strong>macOS WKWebView</strong></div>
                <div><span>Backend</span><strong>Rust · mysql_async</strong></div>
                <div><span>平台</span><strong>{appInfo?.arch || 'arm64'} · macOS</strong></div>
              </div>
              <p className="about-copy">
                为讨厌等待的开发者而做。连接池保持温暖、结果网格虚拟化、
                所有凭据留在本机。用键盘完成大部分工作。
              </p>
              <div className="about-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => setModal('shortcuts')}><Keyboard size={13} /> 快捷键</button>
                <button className="btn btn-ghost btn-sm" onClick={() => window.finch.app.openExternal('https://dev.mysql.com/doc/')}><BookMarked size={13} /> MySQL 文档</button>
              </div>
              <span className="about-credit">Crafted for macOS · No subscription, ever.</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function ShortcutsModal() {
  const setModal = useStore((state) => state.setModal);
  const groups = [
    {
      title: '全局',
      items: [
        ['命令面板', ['⌘', 'K']],
        ['新建查询', ['⌘', 'T']],
        ['新建连接', ['⇧', '⌘', 'N']],
        ['打开 SQL 文件', ['⌘', 'O']],
        ['保存查询', ['⌘', 'S']],
        ['切换侧边栏', ['⌘', 'B']],
        ['切换主题', ['⇧', '⌘', 'L']],
        ['设置', ['⌘', ',']],
      ],
    },
    {
      title: '查询',
      items: [
        ['运行当前语句', ['⌘', '↵']],
        ['运行全部', ['⇧', '⌘', '↵']],
        ['执行计划', ['⌘', 'E']],
        ['AI 生成 SQL', ['⌘', 'P']],
        ['AI 生成 SQL（备用）', ['⇧', '⌘', 'A']],
        ['格式化 SQL', ['⇧', '⌘', 'F']],
        ['取消查询', ['⌘', '.']],
        ['关闭标签页', ['⌘', 'W']],
      ],
    },
    {
      title: '结果网格',
      items: [
        ['复制单元格', ['⌘', 'C']],
        ['移动选中单元格', ['↑', '↓', '←', '→']],
        ['编辑单元格', ['双击']],
        ['取消编辑', ['esc']],
      ],
    },
  ];
  return (
    <Modal
      open
      onClose={() => setModal(null)}
      title="键盘快捷键"
      subtitle="少用鼠标，多写 SQL"
      icon={<Keyboard size={17} />}
      size="md"
      footer={<><span className="modal-foot-hint">提示：在结果网格中先点击单元格，再按 ⌘C。</span><span className="modal-foot-spacer" /><button className="btn btn-primary" onClick={() => setModal(null)}>知道了</button></>}
    >
      <div className="shortcuts-grid">
        {groups.map((group) => (
          <div className="shortcut-group" key={group.title}>
            <h4>{group.title}</h4>
            {group.items.map(([label, keys]) => (
              <div className="shortcut-row" key={label as string}>
                <span>{label}</span>
                <span className="shortcut-keys">
                  {(keys as string[]).map((key) => <Kbd key={key}>{key}</Kbd>)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function SaveQueryModal() {
  const state = useStore((store) => store.saveQueryState);
  const setModal = useStore((store) => store.setModal);
  const saveQuery = useStore((store) => store.saveQuery);
  const setSaveQueryState = useStore((store) => store.setSaveQueryState);
  const activeTab = useStore((store) => store.tabs.find((tab) => tab.id === store.saveQueryState?.tabId));
  const [name, setName] = useState(state?.name || '');
  const [saving, setSaving] = useState(false);

  if (!state) return null;
  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await saveQuery(state.tabId, trimmed);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={() => setSaveQueryState(null)}
      title={activeTab?.savedQueryId ? '更新已保存查询' : '保存查询'}
      subtitle="保存在本机，随时从侧边栏调用"
      icon={<Save size={17} />}
      size="sm"
      footer={
        <>
          <span className="modal-foot-hint"><Kbd>↵</Kbd> 保存</span>
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={() => setSaveQueryState(null)}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={!name.trim() || saving}>
            <Save size={13} /> {activeTab?.savedQueryId ? '更新' : '保存'}
          </button>
        </>
      }
    >
      <div className="save-query-form">
        <label className="field">
          <span>名称</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            placeholder="例如：每日订单汇总"
          />
        </label>
        <div className="save-query-preview">
          <span className="preview-label"><FileCode2 size={12} /> SQL 预览</span>
          <code>{splitSqlPreview(state.sql, 240) || '（空查询）'}</code>
        </div>
        <span className="save-query-meta">{activeTab?.database || '默认数据库'} · {state.sql.split('\n').length} 行</span>
      </div>
    </Modal>
  );
}
