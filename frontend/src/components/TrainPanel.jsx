export default function TrainPanel({ health }) {
  const total = health?.dataset_images || 0
  const classes = health?.classes?.length || 0
  const trained = health?.model_loaded === true

  return (
    <div className="card">
      <h3>Step 2: Train Model (run locally)</h3>
      <div className="grid" style={{marginBottom: '12px'}}>
        <div className="stat">
          <div className="stat-value">{classes}</div>
          <div className="stat-label">Classes</div>
        </div>
        <div className="stat">
          <div className="stat-value">{total}</div>
          <div className="stat-label">Images</div>
        </div>
        <div className="stat">
          <div className="stat-value">{trained ? '✅ Ready' : '❌ Not Trained'}</div>
          <div className="stat-label">Model</div>
        </div>
      </div>

      {!trained && total < 30 && (
        <div style={{color: '#f87171', marginBottom: '12px'}}>
          ⚠️ Need at least 30 images across 2+ classes to train
        </div>
      )}

      <pre className="small" style={{background: '#020617', padding: '12px', borderRadius: 8, overflow: 'auto'}}>
{`# On your laptop (where dataset/ folder exists):
pip install -r requirements.txt
python train_tablets.py --data dataset --epochs 20

# This generates:
#   tablet_classifier.pth
#   classes.json

# Then restart backend and click "Reload Model" above`}
      </pre>

      <details style={{marginTop: '12px'}}>
        <summary className="small">How it works</summary>
        <ul className="small" style={{marginTop: 8, paddingLeft: 20, lineHeight: 1.8}}>
          <li>Collect: saves images to <code>dataset/Tablet__MM-YYYY/</code></li>
          <li>Train: MobileNetV2 fine-tunes on your classes</li>
          <li>Identify: predicts tablet + expiry + VALID/EXPIRED/EXPIRES SOON</li>
          <li>No YOLO, no OCR - pure image classification</li>
        </ul>
      </details>
    </div>
  )
}