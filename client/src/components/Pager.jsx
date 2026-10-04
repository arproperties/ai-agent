import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Select from './Select';

// Every table shows a page of its rows at a time. usePaged cuts the page out of the rows
// already on screen (searched, filtered and sorted); Pager is the strip under the table
// that moves between pages and chooses how many rows a page holds.

const SIZES = [10, 25, 50, 100];
const STEP = 'grid size-8 place-items-center rounded-full text-mute hover:bg-white/10 hover:text-txt disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mute';

/** The page of `rows` to draw, and what Pager needs. A change of `key` (the search, a filter) goes back to the first page. */
export function usePaged(rows, key = '') {
  const [size, setSize] = useState(25);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [key]);
  const total = rows?.length || 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(page, pages); // rows can go (a delete, a narrower filter) while a later page is open
  const first = (at - 1) * size;
  return {
    rows: rows ? rows.slice(first, first + size) : rows,
    first, // how many rows come before this page
    pager: { page: at, pages, size, total, first, onPage: setPage, onSize: (n) => { setSize(n); setPage(1); } },
  };
}

export default function Pager({ page, pages, size, total, first, onPage, onSize }) {
  if (total <= SIZES[0]) return null; // it all fits on the smallest page
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-mute">
      <span>{first + 1}–{Math.min(first + size, total)} of {total}</span>
      <span className="flex items-center gap-1">
        <Select value={size} onChange={(e) => onSize(Number(e.target.value))} options={SIZES.map((n) => [n, `${n} per page`])} aria-label="Rows per page"
          className="glass rounded-xl bg-surface px-3 py-1.5 text-xs outline-none" wrap="mr-1 w-32" />
        <button onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page" title="Previous page" className={STEP}><ChevronLeft size={16} /></button>
        <span className="min-w-[5.5rem] text-center">Page {page} of {pages}</span>
        <button onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page" title="Next page" className={STEP}><ChevronRight size={16} /></button>
      </span>
    </div>
  );
}
