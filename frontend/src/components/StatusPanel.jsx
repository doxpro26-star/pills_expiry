export default function StatusPanel({ health, onReload }) {
  if (!health) {
    return (
      <div className="card">
        <h3><span className="step" style={{background:'#e2e8f0',color:'#64748b'}}>•</span> Studio health</h3>
        <div className="banner banner-warn">Backend is waking — Render cold start ~30s. Retry in a moment.</div>
        <p className="small" style={{marginTop:8}}>Checks <code>/health</code> every 5s. Keep this tab open.</p>
      </div>
    )
  }

  const isTrained = health.model_loaded && health.classes.length > 0
  const totalImages = health.dataset_images || 0

  return (
    <div className="card">
      <h3><span className="step">◉</span> Studio health <span className="meta">{isTrained ? 'trained' : 'collecting'}</span></h3>
      <div className="grid">
        <div className="stat">
          <div className="stat-value">{health.classes.length}</div>
          <div className="stat-label">Batches</div>
        </div>
        <div className="stat">
          <div className="stat-value">{totalImages}</div>
          <div className="stat-label">Photos</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{fontSize:'1.1rem',paddingTop:6}}>{isTrained ? 'Ready' : '—'}</div>
          <div className="stat-label">Model</div>
        </div>
        <div className="stat">
          <div className="stat-value" style={{fontSize:'1.1rem',paddingTop:6}}>{health.torch ? 'Torch' : '—'}</div>
          <div className="stat-label">Engine</div>
        </div>
      </div>
      {health.classes.length > 0 && (
        <details style={{marginTop:12}}>
          <summary className="small" style={{cursor:'pointer'}}>Batches: {health.classes.join(', ')}</summary>
          <pre className="small" style={{marginTop:8, background:'#f8fafc', padding:10, borderRadius:10, overflow:'auto', border:'1px solid #e2e8f0'}}>
            {JSON.stringify(health.dataset_counts, null, 2)}
          </pre>
        </details>
      )}
      {!isTrained && totalImages > 0 && (
        <div className="banner banner-info" style={{marginTop:12}}>
          📦 {totalImages} photos waiting — run <code>python train_tablets.py --data dataset --epochs 20</code> on your machine, then <b>Reload Model</b>.
        </div>
      )}
      <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
        <button className="btn secondary" onClick={onReload}>↻ Reload model</button>
        <span className="small" style={{alignSelf:'center'}}>Looks for <code>tablet_classifier.pth</code> + <code>classes.json</code></span>
      </div>
    </div>
  )
}
