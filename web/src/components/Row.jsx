import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PosterCard, LandscapeCard } from './Cards.jsx';
import { IconChevronLeft, IconChevronRight } from './Icons.jsx';

export default function Row({ title, items, style = 'poster', moreLink }) {
  const ref = useRef(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const update = () => {
    const el = ref.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8 });
  };
  useEffect(update, [items]);

  const page = (dir) => {
    const el = ref.current;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <section className={`row row-${style}`}>
      <div className="row-head">
        <h2>{title}</h2>
        {moreLink && (
          <Link to={moreLink} className="row-more">
            See all
          </Link>
        )}
      </div>
      <div className="row-viewport">
        {!edges.start && (
          <button className="row-arrow row-arrow-l" onClick={() => page(-1)} aria-label="Scroll left">
            <IconChevronLeft size={28} />
          </button>
        )}
        <div className="row-track" ref={ref} onScroll={update}>
          {items.map((it) => (style === 'landscape' ? <LandscapeCard key={it.id} item={it} /> : <PosterCard key={it.id} item={it} />))}
        </div>
        {!edges.end && (
          <button className="row-arrow row-arrow-r" onClick={() => page(1)} aria-label="Scroll right">
            <IconChevronRight size={28} />
          </button>
        )}
      </div>
    </section>
  );
}
