// Tiny synthesized sounds so the app needs no audio files.
import { getSetting } from './store.js';

let ctx = null;

function audio() {
  if (!getSetting('sound')) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// iOS only allows audio after a user gesture; warm the context up on first touch.
export function unlockAudio() {
  const once = () => {
    audio();
    window.removeEventListener('pointerdown', once, true);
  };
  window.addEventListener('pointerdown', once, true);
}

// A short filtered noise burst plus a low body: sounds like a piece set on wood.
function knock(freq, gain, decay) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const len = Math.floor(c.sampleRate * decay);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 4;
  const src = c.createBufferSource();
  src.buffer = buf;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = 2.5;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(band).connect(g).connect(c.destination);
  src.start(t);

  const body = c.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(freq / 6, t);
  body.frequency.exponentialRampToValueAtTime(freq / 10, t + decay);
  const bg = c.createGain();
  bg.gain.setValueAtTime(gain * 0.5, t);
  bg.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  body.connect(bg).connect(c.destination);
  body.start(t);
  body.stop(t + decay);
}

function tone(freq, start, dur, gain, type = 'sine') {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + start;
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sound = {
  move: () => knock(1900, 0.9, 0.07),
  capture: () => knock(1300, 1.3, 0.1),
  wrong: () => { tone(196, 0, 0.16, 0.12, 'triangle'); tone(185, 0.12, 0.2, 0.1, 'triangle'); },
  done: () => { tone(659, 0, 0.18, 0.08); tone(988, 0.1, 0.3, 0.07); },
};
