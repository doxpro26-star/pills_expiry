# ESP32-CAM Hotspot + Tablet + Expiry Predictor (no YOLO)

## Structure
```
D:\esp32cam\ESP32CAM_Hotspot\ESP32CAM_Hotspot.ino  -> ESP32-CAM firmware (hotspot 192.168.4.1, 20+fps SVGA, UXGA photo)
D:\esp32cam\server\app.py                          -> Collect (tablet+expiry) + Identify tablet+expiry
D:\esp32cam\server\train_tablets.py                -> Train MobileNetV2 on dataset/Tablet__MM-YYYY/
```

## 1. Upload ESP32-CAM
- Board: AI Thinker ESP32-CAM, Huge APP, PSRAM Enabled
- Upload `ESP32CAM_Hotspot.ino`
- Serial 115200 shows `Hotspot Created: ESP32-CAM_AP / 192.168.4.1`

## 2. Run Server (PC/Laptop connected to ESP32-CAM_AP)
```bash
cd D:\esp32cam\server
pip install -r requirements.txt
python app.py
```
- Connect PC to WiFi `ESP32-CAM_AP` pass `12345678`
- Open `http://localhost:5000` or `http://192.168.4.x:5000`

## 3. Workflow (Collect → Train → Identify)
**Step 1 - Collect:** Enter tablet name + expiry (MM-YYYY) → click "Capture from ESP32 & Save" → images saved to `dataset/Tablet__MM-YYYY/` (30-50 per class)
**Step 2 - Train:** `python train_tablets.py --data dataset --epochs 20` → generates `tablet_classifier.pth` + `classes.json`
**Step 3 - Identify:** Click "Identify from ESP32" → predicts tablet name + expiry + VALID/EXPIRED/EXPIRES SOON

## Endpoints
- ESP32: `http://192.168.4.1/` stream, `/capture` HD photo, `/status`, `/flash`
- Server: `/collect` (save with label), `/identify` (predict), `/health`, `/proxy/stream`, `/reload_model`
