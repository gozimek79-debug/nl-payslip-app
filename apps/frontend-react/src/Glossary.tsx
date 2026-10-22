import { useMemo, useState } from 'react';
import { filterGlossary, type GlossaryCategory } from './glossary-data.ts';
import type { Lang } from './translations.ts';
import './glossary.css';

const categories: readonly (GlossaryCategory | 'all')[] = ['all', 'pay', 'tax', 'leave', 'contract', 'extras'];
const copy = {
  pl: {
    search: 'Szukaj po polsku, niderlandzku lub angielsku',
    searchLabel: 'Szukaj pojęcia',
    all: 'Wszystkie', pay: 'Wynagrodzenie', tax: 'Podatki i potrącenia',
    leave: 'Urlopy', contract: 'Zatrudnienie', extras: 'Dodatki',
    noResults: 'Nie znaleziono pojęcia. Spróbuj innego słowa.',
    detail: 'Objaśnienie', heading: 'Słownik pojęć', count: (n: number) => `${n} pojęć`,
    caution: 'Objaśnienia mają charakter ogólny. Konkretną stawkę, uprawnienie lub właściwy CAO należy sprawdzić w dokumentach i aktualnych zasadach.',
    dutch: 'Po niderlandzku', polish: 'Po polsku', english: 'Po angielsku',
  },
  en: {
    search: 'Search in Polish, Dutch or English', searchLabel: 'Search terms',
    all: 'All', pay: 'Pay', tax: 'Taxes and deductions', leave: 'Leave',
    contract: 'Employment', extras: 'Premiums', noResults: 'No matching terms. Try another word.',
    detail: 'Explanation', heading: 'Payroll glossary', count: (n: number) => `${n} terms`,
    caution: 'These are general explanations. Check your documents and the current rules for individual rates, entitlements and the applicable CAO.',
    dutch: 'Dutch', polish: 'Polish', english: 'English',
  },
} as const;

export function Glossary({ lang }: { lang: Lang }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<GlossaryCategory | 'all'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const c = copy[lang];
  const items = useMemo(() => filterGlossary(query, category), [query, category]);
  return <section className="glossary" aria-label={c.heading}>
    <p className="glossary-notice">{c.caution}</p>
    <div className="glossary-search">
      <label htmlFor="glossary-query">{c.searchLabel}</label>
      <input id="glossary-query" type="search" placeholder={c.search}
        value={query} onChange={e => { setQuery(e.target.value); setExpandedId(null); }} />
    </div>
    <div className="glossary-filters" role="group" aria-label={c.heading}>
      {categories.map(item => <button key={item} type="button"
        aria-pressed={category === item} className={category === item ? 'active' : ''}
        onClick={() => { setCategory(item); setExpandedId(null); }}>
        {c[item]}
      </button>)}
    </div>
    <p className="glossary-count" role="status">{c.count(items.length)}</p>
    {items.length === 0 && <p className="glossary-empty">{c.noResults}</p>}
    <div className="glossary-grid">
      {items.map(term => <article className="glossary-card" key={term.id}>
        <button className="glossary-expand" type="button"
          aria-expanded={expandedId === term.id}
          aria-controls={`glossary-detail-${term.id}`}
          onClick={() => setExpandedId(expandedId === term.id ? null : term.id)}>
          <span><strong>{term.nl}</strong><small>{lang === 'pl' ? term.pl : term.en}</small></span>
          <span aria-hidden="true">{expandedId === term.id ? '−' : '+'}</span>
        </button>
        {expandedId === term.id && <div className="glossary-detail" id={`glossary-detail-${term.id}`}>
          <p><strong>{c.dutch}:</strong> {term.nl}</p>
          <p><strong>{c.polish}:</strong> {term.pl}</p>
          <p><strong>{c.english}:</strong> {term.en}</p>
          <p><strong>{c.detail}:</strong> {lang === 'pl' ? term.descriptionPl : term.descriptionEn}</p>
        </div>}
      </article>)}
    </div>
  </section>;
}
