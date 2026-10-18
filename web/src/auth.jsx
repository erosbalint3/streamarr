import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, needsSetup: false, serverName: 'Streamarr' });

  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/api/auth/status');
      setState({ loading: false, user: s.user, needsSetup: s.needsSetup, serverName: s.serverName });
    } catch {
      setState((p) => ({ ...p, loading: false }));
    }
  }, []);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => setState((p) => ({ ...p, user: null }));
    window.addEventListener('streamarr:unauthorized', onUnauthorized);
    return () => window.removeEventListener('streamarr:unauthorized', onUnauthorized);
  }, [refresh]);

  const login = async (username, password) => {
    const r = await api.post('/api/auth/login', { username, password });
    setState((p) => ({ ...p, user: r.user, needsSetup: false }));
  };
  const setup = async (username, password) => {
    const r = await api.post('/api/auth/setup', { username, password });
    setState((p) => ({ ...p, user: r.user, needsSetup: false }));
  };
  const logout = async () => {
    await api.post('/api/auth/logout');
    setState((p) => ({ ...p, user: null }));
  };
  const updatePrefs = async (patch) => {
    const r = await api.put('/api/me/prefs', patch);
    setState((p) => ({ ...p, user: { ...p.user, prefs: r.prefs } }));
    return r.prefs;
  };

  return <AuthContext.Provider value={{ ...state, refresh, login, setup, logout, updatePrefs }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
