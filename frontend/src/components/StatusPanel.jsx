export default function StatusPanel({ health, onReload }) {
  if (!health) {
    return (
      <div className="card">
        <h3>Status</h3>
        <div className="status-err">⚠️ Backend not reachable</div>
        <p className="small">Deploy backend (Railway/Render) and set VITE_API_URL in Vercel/Netlify env vars</p>
      </div>
    )
  }

  const isTrained = health.model_loaded && health.classes.length > 0
  const totalImages = health.dataset_images || 0

  return (
    <div className="card">
      <h3>System Status</h3>
      <div className="grid">
        <div className="stat">
          <div className="stat-value">{health.classes.length}</div>
          <div className="stat-label">Classes</div>
        </div>
        <div className="stat">
          <div className="stat-value">{totalImages}</div>
          <div className="stat-label">Images Collected</div>
        </div>
        <div className="stat">
          <div className="stat-value">{isTrained ? '✅' : '❌'}</div>
          <div className="stat-label">Model</div>
        </div>
        <div className="stat">
          <div className="stat-value">{health.torch ? '✅' : '❌'}</div>
          <div className="stat-label">PyTorch</div>
        </div>
      </div>
      {health.classes.length > 0 && (
        <details style={{marginTop: '12px'}}>
          <summary className="small">Classes: {health.classes.join(', ')}</summary>
          <pre className="small" style={{marginTop:8, background:'#020617', padding:8, borderRadius:6, overflow:'auto'}}>
            {JSON.stringify(health.dataset_counts, null, 2)}
          </pre>
        </details>
      )}
      {!isTrained && totalImages > 0 && (
        <div style={{marginTop: '12px', padding: '12px', background: '#1e3a5f', borderRadius: 8, color: '#93c5fd'}}>
          📦 {totalImages} images collected. Train model: <code>python train_tablets.py --data dataset --epochs 20</code>
          then click Reload Model.
        </div>
      )}
      <button className="btn secondary" onClick={onReload} style={{marginTop: 12}}>🔄 Reload Model</button>
    </div>
  )
}