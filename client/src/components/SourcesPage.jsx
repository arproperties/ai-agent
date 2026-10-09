import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import Page from './Page';
import SourceList from './SourceList';

// Where tenants come from: the one list, for every company and building, that a booking's
// source is picked from. Opened from the sidebar; the same list can be changed from the
// booking form. The server is server/leasing.js.

export default function SourcesPage({ onBack }) {
  const [sources, setSources] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api.get('/leasing/sources').then(setSources).catch((e) => setError(e.message)); }, []);

  return (
    <Page title="Sources" onBack={onBack}>
      <div className="space-y-4 rounded-3xl border border-stroke p-5 md:p-7">
        <p className="text-sm text-mute">Where tenants come from: a walk-in, a referral, a listing site. One list for every company and building; a lease picks its source from it. Renaming a source renames it on the leases that have it; removing one leaves those leases as they are.</p>
        {error && <p className="text-sm text-bad">{error}</p>}
        {sources ? <SourceList sources={sources} onChange={setSources} onError={setError} />
          : !error && <Loader2 size={18} className="mx-auto my-6 animate-spin text-mute" />}
      </div>
    </Page>
  );
}
