import type { PrivateRuntimeState, PrivateScriptRuntime } from '../lib/privacy/runtime';

export function PrivateScriptWalletPanel({ state, runtime, disabled, onTask, onExample, feedback, activeAction }: {
  state: PrivateRuntimeState; runtime: PrivateScriptRuntime | null; disabled: boolean;
  feedback: { message: string; error?: boolean }; activeAction: string | null;
  onTask: (action: 'create' | 'deploy' | 'faucet' | 'inspect') => void;
  onExample: () => void;
}) {
  function exportWallet() {
    if (!state.wallet) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ type: 'framepay-quantum-v1', network: 'devnet', genesisHash: state.wallet.networkDomain, wallet: state.wallet }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'framepay-private-wallet-metadata.json'; anchor.click(); URL.revokeObjectURL(url);
  }
  return <section className="evml-card">
    <h2>Private wallet <span className="evml-badge">PASSKEY</span></h2>
    <p className="evml-hint">Private scripts use your quantum wallet on Framecraft devnet. Each frame:tx block asks for your passkey once and waits for confirmation.</p>
    {feedback.message && <p role={feedback.error ? 'alert' : 'status'} className={`evml-hint${feedback.error ? ' evml-error' : ''}`}>{feedback.message}</p>}
    {state.wallet ? <>
      <p className="evml-private-address">{state.wallet.address}</p>
      {state.deploymentStatus === 'deployed' && <p className="evml-hint" role="status">Deployed on Framecraft devnet</p>}
      {state.deploymentError && <p className="evml-hint evml-error" role="alert">{state.deploymentError} <button className="evml-link" disabled={disabled} onClick={() => void runtime?.refreshWalletDeployment()}>Recheck deployment</button></p>}
      <div className="evml-actions">
        {state.deploymentStatus !== 'deployed' && <button className="evml-button" disabled={disabled || !!state.pending || state.deploymentStatus === 'checking'} onClick={() => onTask('deploy')}>{activeAction === 'deploy' ? 'Deploying…' : state.deploymentStatus === 'checking' ? 'Checking deployment…' : 'Deploy wallet'}</button>}
        <button className="evml-button" disabled={disabled || !!state.pending} onClick={() => onTask('faucet')}>Get FPA + FPB</button>
        <button className="evml-link" disabled={disabled} onClick={exportWallet}>Export public metadata</button>
      </div>
    </> : <button className="evml-button" disabled={disabled} onClick={() => onTask('create')}>Create private wallet</button>}
    <details className="evml-hint"><summary>Restore an existing wallet</summary>
      <p>Paste its public metadata export. The original passkey and the exact same site origin are required.</p>
      <form onSubmit={event => {
        event.preventDefault();
        const form = event.currentTarget;
        const field = form.elements.namedItem('metadata') as HTMLTextAreaElement;
        try { runtime?.importWallet(field.value); field.value = ''; field.setCustomValidity(''); }
        catch (error) { field.setCustomValidity(error instanceof Error ? error.message : 'Invalid metadata.'); field.reportValidity(); }
      }}>
        <textarea name="metadata" aria-label="Public wallet metadata" rows={3} disabled={disabled || !!state.pending} onChange={event => event.currentTarget.setCustomValidity('')} />
        <button className="evml-link" disabled={disabled || !!state.pending}>Import metadata</button>
      </form>
    </details>
    {state.pending && <p className="evml-hint">Pending: <code>{state.pending.hash}</code> <button className="evml-link" disabled={disabled} onClick={() => onTask('inspect')}>Inspect receipt</button></p>}
    {state.snapshot && <div className="evml-hint">{Object.entries(state.snapshot.balances).map(([pocket, balance]) => <p key={pocket}><strong>{pocket}</strong>: {balance.A} FPA · {balance.B} FPB</p>)}</div>}
    <div className="evml-actions">
      <button className="evml-link" disabled={disabled} onClick={onExample}>Load private script example</button>
      <button className="evml-link" disabled={disabled || !state.viewing} onClick={() => runtime?.lock()}>Lock balances</button>
    </div>
    <p className="evml-hint">Pocket names belong to this passkey; use someone’s 0zk address to pay them. Keep your passkey and export updated public metadata after adding pockets so their names can be recovered.</p>
  </section>;
}
