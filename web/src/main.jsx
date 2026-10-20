import { StrictMode, Suspense, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import '@fontsource-variable/bricolage-grotesque/standard.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import './styles.css';
import { AuthProvider, useAuth } from './auth.jsx';
import Nav from './components/Nav.jsx';
import { ToastHost } from './components/Toast.jsx';
import Home from './pages/Home.jsx';
import Library from './pages/Library.jsx';
import Item from './pages/Item.jsx';
import Search from './pages/Search.jsx';
import Settings from './pages/Settings.jsx';
import { Login, Setup } from './pages/Login.jsx';
// The player (hls.js) and dashboard load on demand to keep the first paint light…
const loadPlayer = () => import('./player/Player.jsx');
const Player = lazy(loadPlayer);
const Admin = lazy(() => import('./pages/Admin.jsx'));

function Gate({ children }) {
  const { loading, user, needsSetup } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="boot" aria-busy="true" />;
  if (needsSetup && loc.pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (!needsSetup && !user && loc.pathname !== '/login') return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return children;
}

function Shell({ children }) {
  // …but the player is fetched as soon as the browser is idle, so pressing Play never waits for it.
  // While browsing (never while watching) keep the connection estimate fresh for the next play.
  useEffect(() => {
    const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
    idle(() => {
      loadPlayer().catch(() => {});
      // hls.js after that, at lower priority (only Converted streams need it).
      setTimeout(() => import('./player/engine.js').then((m) => m.loadHls()).catch(() => {}), 4000);
      import('./player/caps.js').then((m) => m.refreshBandwidthWhenIdle()).catch(() => {});
    });
  }, []);
  return (
    <>
      <Nav />
      <main className="page">{children}</main>
    </>
  );
}

function App() {
  return (
    <Gate>
      <Suspense fallback={<div className="boot" />}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route path="/play/:id" element={<Player />} />
        <Route path="/" element={<Shell><Home /></Shell>} />
        <Route path="/library/:id" element={<Shell><Library /></Shell>} />
        <Route path="/item/:id" element={<Shell><Item /></Shell>} />
        <Route path="/search" element={<Shell><Search /></Shell>} />
        <Route path="/settings" element={<Shell><Settings /></Shell>} />
        <Route path="/admin/*" element={<Shell><Admin /></Shell>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </Gate>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
        <ToastHost />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
