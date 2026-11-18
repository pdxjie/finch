import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { Modal } from './Modal';

export function ConfirmDialog() {
  const state = useStore((store) => store.confirmState);
  const close = useStore((store) => store.closeConfirm);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
  }, [state]);

  if (!state) return null;
  const confirm = async () => {
    setBusy(true);
    try {
      await state.onConfirm();
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!busy) {
          state.onCancel?.();
          close();
        }
      }}
      title={state.title}
      subtitle={state.detail}
      icon={<AlertTriangle size={17} />}
      size="sm"
      footer={
        <>
          <span className="modal-foot-hint">此操作不会同步到其他设备</span>
          <span className="modal-foot-spacer" />
          <button className="btn btn-ghost" onClick={() => { state.onCancel?.(); close(); }} disabled={busy}>取消</button>
          <button autoFocus className={state.danger === false ? 'btn btn-primary' : 'btn btn-danger'} onClick={confirm} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : null}
            {state.confirmLabel || '确认'}
          </button>
        </>
      }
    >
      <div className="confirm-copy">
        <div className={state.danger === false ? 'neutral-callout' : 'danger-callout'}>
          <AlertTriangle size={16} />
          <span>{state.message}</span>
        </div>
        {state.sql && <pre className="confirm-sql">{state.sql}</pre>}
      </div>
    </Modal>
  );
}
