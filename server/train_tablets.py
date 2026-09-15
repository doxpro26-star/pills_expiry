"""
Train tablet + expiry classifier (NO YOLO, NO OCR).
You give tablet name + expiry while collecting, model predicts both.

Dataset structure (folder name = Tablet__MM-YYYY):
  dataset/
    Crocin__12-2025/
      img001.jpg
      img002.jpg
    Aspirin__06-2026/
      img001.jpg
    Paracetamol__01-2024/
      img001.jpg

Collect via server UI (http://localhost:5000 -> Collect section)
or manually: save ESP32 captures (http://192.168.4.1/capture) into those folders.

Train:
  pip install torch torchvision pillow numpy
  python train_tablets.py --data dataset --epochs 20

Output:
  tablet_classifier.pth + classes.json (auto-loaded by app.py)
"""
import argparse
import json
import os
import random
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import DataLoader, random_split
from torchvision import datasets, models, transforms


def get_loaders(data_dir, batch_size=16, img_size=224):
    train_tf = transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.RandomHorizontalFlip(),
        transforms.RandomRotation(15),
        transforms.ColorJitter(brightness=0.3, contrast=0.3, saturation=0.2),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    val_tf = transforms.Compose([
        transforms.Resize((img_size, img_size)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])

    full = datasets.ImageFolder(data_dir, transform=train_tf)
    if len(full.classes) < 2:
        raise SystemExit(f"Need >=2 classes in {data_dir}. Found: {full.classes}\n"
                         "Create folders like dataset/Crocin__12-2025/ with images inside.")

    # 80/20 split (val uses same transform - fine for this use case)
    n_val = max(1, int(len(full) * 0.2))
    n_train = len(full) - n_val
    gen = torch.Generator().manual_seed(42)
    train_ds, val_ds = random_split(full, [n_train, n_val], generator=gen)
    # val should use val transform: wrap dataset
    val_ds.dataset.transform = val_tf  # NOTE: shares full dataset; acceptable for small project

    train_loader = DataLoader(train_ds, batch_size=batch_size, shuffle=True, num_workers=0)
    val_loader = DataLoader(val_ds, batch_size=batch_size, shuffle=False, num_workers=0)
    return full, train_loader, val_loader


def build_model(num_classes):
    try:
        weights = models.MobileNet_V2_Weights.IMAGENET1K_V1
        m = models.mobilenet_v2(weights=weights)
    except Exception:
        m = models.mobilenet_v2(pretrained=True)
    m.classifier[1] = nn.Linear(m.last_channel, num_classes)
    return m


def train(data="dataset", epochs=20, batch_size=16, lr=0.001):
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    full, train_loader, val_loader = get_loaders(data, batch_size)
    print(f"Classes ({len(full.classes)}): {full.classes}")
    print(f"Train: {len(train_loader.dataset)} | Val: {len(val_loader.dataset)}")

    model = build_model(len(full.classes)).to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    scheduler = torch.optim.lr_scheduler.StepLR(optimizer, step_size=7, gamma=0.1)

    best_acc = 0.0
    for epoch in range(epochs):
        model.train()
        running = 0.0
        for imgs, labels in train_loader:
            imgs, labels = imgs.to(device), labels.to(device)
            optimizer.zero_grad()
            out = model(imgs)
            loss = criterion(out, labels)
            loss.backward()
            optimizer.step()
            running += loss.item()
        scheduler.step()

        # val
        model.eval()
        correct = total = 0
        with torch.no_grad():
            for imgs, labels in val_loader:
                imgs, labels = imgs.to(device), labels.to(device)
                out = model(imgs)
                _, pred = out.max(1)
                total += labels.size(0)
                correct += (pred == labels).sum().item()
        acc = 100.0 * correct / max(1, total)
        print(f"Epoch {epoch+1}/{epochs} loss={running/max(1,len(train_loader)):.3f} val_acc={acc:.1f}%")
        if acc >= best_acc:
            best_acc = acc
            torch.save(model.state_dict(), "tablet_classifier.pth")
            with open("classes.json", "w") as f:
                json.dump({"classes": full.classes}, f, indent=2)
            print(f"  -> saved tablet_classifier.pth + classes.json (acc {acc:.1f}%)")

    print(f"Done. Best val {best_acc:.1f}%. Files: tablet_classifier.pth, classes.json")
    print("Restart app.py - it will auto-load the model.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="dataset")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch_size", type=int, default=16)
    ap.add_argument("--lr", type=float, default=0.001)
    args = ap.parse_args()
    if not os.path.isdir(args.data):
        raise SystemExit(f"Dataset folder not found: {args.data}\n"
                         "Create e.g. dataset/Crocin__12-2025/ and put images inside.")
    train(args.data, args.epochs, args.batch_size, args.lr)
