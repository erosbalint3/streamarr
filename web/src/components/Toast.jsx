import { useEffect, useState } from 'react';

let push = () => {};
export function toast(message, kind = 'info') {
  push({ id: Math.random(), message, kind });
}

export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    push = (t) => {
      setItems((p) => [...p.slice(-2), t]);
      setTimeout(() => setItems((p) => p.filter((x) => x.id !== t.id)), 5000);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
