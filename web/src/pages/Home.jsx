import { Link } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { useApi, useScrollRestore } from '../hooks.js';
import Hero from '../components/Hero.jsx';
import Row from '../components/Row.jsx';

export default function Home() {
  const { user } = useAuth();
  const { data, error } = useApi('/api/home');
  useScrollRestore(!!data);

  if (error) return <div className="empty"><p>{error.message}</p></div>;
  if (!data) return <div className="home-skeleton" aria-busy="true" />;

  if (!data.rows.length && !data.hero.length) {
    return (
      <div className="empty empty-hero">
        <h1>Nothing here yet</h1>
        {user?.isAdmin ? (
          <>
            <p>Add a library pointing at your movies or shows folder and Streamarr will scan it.</p>
            <Link className="btn btn-primary" to="/admin/libraries">Add a library</Link>
          </>
        ) : (
          <p>Your server admin hasn't added any media yet.</p>
        )}
      </div>
    );
  }

  return (
    <div className="home">
      <Hero items={data.hero} />
      <div className="rows">
        {data.rows.map((r) => (
          <Row key={r.id} title={r.title} items={r.items} style={r.style} moreLink={r.libraryId ? `/library/${r.libraryId}?sort=added` : null} />
        ))}
      </div>
    </div>
  );
}
