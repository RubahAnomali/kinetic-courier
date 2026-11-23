import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  return [c, g];
}

function tex(c: HTMLCanvasElement, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Board-formed concrete: formwork seams, tie-holes, stains and grain. Tiles seamlessly enough at 8 m. */
export function concreteTexture(base: string): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  let s = 11;
  const rnd = (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(40,34,28,0.08)' : 'rgba(255,248,235,0.09)';
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  for (let i = 0; i < 6; i++) {
    const x = rnd() * 256;
    const grad = g.createLinearGradient(x, 0, x + 18, 256);
    grad.addColorStop(0, 'rgba(60,50,40,0)');
    grad.addColorStop(0.5, 'rgba(60,50,40,0.10)');
    grad.addColorStop(1, 'rgba(60,50,40,0)');
    g.fillStyle = grad;
    g.fillRect(x, 0, 18, 256);
  }
  g.fillStyle = 'rgba(30,26,22,0.28)';
  for (let y = 0; y < 256; y += 64) g.fillRect(0, y, 256, 2);
  g.fillStyle = 'rgba(30,26,22,0.35)';
  for (let y = 32; y < 256; y += 64) {
    for (let x = 32; x < 256; x += 128) {
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    }
  }
  return tex(c);
}

/** Boost pad: dark slab with safety-orange chevrons. */
export function padTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#23201c';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#ff5b14';
  g.lineWidth = 14;
  g.lineJoin = 'miter';
  for (let i = 0; i < 3; i++) {
    const y = 20 + i * 36;
    g.beginPath();
    g.moveTo(24, y + 22);
    g.lineTo(64, y);
    g.lineTo(104, y + 22);
    g.stroke();
  }
  return tex(c, false);
}

/** Warm dusk gradient used as the scene background (flat, painterly: no sun disc, no bloom). */
export function skyTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(8, 512);
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#6f86a0');
  grad.addColorStop(0.5, '#b9bcc0');
  grad.addColorStop(0.78, '#eac9a4');
  grad.addColorStop(1, '#f0d3ac');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 512);
  return tex(c, false);
}

export function hazardTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = '#ff5b14';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#1b1a18';
  for (let i = -2; i < 6; i++) {
    g.beginPath();
    g.moveTo(i * 16, 64);
    g.lineTo(i * 16 + 16, 64);
    g.lineTo(i * 16 + 48, 0);
    g.lineTo(i * 16 + 32, 0);
    g.fill();
  }
  return tex(c);
}
