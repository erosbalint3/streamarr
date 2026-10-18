import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Wordmark } from '../components/Nav.jsx';

function AuthForm({ title, intro, submitLabel, onSubmit, confirm }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (confirm && password !== password2) return setError('The two passwords don\'t match.');
    setBusy(true);
    setError('');
    try {
      await onSubmit(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-glow" aria-hidden="true" />
      <form className="auth-card" onSubmit={submit}>
        <Wordmark />
        <h1>{title}</h1>
        {intro && <p className="muted">{intro}</p>}
        <label className="field">
          <span>Username</span>
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete={confirm ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={confirm ? 6 : undefined} />
        </label>
        {confirm && (
          <label className="field">
            <span>Repeat password</span>
            <input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
          </label>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'One moment…' : submitLabel}
        </button>
      </form>
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  return <AuthForm title="Welcome back" submitLabel="Sign in" onSubmit={async (u, p) => { await login(u, p); navigate(loc.state?.from || '/', { replace: true }); }} />;
}

export function Setup() {
  const { setup } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthForm
      title="Set up your server"
      intro="Create the admin account. You'll add your media folders next."
      submitLabel="Create admin account"
      confirm
      onSubmit={async (u, p) => {
        await setup(u, p);
        navigate('/admin/libraries', { replace: true });
      }}
    />
  );
}
