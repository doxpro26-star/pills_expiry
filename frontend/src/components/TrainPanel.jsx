export default function TrainPanel({ health }) {
  const total = health?.dataset_images || 0
  const classes = health?.classes?.length || 0
  const trained = health?.model_loaded === true

  return (
    <div className="card">
      <h3><span className="step">2</span> Teach — run locally, keep light <span className="meta">MobileNetV2 · 20 epochs</span></h3>
      <div className="grid" style={{marginBottom:12}}>
        <div className="stat"><div className="stat-value">{classes}</div><div className="stat-label">Batches</div></div>
        <div className="stat"><div className="stat-value">{total}</div><div className="stat-label">Photos</div></div>
        <div className="stat"><div className="stat-value" style={{fontSize:'1.05rem',paddingTop:6}}>{trained ? 'Ready' : 'Waiting'}</div><div className="stat-label">Model</div></div>
      </div>

      {!trained && total < 30 && (
        <div className="banner banner-warn" style={{marginBottom:12}}>Need at least <b>30 photos</b> across <b>2+ batches</b> to teach well — more angles = kinder model.</div>
      )}

      <pre className="small" style={{background:'#f8fafc', padding:'14px', borderRadius:12, overflow:'auto', border:'1px solid #e2e8f0', lineHeight:1.7}}>
{`# on your laptop where dataset/ lives
pip install -r requirements.txt
python train_tablets.py --data dataset --epochs 20

# makes tablet_classifier.pth + classes.json
# then Reload Model above`}
      </pre>

      <details style={{marginTop:12}}>
        <summary className="small" style={{cursor:'pointer',color:'var(--primary)',fontWeight:600}}>How this studio thinks</summary>
        <ul className="small" style={{marginTop:8, paddingLeft:18, lineHeight:1.8}}>
          <li><b>Collect</b> — you name the batch (<code>Tablet__MM-YYYY</code>), light decides</li>
          <li><b>Teach</b> — MobileNetV2 fine-tunes on your photos, not a cloud</li>
          <li><b>Read</b> — predicts batch + expiry → Valid / Due soon / Expired</li>
          <li>No YOLO, no OCR — just careful looking</li>
        </ul>
      </details>
    </div>
  )
}
