import { useEffect, useState } from 'react';
import { Loader2, Eye } from 'lucide-react';
import { api } from '../lib/api';
import Picker from './Picker';

// Whose files this person may read besides their own (server/fileAccess.js):
// "Rona can see Said's files". Reading only - changing a file stays with its owner.

export default function FileAccess({ person }) {
  const [owners, setOwners] = useState(undefined); // undefined = loading
  const [people, setPeople] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setOwners(undefined); setError('');
    api.get(`/file-access/user/${person.id}`).then(setOwners).catch(() => setOwners([]));
    api.get('/admin/users').then(setPeople).catch(() => setPeople([]));
  }, [person.id]);

  const save = async (ids) => {
    setBusy(true); setError('');
    try { setOwners(await api.put(`/file-access/user/${person.id}`, { owners: ids })); } catch (e) { setError(e.message); }
    setBusy(false);
  };

  if (owners === undefined) return <Loader2 size={18} className="mx-auto my-3 animate-spin text-mute" />;
  if (person.role === 'master') return null; // the master already sees everyone's

  const options = people.filter((p) => p.id !== person.id && p.role !== 'master')
    .map((p) => ({ value: p.id, label: p.name, hint: p.email }));

  return (
    <div className="space-y-1.5">
      <span className="flex items-center gap-2 text-[11px] font-medium tracking-[0.14em] text-mute">
        CAN SEE FILES OF {busy && <Loader2 size={12} className="animate-spin" />}
      </span>
      <Picker multi value={owners.map((o) => o.id)} onChange={save} options={options}
        icon={<Eye size={14} />} placeholder="Only their own files" searchPlaceholder="Search people" />
      <p className="text-xs text-mute">They can open and ask about these people's uploads, but not change or delete them.</p>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
