#include "esp_camera.h"
#include <WiFi.h>
#include <WebServer.h>

// ====== Hotspot Configuration ======
const char* ssid = "ESP32-CAM_AP";
const char* password = "12345678"; // min 8 chars, leave "" for open hotspot

// ====== AI-Thinker ESP32-CAM Pins ======
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define LED_FLASH_PIN      4  // Flash LED

WebServer server(80);

// HTML Page for monitoring
const char index_html[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ESP32-CAM Monitor</title>
<style>
 body{font-family:Arial;text-align:center;margin:0;background:#111;color:#fff}
 h2{background:#1a73e8;margin:0;padding:12px}
 #stream{width:100%;max-width:800px;border-radius:8px;margin-top:10px;background:#000}
 .btn{padding:10px 18px;margin:8px;font-size:16px;border:0;border-radius:6px;cursor:pointer}
 .on{background:#1a73e8;color:#fff} .off{background:#333;color:#fff}
 .row{margin:10px}
 small{color:#aaa}
</style>
</head>
<body>
<h2>ESP32-CAM 20+FPS Monitor</h2>
<img id="stream" src="/stream" />
<div class="row">
  <button class="btn on" onclick="fetch('/flash?state=on')">Flash ON</button>
  <button class="btn off" onclick="fetch('/flash?state=off')">Flash OFF</button>
  <button class="btn on" onclick="window.open('/capture','_blank')">Capture HD Photo (1600x1200)</button>
</div>
<div class="row">
  <button class="btn off" onclick="fetch('/res?val=10')">HD 800x600 (25fps)</button>
  <button class="btn off" onclick="fetch('/res?val=9')">XGA 1024x768 (~18fps)</button>
  <button class="btn off" onclick="fetch('/res?val=13')">UXGA 1600x1200 (~8fps)</button>
</div>
<p>Hotspot: ESP32-CAM_AP | IP: 192.168.4.1 | <small>Stream: SVGA | Photo: UXGA</small></p>
<p><a style="color:#8ab4f8" href="/stream">/stream</a> | <a style="color:#8ab4f8" href="/capture">/capture</a></p>
</body>
</html>
)rawliteral";

void handleCors() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
}

void handleRoot() {
  handleCors();
  server.send_P(200, "text/html", index_html);
}

void handleStatus() {
  handleCors();
  String json = "{";
  json += "\"ssid\":\"" + String(ssid) + "\",";
  json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\",";
  json += "\"clients\":" + String(WiFi.softAPgetStationNum()) + ",";
  sensor_t * s = esp_camera_sensor_get();
  framesize_t fs = s ? s->status.framesize : FRAMESIZE_SVGA;
  json += "\"framesize\":" + String((int)fs) + ",";
  json += "\"psram\":" + String(psramFound() ? "true" : "false");
  json += "}";
  server.send(200, "application/json", json);
}

void handleCapture() {
  handleCors();
  // Take HIGH-RES photo (UXGA) even though stream is SVGA for speed
  sensor_t * s = esp_camera_sensor_get();
  bool switched = false;
  if (s && psramFound()) {
    s->set_framesize(s, FRAMESIZE_UXGA); // switch to 1600x1200 for photo
    delay(300); // let sensor settle
    switched = true;
  }
  camera_fb_t * fb = esp_camera_fb_get();
  if (!fb) {
    if (switched) { s->set_framesize(s, FRAMESIZE_SVGA); delay(100); }
    server.send(500, "text/plain", "Camera capture failed");
    return;
  }
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Content-Disposition", "inline; filename=capture.jpg");
  server.setContentLength(fb->len);
  server.send(200, "image/jpeg", "");
  WiFiClient client = server.client();
  client.write(fb->buf, fb->len);
  esp_camera_fb_return(fb);
  // Switch back to fast streaming resolution
  if (switched) {
    s->set_framesize(s, FRAMESIZE_SVGA);
    delay(100);
  }
}

void handleStream() {
  WiFiClient client = server.client();
  String response = "HTTP/1.1 200 OK\r\n";
  response += "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n";
  server.sendContent(response);

  while (client.connected()) {
    camera_fb_t * fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Camera capture failed");
      continue;
    }

    response = "--frame\r\n";
    response += "Content-Type: image/jpeg\r\n";
    response += "Content-Length: " + String(fb->len) + "\r\n\r\n";
    server.sendContent(response);
    client.write(fb->buf, fb->len);
    server.sendContent("\r\n");

    esp_camera_fb_return(fb);

    if (!client.connected()) break;
    delay(30); // SVGA optimized for 20-25 fps (use 1-10 for max speed)
  }
}

void handleFlash() {
  handleCors();
  String state = server.arg("state");
  if (state == "on") {
    digitalWrite(LED_FLASH_PIN, HIGH);
    server.send(200, "text/plain", "Flash ON");
  } else {
    digitalWrite(LED_FLASH_PIN, LOW);
    server.send(200, "text/plain", "Flash OFF");
  }
}

void handleResolution() {
  handleCors();
  if (!server.hasArg("val")) {
    server.send(400, "text/plain", "Missing val");
    return;
  }
  int val = server.arg("val").toInt();
  sensor_t * s = esp_camera_sensor_get();
  if (s) {
    // val matches framesize enum: 5=QVGA 6=CIF 8=VGA 9=XGA 10=SVGA 12=SXGA 13=UXGA
    if (s->set_framesize(s, (framesize_t)val) == 0) {
      server.send(200, "text/plain", "Resolution set to " + String(val));
      Serial.printf("Resolution changed to %d\n", val);
      return;
    }
  }
  server.send(500, "text/plain", "Failed");
}

void initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  // BALANCED FOR 20+ FPS: SVGA 800x600 streams at ~25fps, photo still at UXGA 1600x1200
  config.frame_size = FRAMESIZE_SVGA; // 800x600 for 20+ fps
  config.jpeg_quality = 12; // 10=best quality but slower, 12=high quality + fast, 15=fastest
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_SVGA; // 800x600 -> 22-25 fps
    // For 20fps with slightly higher res use FRAMESIZE_XGA (1024x768) ~18-22 fps
    // For max quality but low fps use FRAMESIZE_UXGA (1600x1200) ~6-10 fps
    config.jpeg_quality = 12;
    config.fb_count = 2;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size = FRAMESIZE_VGA; // 640x480 fallback - no PSRAM can't do SVGA at high fps
    config.jpeg_quality = 12;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.fb_count = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed 0x%x\n", err);
    delay(1000);
    ESP.restart();
  }

  // Tuning for 20+ FPS
  sensor_t * s = esp_camera_sensor_get();
  if (s) {
    s->set_brightness(s, 0);
    s->set_contrast(s, 0);
    s->set_saturation(s, 0);
    s->set_framesize(s, FRAMESIZE_SVGA); // Stream at SVGA for speed
    // s->set_vflip(s, 1); // uncomment if image is upside down
    // s->set_hmirror(s, 1);
  }
  Serial.printf("Camera initialized: %s | PSRAM: %s | Target 20+ FPS\n", 
    psramFound() ? "SVGA 800x600 (25fps) + UXGA photo" : "VGA 640x480", psramFound() ? "YES" : "NO");
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  pinMode(LED_FLASH_PIN, OUTPUT);
  digitalWrite(LED_FLASH_PIN, LOW);

  initCamera();

  // Create Hotspot (Access Point)
  WiFi.mode(WIFI_AP);
  WiFi.softAP(ssid, password, 1, 0, 4); // channel 1, max 4 clients

  IPAddress IP = WiFi.softAPIP();
  Serial.print("Hotspot Created: ");
  Serial.println(ssid);
  Serial.print("Password: ");
  Serial.println(password);
  Serial.print("Connect and open http://");
  Serial.println(IP);
  Serial.println("Stream URL: http://" + IP.toString() + "/stream");

  server.on("/", handleRoot);
  server.on("/capture", HTTP_GET, handleCapture);
  server.on("/capture", HTTP_OPTIONS, [](){ handleCors(); server.send(200,"text/plain",""); });
  server.on("/stream", handleStream);
  server.on("/flash", handleFlash);
  server.on("/res", handleResolution);
  server.on("/status", handleStatus);
  server.onNotFound(handleRoot);

  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  server.handleClient();
}
