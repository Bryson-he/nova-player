// @ts-check
'use strict';
// Windows taskbar: previous / play-pause / next buttons on the thumbnail,
// playback progress on the icon, and a "Continue watching" jump list.
const { app, nativeImage } = require('electron');

const SIZE = 16;
const ITEM_ID = /^[0-9a-f]{32}$/i;

/**
 * A 16 px white icon drawn from polygons (thumbnail buttons need bitmaps).
 * @param {number[][][]} polys  points in 0..16 space
 */
function drawIcon(polys) {
  const scale = 4; // supersample for smooth edges
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const inside = (x, y, poly) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let cover = 0;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = px + (sx + 0.5) / scale;
          const y = py + (sy + 0.5) / scale;
          if (polys.some((p) => inside(x, y, p))) cover++;
        }
      }
      const a = Math.round((cover / (scale * scale)) * 255);
      const o = (py * SIZE + px) * 4;
      buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = a; // BGRA, white
    }
  }
  return nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE });
}

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
let icons = null;
function getIcons() {
  icons ??= {
    play: drawIcon([[[4, 2], [14, 8], [4, 14]]]),
    pause: drawIcon([rect(3, 2, 4, 12), rect(9, 2, 4, 12)]),
    prev: drawIcon([rect(2, 2, 2.5, 12), [[14, 2], [5, 8], [14, 14]]]),
    next: drawIcon([[[2, 2], [11, 8], [2, 14]], rect(11.5, 2, 2.5, 12)]),
  };
  return icons;
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {{ playing: boolean, progress: number, hasPrev?: boolean, hasNext?: boolean } | null} state
 */
function setTaskbarState(win, state) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  if (!state) {
    win.setThumbarButtons([]);
    win.setProgressBar(-1);
    return;
  }
  const i = getIcons();
  const send = (action) => () => win.webContents.send('taskbar:action', action);
  win.setThumbarButtons([
    { tooltip: 'Previous episode', icon: i.prev, click: send('prev'), flags: state.hasPrev ? [] : ['disabled'] },
    { tooltip: state.playing ? 'Pause' : 'Play', icon: state.playing ? i.pause : i.play, click: send('toggle') },
    { tooltip: 'Next episode', icon: i.next, click: send('next'), flags: state.hasNext ? [] : ['disabled'] },
  ]);
  const p = Math.min(1, Math.max(0, state.progress));
  win.setProgressBar(p > 0 ? p : -1, { mode: state.playing ? 'normal' : 'paused' });
}

// Jump list entries relaunch Nova with --nova-play=<item id>.
function setContinueWatching(items) {
  if (process.platform !== 'win32') return;
  const base = app.isPackaged ? [] : [`"${app.getAppPath()}"`];
  try {
    app.setJumpList(items.length ? [{
      type: 'custom',
      name: 'Continue watching',
      items: items.filter((it) => ITEM_ID.test(it.id)).map((it) => ({
        type: 'task',
        title: it.title.slice(0, 200),
        description: `Play ${it.title.slice(0, 200)}`,
        program: process.execPath,
        args: [...base, `--nova-play=${it.id}`].join(' '),
        iconPath: process.execPath,
        iconIndex: 0,
      })),
    }] : null);
  } catch (err) {
    console.error('Jump list', err);
  }
}

/** @param {string[]} argv */
function playArg(argv) {
  const arg = argv.find((a) => a.startsWith('--nova-play='));
  const id = arg?.slice('--nova-play='.length);
  return id && ITEM_ID.test(id) ? id : null;
}

module.exports = { setTaskbarState, setContinueWatching, playArg };
