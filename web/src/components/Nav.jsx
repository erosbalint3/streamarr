import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { IconSearch, IconSettings, IconLogout, IconPulse } from './Icons.jsx';

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="Streamarr">
      <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
        <defs>
          <linearGradient id="wm" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#D4C8FF" />
            <stop offset="1" stopColor="#7B66F0" />
          </linearGradient>
        </defs>
        <path d="M22 16.5v31a2 2 0 0 0 3 1.7l26-15.5a2 2 0 0 0 0-3.4L25 14.8a2 2 0 0 0-3 1.7z" fill="url(#wm)" />
        <path d="M8 22h8M5 32h11M8 42h8" stroke="#7B66F0" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <span>streamarr</span>
    </span>
  );
}

export default function Nav() {
  const { user, logout } = useAuth();
  const [libraries, setLibraries] = useState([]);
  const [solid, setSolid] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/api/libraries').then(setLibraries).catch(() => {});
  }, []);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e) => !menuRef.current?.contains(e.target) && setMenu(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  return (
    <header className={`nav ${solid ? 'nav-solid' : ''}`}>
      <Link to="/" className="nav-brand">
        <Wordmark />
      </Link>
      <nav className="nav-links" aria-label="Libraries">
        <NavLink to="/" end>
          Home
        </NavLink>
        {libraries.map((l) => (
          <NavLink key={l.id} to={`/library/${l.id}`}>
            {l.name}
          </NavLink>
        ))}
      </nav>
      <div className="nav-tools">
        <button className="icon-btn" onClick={() => navigate('/search')} aria-label="Search">
          <IconSearch />
        </button>
        <div className="nav-user" ref={menuRef}>
          <button className="avatar" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu">
            {user?.username?.[0]?.toUpperCase()}
          </button>
          {menu && (
            <div className="menu" role="menu">
              <div className="menu-head">{user?.username}</div>
              <Link role="menuitem" to="/settings" onClick={() => setMenu(false)}>
                <IconSettings size={18} /> Playback & account
              </Link>
              {user?.isAdmin && (
                <Link role="menuitem" to="/admin" onClick={() => setMenu(false)}>
                  <IconPulse size={18} /> Server dashboard
                </Link>
              )}
              <button role="menuitem" onClick={() => logout().then(() => navigate('/login'))}>
                <IconLogout size={18} /> Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
