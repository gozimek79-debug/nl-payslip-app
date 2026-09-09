import { useState } from 'react';
import { ArrowLeft, Check, FileText, LogOut, Trash2 } from 'lucide-react';
import { translations, type Lang } from './translations.ts';

type User = { id: string; email: string };
type HistoryItem = { id: string; fileName: string; status: string; createdAt: string };

interface AccountPageProps {
  lang: Lang;
  user: User;
  history: HistoryItem[];
  onBack: () => void;
  onLogout: () => void;
  onStartAnalysis: () => void;
  onDeleteData: () => Promise<void>;
}

export function AccountPage({ lang, user, history, onBack, onLogout, onStartAnalysis, onDeleteData }: AccountPageProps) {
  const t = translations[lang].account;
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleConfirmDelete() {
    setDeleting(true);
    try {
      await onDeleteData();
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <section className="flow-page account-page">
      <button className="back plain-button" onClick={onBack}><ArrowLeft size={17}/>{t.back}</button>
      <div className="flow-heading">
        <span className="step">{t.title}</span>
        <h1>{t.pageTitle}</h1>
      </div>

      <div className="account-page-grid">
        <aside className="document-card account-profile-card">
          <div className="account-avatar">{user.email.charAt(0).toUpperCase()}</div>
          <span>{t.memberSince}</span>
          <strong className="account-page-email">{user.email}</strong>
          <button className="secondary account-logout-button" onClick={onLogout}><LogOut size={16}/>{t.logout}</button>
          {!confirmingDelete ? (
            <button className="secondary account-delete-button" onClick={() => setConfirmingDelete(true)}>
              <Trash2 size={16}/>{t.deleteData}
            </button>
          ) : (
            <div className="account-delete-confirm">
              <p>{t.deleteDataConfirm}</p>
              <div className="account-delete-confirm-actions">
                <button className="secondary" onClick={() => setConfirmingDelete(false)} disabled={deleting}>{t.deleteDataCancel}</button>
                <button className="danger" onClick={handleConfirmDelete} disabled={deleting}>{deleting ? t.deleteDataInProgress : t.deleteDataConfirmButton}</button>
              </div>
            </div>
          )}
        </aside>

        <div className="fields-card account-history-card">
          <h2>{t.historyTitle}</h2>
          <p className="form-note">{t.historyRetentionNote}</p>
          {history.length > 0 ? (
            <ul className="history-list history-list-wide">
              {history.map(item => (
                <li key={item.id}>
                  <FileText/>
                  <span>
                    <strong>{item.fileName}</strong>
                    <small>{new Date(item.createdAt).toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB')}</small>
                  </span>
                  <span className={`history-status ${item.status === 'consistent' ? 'ok' : ''}`}>
                    {item.status === 'consistent' && <Check size={14}/>}
                    {item.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="account-empty-history">
              <h3>{t.historyEmptyTitle}</h3>
              <p>{t.historyEmptyBody}</p>
              <button className="primary" onClick={onStartAnalysis}>{t.startAnalysis}</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
