import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { api, peek, subscribe } from './api.js';

/**
 * Data for a page: renders instantly from cache when available (no loading state on Back or on a
 * hovered-then-clicked card) and always revalidates in the background.
 */
export function useApi(url) {
  const [state, setState] = useState(() => ({ data: url ? peek(url) : undefined, error: null }));
  const current = useRef(url);
  useEffect(() => {
    current.current = url;
    if (!url) return;
    setState({ data: peek(url), error: null });
    const off = subscribe(url, (data) => current.current === url && setState({ data, error: null }));
    api.revalidate(url).catch((e) => current.current === url && setState((s) => ({ ...s, error: s.data ? null : e })));
    return off;
  }, [url]);
  return { data: state.data, error: state.error, reload: () => url && api.revalidate(url).catch(() => {}) };
}

const positions = new Map();

/** Restore the scroll position when coming back to a page (once its content is rendered). */
export function useScrollRestore(ready) {
  const loc = useLocation();
  const nav = useNavigationType();
  const restored = useRef(false);
  useLayoutEffect(() => {
    restored.current = false;
    if (nav !== 'POP') window.scrollTo(0, 0);
  }, [loc.key, nav]);
  useLayoutEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    if (nav === 'POP' && positions.has(loc.key)) window.scrollTo(0, positions.get(loc.key));
  }, [ready, loc.key, nav]);
  useEffect(() => {
    const save = () => positions.set(loc.key, window.scrollY);
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      save();
      window.removeEventListener('scroll', save);
    };
  }, [loc.key]);
}
