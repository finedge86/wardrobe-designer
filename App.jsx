import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import * as THREE from "three";
import { svgsToPdf, jpegFromFile, downloadBlob } from "./pdf.js";
import * as cloud from "./cloud.js";
import { FINE_EDGE_LOGO } from "./logo.js";

/* ────────────────────────────────────────────────────────────
   FINE EDGE — On-site Wardrobe Designer (prototype)
   All dimensions in millimetres.
   ──────────────────────────────────────────────────────────── */

const T = 18;
const MAX_BAY = 1000;
const DRAWER_H = 200;
const MIN_COMP = 150;
const MIN_OPEN = 200;
const MIN_CNR_OPEN = 300; // corner must clear the return by this much to be usable
const MIN_HANG = 350;     // shortest useful drop under a rail

const FINISHES = [
  { id: "oak",      name: "Light oak",  base: "#c9a069", grain: "#a87f47" },
  { id: "walnut",   name: "Walnut",     base: "#7d5334", grain: "#5c3a22" },
  { id: "white",    name: "Matt white", base: "#e8e4dc", grain: "#d3cec4" },
  { id: "graphite", name: "Graphite",   base: "#4a4d52", grain: "#3a3d42" },
];

const HANG = [
  { id: "none",   label: "None" },
  { id: "single", label: "1 rail" },
  { id: "double", label: "2 rails" },
];

const PRESETS = [
  { id: "long",   name: "Long hang",   cfg: { hang: "single", shelves: 0, drawers: 0, topShelf: true,  topShelfH: null, railH: [] } },
  { id: "double", name: "Double hang", cfg: { hang: "double", shelves: 1, drawers: 0, topShelf: true,  topShelfH: null, railH: [] } },
  { id: "shelf",  name: "Shelves",     cfg: { hang: "none",   shelves: 5, drawers: 0, topShelf: false, topShelfH: null, railH: [] } },
  { id: "drawer", name: "Drawer bank", cfg: { hang: "single", shelves: 0, drawers: 4, topShelf: true,  topShelfH: null, railH: [] } },
];

const defaultBay = () => ({ hang: "single", shelves: 0, drawers: 0, topShelf: true, topShelfH: null, railH: [] });
const defaultCorner = () => ({ hang: "none", shelves: 4, drawers: 0, topShelf: false, topShelfH: null, railH: [] });

const maxDrawers = (IH) => Math.max(0, Math.min(8, Math.floor((IH - 400) / DRAWER_H)));
const maxShelves = (IH, drawers) => {
  const rem = IH - (drawers > 0 ? drawers * DRAWER_H + T : 0);
  return Math.max(0, Math.min(9, Math.floor((rem + T) / (MIN_COMP + T)) - 1));
};

/* ── internals ─────────────────────────────────────────────── */

function bayInternals(bay, IH, y0) {
  const shelves = [], rails = [], drawers = [];
  const dq = Math.min(bay.drawers, maxDrawers(IH));
  const sq = Math.min(bay.shelves, maxShelves(IH, dq));

  let y = y0;
  if (dq > 0) {
    for (let i = 0; i < dq; i++) drawers.push({ y: y + i * DRAWER_H, h: DRAWER_H });
    y += dq * DRAWER_H;
    shelves.push(y);
    y += T;
  }

  const yBase = y;
  const yTop = y0 + IH;

  /* optional shelf capping the hanging section — the grid below stops at it */
  let gridTop = yTop, topShelfY = null, topShelfAuto = true;
  const tMin = yBase + MIN_HANG + 55 + T;
  const tMax = yTop - 150 - T;
  if (bay.topShelf && tMin < tMax) {
    const u = bay.topShelfH;
    topShelfAuto = typeof u !== "number";
    topShelfY = Math.max(tMin, Math.min(tMax, topShelfAuto ? yTop - 400 - T : u));
    shelves.push(topShelfY);
    gridTop = topShelfY;
  }

  const rem = gridTop - y;
  const n = sq + 1;
  const compH = (rem - sq * T) / n;
  const tops = [];
  for (let i = 0; i < n; i++) {
    const top = y + (i + 1) * compH + i * T;
    tops.push(top);
    if (i < n - 1) shelves.push(top);
  }

  /* rails hang off the side panels, so they float free of the shelf grid */
  const rMin = yBase + MIN_HANG;
  const rMax = gridTop - 40;
  const surfaces = [yBase, ...shelves.map((s) => s + T)];
  const hangCount = bay.hang === "double" ? 2 : bay.hang === "single" ? 1 : 0;

  for (let k = 0; k < hangCount && k < n; k++) {
    const auto = tops[n - 1 - k] - 55;
    const u = bay.railH?.[k];
    const fixed = typeof u === "number";
    const ry = Math.max(rMin, Math.min(rMax, fixed ? u : auto));
    const below = surfaces.filter((s) => s <= ry - MIN_HANG);
    const base = below.length ? Math.max(...below) : yBase;
    rails.push({ y: ry, h: Math.max(MIN_HANG, ry - base), auto: !fixed });
  }
  return { shelves, rails, drawers, compH, dq, sq, rMin, rMax, topShelfY, topShelfAuto, tMin, tMax };
}

/* ── model ─────────────────────────────────────────────────── */

function buildModel(cfg, runCfg = {}, bayW = {}) {
  const D = cfg.D;
  const C = Math.max(cfg.cornerW, D + MIN_CNR_OPEN);
  const baseH = cfg.baseH;
  const carcassH = cfg.H - baseH;
  const IH = carcassH - 2 * T;
  const y0 = baseH + T;

  /* corner units — L-shaped in plan, C long on each run, D deep, fronts flush */
  let corners = [];
  let defs = [];

  if (cfg.shape === "straight") {
    defs = [{ id: "A", label: "Run A", length: cfg.wA, axis: "x", origin: [0, 0], face: "+z", c0: null, c1: null }];
  } else if (cfg.shape === "L") {
    corners = [{ key: "CNR", label: "Corner unit", ax: 0, az: 0, sx: 1 }];
    defs = [
      { id: "A", label: "Run A — back",   length: cfg.wA, axis: "x", origin: [0, 0], face: "+z", c0: "CNR", c1: null },
      { id: "B", label: "Run B — return", length: cfg.wB, axis: "z", origin: [0, 0], face: "+x", c0: "CNR", c1: null },
    ];
  } else {
    corners = [
      { key: "CNRL", label: "Left corner",  ax: 0,      az: 0, sx: 1 },
      { key: "CNRR", label: "Right corner", ax: cfg.wA, az: 0, sx: -1 },
    ];
    defs = [
      { id: "A", label: "Run A — back",  length: cfg.wA, axis: "x", origin: [0, 0],          face: "+z", c0: "CNRL", c1: "CNRR" },
      { id: "B", label: "Run B — left",  length: cfg.wB, axis: "z", origin: [0, 0],          face: "+x", c0: "CNRL", c1: null },
      { id: "C", label: "Run C — right", length: cfg.wC, axis: "z", origin: [cfg.wA - D, 0], face: "-x", c0: "CNRR", c1: null },
    ];
  }

  const runs = defs.map((r) => {
    const c0 = r.c0 ? C : 0;
    const c1 = r.c1 ? C : 0;
    const clear = r.length - c0 - c1;
    const rc = runCfg[r.id] || {};
    let n = 0, bays = [], panels = [], adjusted = false;
    const maxN = Math.max(1, Math.floor((clear - T) / (MIN_OPEN + T)));

    if (clear >= MIN_OPEN + 2 * T) {
      const auto = Math.min(maxN, Math.max(1, Math.ceil(clear / MAX_BAY)));
      n = Math.min(maxN, Math.max(1, rc.count ?? auto));

      const target = clear - (n + 1) * T;
      const keys = [];
      for (let i = 0; i < n; i++) keys.push(`${r.id}${i + 1}`);
      const locked = keys.map((k) => (typeof bayW[k] === "number" ? bayW[k] : null));
      const fixedSum = locked.reduce((a, w) => a + (w || 0), 0);
      const autoN = locked.filter((w) => w == null).length;

      let autoW = 0, scale = 1;
      if (autoN > 0) {
        autoW = (target - fixedSum) / autoN;
        if (autoW < MIN_OPEN) {
          autoW = MIN_OPEN;
          scale = fixedSum > 0 ? Math.max(0, target - MIN_OPEN * autoN) / fixedSum : 1;
          adjusted = true;
        }
      } else if (fixedSum > 0) {
        scale = target / fixedSum;
        if (Math.abs(scale - 1) > 0.002) adjusted = true;
      }

      let cur = c0;
      for (let i = 0; i < n; i++) {
        panels.push(cur);
        cur += T;
        const w = locked[i] != null ? locked[i] * scale : autoW;
        bays.push({ start: cur, w, key: keys[i], locked: locked[i] != null });
        cur += w;
      }
      panels.push(cur);
    }
    return { ...r, c0len: c0, c1len: c1, clear, n, maxN, bays, panels, adjusted };
  });

  return { runs, corners, C, D, baseH, carcassH, IH, y0 };
}

function cutList(model, cfg, bayCfg) {
  const rows = new Map();
  const add = (part, w, h, qty = 1) => {
    if (w <= 0 || h <= 0 || qty <= 0) return;
    const k = `${part}|${Math.round(w)}|${Math.round(h)}`;
    rows.set(k, { part, w: Math.round(w), h: Math.round(h), qty: (rows.get(k)?.qty || 0) + qty });
  };
  const { runs, corners, C, D, baseH, carcassH, IH, y0 } = model;

  for (const r of runs) {
    if (r.panels.length) add("Vertical panel", D, carcassH, r.panels.length);
    add("Base rail", r.length, baseH, 2);
    for (const b of r.bays) {
      const bay = bayCfg[b.key] || defaultBay();
      add("Top / bottom", b.w, D, 2);
      add("Back panel", b.w, carcassH, 1);
      const { shelves, drawers, rails } = bayInternals(bay, IH, y0);
      add("Shelf", b.w, D - 20, shelves.length);
      add("Hanging rail", b.w - 40, 25, rails.length);
      if (drawers.length) {
        add("Drawer front", b.w - 6, DRAWER_H - 6, drawers.length);
        add("Drawer box side", D - 60, 150, drawers.length * 2);
        add("Drawer base", b.w - 60, D - 90, drawers.length);
      }
      if (cfg.doors) {
        const leaves = b.w > 600 ? 2 : 1;
        add("Door", b.w / leaves - 4, carcassH - 4, leaves);
      }
    }
  }

  for (const c of corners) {
    const bay = bayCfg[c.key] || defaultCorner();
    const { shelves, drawers, rails } = bayInternals(bay, IH, y0);
    add("Corner back panel", C, carcassH, 2);
    add("Corner base rail", C, baseH, 2);
    add("Corner board — leg A", C - T, D - T, shelves.length + 2);
    if (C - D > 1) add("Corner board — leg B", D - T, C - D, shelves.length + 2);
    add("Hanging rail", C - 40, 25, rails.length);
    if (drawers.length) {
      add("Drawer front", C - 6, DRAWER_H - 6, drawers.length);
      add("Drawer box side", D - 60, 150, drawers.length * 2);
    }
  }
  return [...rows.values()].sort((a, b) => a.part.localeCompare(b.part) || b.h - a.h);
}

/* ── wood texture ──────────────────────────────────────────── */

function makeWood(finish) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = finish.base;
  x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    const y = Math.random() * 256;
    x.strokeStyle = finish.grain;
    x.globalAlpha = 0.06 + Math.random() * 0.16;
    x.lineWidth = 0.4 + Math.random() * 1.8;
    x.beginPath();
    x.moveTo(0, y);
    for (let px = 0; px <= 256; px += 16) x.lineTo(px, y + Math.sin((px + i * 30) / 42) * 2.2);
    x.stroke();
  }
  x.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* ── 3D viewport ───────────────────────────────────────────── */

function Viewport3D({ cfg, model, bayCfg, finish, fitToken }) {
  const host = useRef(null);
  const state = useRef({});

  useEffect(() => {
    const el = host.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#101216");
    const cam = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    const key = new THREE.DirectionalLight(0xfff3e2, 0.85);
    key.position.set(4, 6, 5); scene.add(key);
    const fill = new THREE.DirectionalLight(0xc9dcff, 0.34);
    fill.position.set(-5, 3, 2); scene.add(fill);

    const orbit = { theta: 0.72, phi: 1.18, r: 8, target: new THREE.Vector3() };
    state.current = { scene, cam, renderer, orbit, el };

    const apply = () => {
      const { theta, phi, r, target } = orbit;
      cam.position.set(
        target.x + r * Math.sin(phi) * Math.sin(theta),
        target.y + r * Math.cos(phi),
        target.z + r * Math.sin(phi) * Math.cos(theta)
      );
      cam.lookAt(target);
    };

    const fitView = () => {
      const f = state.current.fitData;
      if (!f) return;
      const vFov = (cam.fov * Math.PI) / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.3, cam.aspect));
      const dist = f.radius / Math.sin(Math.min(vFov, hFov) / 2);
      orbit.target.copy(f.center);
      orbit.r = Math.max(0.8, dist * 1.1);
      state.current.baseR = orbit.r;
      state.current.userZoomed = false;
      apply();
    };
    state.current.fitView = fitView;

    const resetAngles = () => {
      const p = state.current.anglePreset;
      if (!p) return;
      orbit.theta = p[0]; orbit.phi = p[1];
    };
    state.current.resetAngles = resetAngles;

    const zoom = (factor) => {
      const b = state.current.baseR || orbit.r;
      orbit.r = Math.max(b * 0.28, Math.min(b * 3, orbit.r * factor));
      state.current.userZoomed = true;
      apply();
    };

    let dragging = false, lx = 0, ly = 0, pinch = 0;
    const down = (e) => { dragging = true; lx = e.clientX; ly = e.clientY; el.setPointerCapture?.(e.pointerId); };
    const move = (e) => {
      if (!dragging) return;
      orbit.theta -= (e.clientX - lx) * 0.007;
      orbit.phi = Math.max(0.25, Math.min(1.52, orbit.phi - (e.clientY - ly) * 0.006));
      lx = e.clientX; ly = e.clientY; apply();
    };
    const up = () => { dragging = false; };
    const wheel = (e) => { e.preventDefault(); zoom(1 + e.deltaY * 0.0012); };
    const touch = (e) => {
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (pinch) zoom(pinch / d);
        pinch = d;
      }
    };
    const touchEnd = () => { pinch = 0; };

    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("touchmove", touch, { passive: true });
    el.addEventListener("touchend", touchEnd);

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      cam.aspect = w / h; cam.updateProjectionMatrix(); renderer.setSize(w, h, false);
      if (!state.current.userZoomed) fitView();
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    let raf;
    const loop = () => { renderer.render(scene, cam); raf = requestAnimationFrame(loop); };
    apply(); loop();
    state.current.apply = apply;

    return () => {
      cancelAnimationFrame(raf); ro.disconnect();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchmove", touch);
      el.removeEventListener("touchend", touchEnd);
      renderer.dispose();
      renderer.domElement.parentNode?.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const s = state.current;
    if (!s?.scene) return;
    const old = s.scene.getObjectByName("model");
    if (old) {
      old.traverse((o) => { o.geometry?.dispose?.(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
      s.scene.remove(old);
    }

    const g = new THREE.Group(); g.name = "model";
    const M = 0.001;
    const tex = makeWood(finish);
    const woodBase = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.72, metalness: 0.02 });
    const dark = new THREE.MeshStandardMaterial({ color: "#22252a", roughness: 0.9 });
    const metal = new THREE.MeshStandardMaterial({ color: "#b9bfc6", roughness: 0.35, metalness: 0.75 });
    const cloth = new THREE.MeshStandardMaterial({ color: "#5b8bc9", roughness: 0.95, transparent: true, opacity: 0.45 });
    const backMat = new THREE.MeshStandardMaterial({ color: finish.grain, roughness: 0.95 });

    const wood = (w, h) => {
      const m = woodBase.clone();
      m.map = tex.clone(); m.map.needsUpdate = true;
      m.map.repeat.set(Math.max(0.4, w / 700), Math.max(0.4, h / 700));
      return m;
    };

    const { runs, corners, C, D, baseH, carcassH, IH, y0 } = model;

    /* absolute box in world mm */
    const abs = (x0, x1, z0, z1, yC, h, mat) => {
      const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0);
      if (w < 0.5 || d < 0.5 || h < 0.5) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w * M, h * M, d * M), mat);
      mesh.position.set(((x0 + x1) / 2) * M, yC * M, ((z0 + z1) / 2) * M);
      g.add(mesh);
    };

    /* run-local: u along run, v across depth */
    const place = (r, u, v, uLen, vLen, h, mat, yC) => {
      let x0, x1, z0, z1;
      if (r.axis === "x") {
        x0 = r.origin[0] + u; x1 = x0 + uLen;
        z0 = r.origin[1] + v; z1 = z0 + vLen;
      } else {
        z0 = r.origin[1] + u; z1 = z0 + uLen;
        if (r.face === "+x") { x0 = r.origin[0] + v; x1 = x0 + vLen; }
        else { x0 = r.origin[0] + (D - v - vLen); x1 = x0 + vLen; }
      }
      abs(x0, x1, z0, z1, yC, h, mat);
    };

    /* ── runs ── */
    for (const r of runs) {
      place(r, 0, 60, r.length, D - 60, baseH, dark, baseH / 2);
      for (const p of r.panels) place(r, p, 0, T, D, carcassH, wood(D, carcassH), baseH + carcassH / 2);

      for (const b of r.bays) {
        place(r, b.start, 0, b.w, D, T, wood(b.w, D), baseH + T / 2);
        place(r, b.start, 0, b.w, D, T, wood(b.w, D), baseH + carcassH - T / 2);
        place(r, b.start, 0, b.w, T, carcassH, backMat, baseH + carcassH / 2);

        const bay = bayCfg[b.key] || defaultBay();
        const { shelves, rails, drawers } = bayInternals(bay, IH, y0);
        for (const sy of shelves) place(r, b.start, 8, b.w, D - 20, T, wood(b.w, D), sy + T / 2);

        for (const rail of rails) {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, b.w * M, 12), metal);
          m.rotation.z = Math.PI / 2;
          if (r.axis === "x") m.position.set((r.origin[0] + b.start + b.w / 2) * M, rail.y * M, (r.origin[1] + D / 2) * M);
          else { m.rotation.y = Math.PI / 2; m.position.set((r.origin[0] + D / 2) * M, rail.y * M, (r.origin[1] + b.start + b.w / 2) * M); }
          g.add(m);
          const ch = Math.min(rail.h - 30, 1000);
          place(r, b.start + 25, D / 2 - 90, b.w - 50, 180, ch, cloth, rail.y - ch / 2 - 20);
        }
        for (const d of drawers) place(r, b.start + 3, D - 20, b.w - 6, 18, d.h - 6, wood(b.w, d.h), d.y + d.h / 2);

        if (cfg.doors) {
          const leaves = b.w > 600 ? 2 : 1;
          const lw = b.w / leaves - 4;
          for (let i = 0; i < leaves; i++) {
            place(r, b.start + 2 + i * (b.w / leaves), D, lw, 18, carcassH - 6, wood(lw, carcassH), baseH + carcassH / 2);
          }
        }
      }
    }

    /* ── corner units: L-shaped in plan, flush fronts ── */
    for (const c of corners) {
      const sx = c.sx, ax = c.ax;
      const xC = ax + sx * C, xD = ax + sx * D, xT = ax + sx * T;
      const bay = bayCfg[c.key] || defaultCorner();
      const { shelves, rails, drawers } = bayInternals(bay, IH, y0);

      // plinth (both legs)
      abs(ax, xC, 60, D, baseH / 2, baseH, dark);
      if (C > D) abs(ax, xD, D, C, baseH / 2, baseH, dark);

      // back panels against both walls
      abs(ax, xC, 0, T, baseH + carcassH / 2, carcassH, backMat);
      abs(ax, xT, T, C, baseH + carcassH / 2, carcassH, backMat);

      // L-shaped boards: bottom, shelves, top
      const boards = [baseH + T / 2, ...shelves.map((y) => y + T / 2), baseH + carcassH - T / 2];
      for (const yC2 of boards) {
        abs(xT, xC, T, D, yC2, T, wood(C, D));
        if (C > D) abs(xT, xD, D, C, yC2, T, wood(D, C));
      }

      // rails along leg A
      for (const rail of rails) {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, (C - T) * M, 12), metal);
        m.rotation.z = Math.PI / 2;
        m.position.set(((xT + xC) / 2) * M, rail.y * M, (D / 2) * M);
        g.add(m);
        const ch = Math.min(rail.h - 30, 1000);
        abs(xT + sx * 25, xC - sx * 25, D / 2 - 90, D / 2 + 90, rail.y - ch / 2 - 20, ch, cloth);
      }
      // drawers on leg A face
      for (const d of drawers) {
        abs(xT, xC, D - 20, D - 2, d.y + d.h / 2, d.h - 6, wood(C, d.h));
      }
    }

    /* measure the cabinets only — before the floor is added, or the
       floor's extents drag the centre back toward the world origin */
    const bb = new THREE.Box3().setFromObject(g);
    const sphere = bb.getBoundingSphere(new THREE.Sphere());
    const ctr = new THREE.Vector3(); bb.getCenter(ctr);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: "#191c21", roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(ctr.x, 0, ctr.z);
    g.add(floor);
    s.scene.add(g);

    s.fitData = { center: sphere.center.clone(), radius: Math.max(0.4, sphere.radius) };
    /* look down the open diagonal so the corner interior is visible */
    s.anglePreset = { straight: [0.30, 1.14], L: [0.785, 0.98], U: [0.0, 1.02] }[cfg.shape];
    if (s.lastShape !== cfg.shape) { s.lastShape = cfg.shape; s.resetAngles?.(); }
    s.fitView?.();
  }, [cfg, model, bayCfg, finish]);

  useEffect(() => {
    if (fitToken) { state.current.resetAngles?.(); state.current.fitView?.(); }
  }, [fitToken]);

  return <div ref={host} className="fe-3d" />;
}

/* ── 2D drawing sheet ──────────────────────────────────────── */

function Sheet2D({ cfg, model, bayCfg, activeRun, activeBay, onPick, project, client, logo }) {
  const r = model.runs.find((x) => x.id === activeRun) || model.runs[0];
  const { carcassH, IH, y0, baseH, C } = model;
  const H = cfg.H;

  const SW = 297, SH = 210;
  const area = { x: 14, y: 12, w: 269, h: 142 };
  const sc = Math.min((area.w - 40) / r.length, (area.h - 38) / H);
  const ox = area.x + 30 + (area.w - 40 - r.length * sc) / 2;
  const oy = area.y + 16 + (area.h - 38 - H * sc) / 2 + H * sc;
  const X = (mm) => ox + mm * sc;
  const Y = (mm) => oy - mm * sc;

  /* sections along the run, in order */
  const sections = [];
  if (r.c0) sections.push({ kind: "corner", key: r.c0, start: 0, w: C, blind: "start" });
  r.bays.forEach((b) => sections.push({ kind: "bay", key: b.key, start: b.start, w: b.w, locked: b.locked }));
  if (r.c1) sections.push({ kind: "corner", key: r.c1, start: r.length - C, w: C, blind: "end" });

  /* width chain */
  const chain = [];
  if (r.c0) chain.push(C);
  for (let i = 0; i <= r.n && r.panels.length; i++) {
    chain.push(T);
    if (i < r.n) chain.push(r.bays[i].w);
  }
  if (r.c1) chain.push(C);

  /* height chain from the selected section (or first) */
  const ref = sections.find((s) => s.key === activeBay) || sections[0];
  const refCfg = bayCfg[ref.key] || (ref.kind === "corner" ? defaultCorner() : defaultBay());
  const refInt = bayInternals(refCfg, IH, y0);
  const hchain = [{ v: baseH }, { v: T }];
  let prev = y0;
  for (const sy of [...refInt.shelves].sort((a, b) => a - b)) {
    hchain.push({ v: sy - prev }); hchain.push({ v: T }); prev = sy + T;
  }
  hchain.push({ v: baseH + carcassH - T - prev }); hchain.push({ v: T });

  const dim = (x1, y1, x2, y2, text, vertical, k, tier = 0) => {
    const off = tier === 0 ? 1.2 : tier === 1 ? -3.9 : -7.6;
    const tx = vertical ? x1 - (tier === 0 ? 1.2 : tier === 1 ? 5.1 : 8.8) : (x1 + x2) / 2;
    const ty = vertical ? (y1 + y2) / 2 : y1 - off;
    return (
      <g key={k} className="dim">
        <line x1={x1} y1={y1} x2={x2} y2={y2} />
        <line x1={x1} y1={vertical ? y1 : y1 - 1.4} x2={x1} y2={vertical ? y1 : y1 + 1.4} />
        <line x1={x2} y1={vertical ? y2 : y2 - 1.4} x2={x2} y2={vertical ? y2 : y2 + 1.4} />
        <text x={tx} y={ty} transform={vertical ? `rotate(-90 ${tx} ${ty})` : undefined}>{text}</text>
      </g>
    );
  };

  let cx = 0, wTight = 0;
  const widthDims = chain.map((v, i) => {
    const tier = v * sc < 8 ? ((wTight++ % 2) + 1) : 0;
    const el = dim(X(cx), Y(0) + 10, X(cx + v), Y(0) + 10, Math.round(v), false, `w${i}`, tier);
    cx += v; return el;
  });
  let cy = 0, hTight = 0;
  const heightDims = hchain.map((seg, i) => {
    const tier = seg.v * sc < 8 ? ((hTight++ % 2) + 1) : 0;
    const el = dim(X(0) - 8, Y(cy), X(0) - 8, Y(cy + seg.v), Math.round(seg.v), true, `h${i}`, tier);
    cy += seg.v; return el;
  });

  const section = (s) => {
    const cfgS = bayCfg[s.key] || (s.kind === "corner" ? defaultCorner() : defaultBay());
    const { shelves, rails, drawers, dq, sq, topShelfY } = bayInternals(cfgS, IH, y0);
    const sel = s.key === activeBay;
    const isRef = s.key === ref.key;
    const isC = s.kind === "corner";
    return (
      <g key={s.key} className="bay" onClick={() => onPick(s.key)}>
        <rect x={X(s.start)} y={Y(baseH + carcassH)} width={s.w * sc} height={carcassH * sc}
              fill={sel ? "#f1ece0" : isC ? "#faf7f0" : "#fdfcf9"} stroke="#16181c" strokeWidth="0.3" />
        {isC && (() => {
          const bs = s.blind === "end" ? s.start + s.w - cfg.D : s.start;
          return (
            <g>
              <rect x={X(bs)} y={Y(baseH + carcassH)} width={cfg.D * sc} height={carcassH * sc}
                    fill="url(#hatch)" stroke="none" />
              <line x1={X(s.blind === "end" ? bs : bs + cfg.D)} y1={Y(baseH)}
                    x2={X(s.blind === "end" ? bs : bs + cfg.D)} y2={Y(baseH + carcassH)}
                    stroke="#c8342b" strokeWidth="0.3" strokeDasharray="2 1.5" />
              <text className="micro" x={X(bs + cfg.D / 2)} y={Y(baseH + carcassH / 2)} textAnchor="middle">RETURN</text>
            </g>
          );
        })()}
        <rect x={X(s.start)} y={Y(baseH + T)} width={s.w * sc} height={T * sc} fill="#c9c4b8" />
        <rect x={X(s.start)} y={Y(baseH + carcassH)} width={s.w * sc} height={T * sc} fill="#c9c4b8" />
        {shelves.map((sy, i) => (
          <rect key={i} x={X(s.start)} y={Y(sy + T)} width={s.w * sc} height={T * sc}
                fill="#c9c4b8" stroke="#16181c" strokeWidth="0.18" />
        ))}
        {topShelfY != null && isRef && (
          <text className="tag" x={X(s.start + 24)} y={Y(topShelfY + T) - 1.2}>TOP SHELF {Math.round(topShelfY)}</text>
        )}
        {rails.map((rl, i) => (
          <g key={i}>
            <line x1={X(s.start + 20)} y1={Y(rl.y)} x2={X(s.start + s.w - 20)} y2={Y(rl.y)} stroke="#16181c" strokeWidth="0.4" />
            <rect x={X(s.start + 30)} y={Y(rl.y)} width={(s.w - 60) * sc} height={Math.min(rl.h - 30, 1000) * sc}
                  fill="#5b8bc9" opacity="0.26" stroke="#5b8bc9" strokeWidth="0.2" />
            {isRef && <text className="tag" x={X(s.start + s.w - 24)} y={Y(rl.y) + 3.4} textAnchor="end">RAIL {Math.round(rl.y)}</text>}
          </g>
        ))}
        {drawers.map((d, i) => (
          <g key={i}>
            <rect x={X(s.start + 3)} y={Y(d.y + d.h - 3)} width={(s.w - 6) * sc} height={(d.h - 6) * sc}
                  fill="#e6e1d6" stroke="#16181c" strokeWidth="0.25" />
            <line x1={X(s.start + s.w * 0.35)} y1={Y(d.y + d.h * 0.5)} x2={X(s.start + s.w * 0.65)} y2={Y(d.y + d.h * 0.5)}
                  stroke="#16181c" strokeWidth="0.5" />
          </g>
        ))}
        <text className="tag" x={X(s.start + s.w / 2)} y={Y(baseH + carcassH) - 2} textAnchor="middle">
          {isC ? "CORNER JOINT UNIT" : `${s.key} · ${sq}SH ${dq}DR ${rails.length}HR${s.locked ? " · FIXED" : ""}`}
        </text>
      </g>
    );
  };

  return (
    <svg className="fe-sheet" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="3" stroke="#b3ada0" strokeWidth="0.4" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={SW} height={SH} fill="#f7f4ee" />
      <rect x="4" y="4" width={SW - 8} height={SH - 8} fill="none" stroke="#16181c" strokeWidth="0.5" />

      <rect x={X(0)} y={Y(baseH)} width={r.length * sc} height={baseH * sc} fill="#d9d4c9" stroke="#16181c" strokeWidth="0.28" />
      {r.panels.map((p, i) => (
        <rect key={i} x={X(p)} y={Y(baseH + carcassH)} width={T * sc} height={carcassH * sc}
              fill="#c9c4b8" stroke="#16181c" strokeWidth="0.22" />
      ))}
      {sections.map(section)}

      {widthDims}
      {heightDims}
      {dim(X(0), Y(0) + 24, X(r.length), Y(0) + 24, Math.round(r.length), false, "wt")}
      {dim(X(0) - 23, Y(0), X(0) - 23, Y(H), Math.round(H), true, "ht")}

      <text className="redlabel" x={X(r.length / 2)} y={area.y + 6} textAnchor="middle">
        {r.label.toUpperCase()} — FRONT ELEVATION
      </text>
      <text className="micro" x={X(0) - 28} y={area.y + 6}>HEIGHTS AT {ref.key}</text>

      <g className="tb">
        <rect x="14" y="160" width="269" height="42" fill="none" stroke="#16181c" strokeWidth="0.5" />
        <line x1="14" y1="174" x2="283" y2="174" stroke="#16181c" strokeWidth="0.3" />
        <line x1="74" y1="160" x2="74" y2="202" stroke="#16181c" strokeWidth="0.3" />
        <line x1="160" y1="174" x2="160" y2="202" stroke="#16181c" strokeWidth="0.3" />
        <line x1="222" y1="174" x2="222" y2="202" stroke="#16181c" strokeWidth="0.3" />

        {logo
          ? <image href={logo.href} x="18" y="161.5" width={Math.min(50, 11 * (logo.w / logo.h))} height="11" preserveAspectRatio="xMinYMid meet" />
          : <text className="brand" x="22" y="170">FINE EDGE</text>}
        <text className="micro" x="22" y="180">CLIENT</text>
        <text className="val" x="22" y="187">{client || "—"}</text>
        <text className="micro" x="22" y="195">PROJECT</text>
        <text className="val" x="22" y="200.5">{project || "—"}</text>

        <text className="note" x="80" y="170">Advised to check sizes on site.  All Dimensions are in Millimeters.</text>
        <text className="micro" x="80" y="180">DRAWING TITLE</text>
        <text className="val" x="80" y="187">{r.label} — Front Elevation</text>
        <text className="micro" x="80" y="195">OVERALL</text>
        <text className="val" x="80" y="200.5">{H} H × {cfg.D} D · {baseH} base · corner {C}</text>

        <text className="micro" x="165" y="180">SCALE</text>
        <text className="val" x="165" y="187">As Shown</text>
        <text className="micro" x="165" y="195">DATE</text>
        <text className="val" x="165" y="200.5">{new Date().toISOString().slice(0, 10)}</text>

        <text className="micro" x="227" y="180">DWG NO</text>
        <text className="val" x="227" y="187">FE-{cfg.shape.toUpperCase()}-{r.id}</text>
        <text className="micro" x="227" y="195">REV</text>
        <text className="val" x="227" y="200.5">A</text>
      </g>
    </svg>
  );
}


/* ── cut list sheet (export only) ──────────────────────────── */

function CutSheet({ cfg, list, client, project, logo, page, pages }) {
  const SW = 297, SH = 210;
  const rowH = 4.6, top = 26;
  const perCol = 28;
  const cols = [[14, 0], [104, 1], [194, 2]];
  return (
    <svg className="fe-sheet" viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width={SW} height={SH} fill="#f7f4ee" />
      <rect x="4" y="4" width={SW - 8} height={SH - 8} fill="none" stroke="#16181c" strokeWidth="0.5" />
      <text className="redlabel" x={SW / 2} y="16" textAnchor="middle">CUTTING LIST</text>

      {cols.map(([x, ci]) => {
        const slice = list.slice(ci * perCol, ci * perCol + perCol);
        if (!slice.length) return null;
        return (
          <g key={ci}>
            <text className="head" x={x} y={top - 3}>PART</text>
            <text className="head" x={x + 52} y={top - 3} textAnchor="end">W</text>
            <text className="head" x={x + 68} y={top - 3} textAnchor="end">H</text>
            <text className="head" x={x + 80} y={top - 3} textAnchor="end">QTY</text>
            <line x1={x} y1={top - 1.5} x2={x + 80} y2={top - 1.5} stroke="#16181c" strokeWidth="0.3" />
            {slice.map((r, i) => (
              <g key={i}>
                <text className="val" x={x} y={top + 3 + i * rowH}>{r.part.slice(0, 22)}</text>
                <text className="val" x={x + 52} y={top + 3 + i * rowH} textAnchor="end">{r.w}</text>
                <text className="val" x={x + 68} y={top + 3 + i * rowH} textAnchor="end">{r.h}</text>
                <text className="val" x={x + 80} y={top + 3 + i * rowH} textAnchor="end">{r.qty}</text>
              </g>
            ))}
          </g>
        );
      })}

      <g className="tb">
        <rect x="14" y="160" width="269" height="42" fill="none" stroke="#16181c" strokeWidth="0.5" />
        <line x1="14" y1="174" x2="283" y2="174" stroke="#16181c" strokeWidth="0.3" />
        <line x1="74" y1="160" x2="74" y2="202" stroke="#16181c" strokeWidth="0.3" />
        {logo
          ? <image href={logo.href} x="18" y="161.5" width={Math.min(50, 11 * (logo.w / logo.h))} height="11" preserveAspectRatio="xMinYMid meet" />
          : <text className="brand" x="22" y="170">FINE EDGE</text>}
        <text className="micro" x="22" y="180">CLIENT</text>
        <text className="val" x="22" y="187">{client || "-"}</text>
        <text className="micro" x="22" y="195">PROJECT</text>
        <text className="val" x="22" y="200.5">{project || "-"}</text>
        <text className="note" x="80" y="170">Advised to check sizes on site.  All Dimensions are in Millimeters.</text>
        <text className="micro" x="80" y="180">DRAWING TITLE</text>
        <text className="val" x="80" y="187">Cutting List</text>
        <text className="micro" x="80" y="195">MATERIAL / DATE</text>
        <text className="val" x="80" y="200.5">18mm board - {new Date().toISOString().slice(0, 10)}</text>
        <text className="micro" x="200" y="180">SHEET</text>
        <text className="val" x="200" y="187">{page} of {pages}</text>
        <text className="micro" x="200" y="195">REV</text>
        <text className="val" x="200" y="200.5">A</text>
      </g>
    </svg>
  );
}

/* ── app ───────────────────────────────────────────────────── */


export default function App() {
  const [cfg, setCfg] = useState({
    shape: "L", H: 2400, D: 600, baseH: 100, cornerW: 900,
    wA: 3000, wB: 2200, wC: 2000, doors: false,
  });
  const [finishId, setFinishId] = useState("oak");
  const [bayCfg, setBayCfg] = useState({});
  const [runCfg, setRunCfg] = useState({});
  const [bayW, setBayW] = useState({});
  const [view, setView] = useState("3d");
  const [activeRun, setActiveRun] = useState("A");
  const [activeBay, setActiveBay] = useState("CNR");
  const [showCut, setShowCut] = useState(false);
  const [fitToken, setFitToken] = useState(0);
  const [logo, setLogo] = useState(FINE_EDGE_LOGO);
  const [user, setUser] = useState(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState(null);
  const [designs, setDesigns] = useState([]);
  const [designId, setDesignId] = useState(null);
  const [designName, setDesignName] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const exportRef = useRef(null);
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");

  const finish = FINISHES.find((f) => f.id === finishId);
  const model = useMemo(() => buildModel(cfg, runCfg, bayW), [cfg, runCfg, bayW]);
  const list = useMemo(() => cutList(model, cfg, bayCfg), [model, cfg, bayCfg]);

  const units = useMemo(() => {
    const u = model.corners.map((c) => ({ key: c.key, label: c.label, corner: true, w: model.C }));
    model.runs.forEach((r) => r.bays.forEach((b) => u.push({ key: b.key, label: `Bay ${b.key}`, corner: false, w: b.w, locked: b.locked, runId: r.id })));
    return u;
  }, [model]);

  useEffect(() => {
    if (!model.runs.some((r) => r.id === activeRun)) setActiveRun(model.runs[0].id);
    if (!units.some((u) => u.key === activeBay)) setActiveBay(units[0]?.key);
  }, [model]); // eslint-disable-line

  const active = units.find((u) => u.key === activeBay) || units[0];
  const bay = bayCfg[activeBay] || (active?.corner ? defaultCorner() : defaultBay());
  const IH = model.IH;
  const dMax = maxDrawers(IH);
  const sMax = maxShelves(IH, Math.min(bay.drawers, dMax));
  const preview = bayInternals(bay, IH, model.y0);

  const patch = useCallback((p) => setBayCfg((s) => {
    const cur = s[activeBay] || (units.find((u) => u.key === activeBay)?.corner ? defaultCorner() : defaultBay());
    return { ...s, [activeBay]: { ...cur, ...p } };
  }), [activeBay, units]);

  const pick = (key) => {
    setActiveBay(key);
    const run = model.runs.find((r) => r.bays.some((b) => b.key === key) || r.c0 === key || r.c1 === key);
    if (run) setActiveRun(run.id);
  };

  const copyToRun = () => {
    const run = model.runs.find((r) => r.id === activeRun);
    setBayCfg((s) => {
      const next = { ...s };
      run.bays.forEach((b) => { next[b.key] = { ...bay }; });
      return next;
    });
  };

  const set = (k) => (v) => setCfg((c) => ({ ...c, [k]: v }));

  const setCount = (runId, n) => setRunCfg((s) => ({ ...s, [runId]: { ...(s[runId] || {}), count: n } }));

  const resetRun = (runId) => {
    setRunCfg((s) => ({ ...s, [runId]: { ...(s[runId] || {}), count: null } }));
    setBayW((s) => {
      const next = { ...s };
      Object.keys(next).forEach((k) => { if (k.startsWith(runId)) delete next[k]; });
      return next;
    });
  };

  const toggleLock = () => {
    if (!active || active.corner) return;
    setBayW((s) => {
      const next = { ...s };
      if (typeof next[activeBay] === "number") delete next[activeBay];
      else next[activeBay] = Math.round(active.w);
      return next;
    });
  };

  const setWidth = (mm) => setBayW((s) => ({ ...s, [activeBay]: Math.max(MIN_OPEN, Math.round(mm)) }));

  const setRail = (i, mm) => {
    const arr = [...(bay.railH || [])];
    arr[i] = Math.max(preview.rMin, Math.min(preview.rMax, Math.round(mm)));
    patch({ railH: arr });
  };

  const toggleRail = (i, cur) => {
    const arr = [...(bay.railH || [])];
    arr[i] = typeof arr[i] === "number" ? null : Math.round(cur);
    patch({ railH: arr });
  };

  const boardArea = list.reduce((a, r) => a + (r.w * r.h * r.qty) / 1e6, 0);
  const sheets = Math.ceil(boardArea / (2.44 * 1.22) / 0.82);
  const tally = units.reduce((acc, u) => {
    const i = bayInternals(bayCfg[u.key] || (u.corner ? defaultCorner() : defaultBay()), IH, model.y0);
    acc.sh += i.shelves.length; acc.dr += i.drawers.length; return acc;
  }, { sh: 0, dr: 0 });


  /* ── logo ── */
  const onLogo = async (file) => {
    if (!file) return;
    try { setLogo(await jpegFromFile(file)); setMsg(null); }
    catch (e) { setMsg({ bad: true, text: e.message }); }
  };

  /* ── PDF ── */
  const exportPdf = () => {
    try {
      const svgs = [...(exportRef.current?.querySelectorAll("svg") || [])];
      if (!svgs.length) { setMsg({ bad: true, text: "Nothing to export yet." }); return; }
      const stamp = new Date().toISOString().slice(0, 10);
      const base = (client || project || "Fine-Edge").replace(/[^\w-]+/g, "-");
      const blob = svgsToPdf(svgs, { title: `${project || "Wardrobe"} - Fine Edge`, author: "Fine Edge" },
                             logo ? [logo] : []);
      downloadBlob(blob, `${base}-${stamp}.pdf`);
      setMsg({ text: `Exported ${svgs.length} sheet${svgs.length > 1 ? "s" : ""}.` });
    } catch (e) {
      setMsg({ bad: true, text: `Export failed: ${e.message}` });
    }
  };

  /* ── cloud ── */
  const payload = () => ({ v: 1, cfg, bayCfg, runCfg, bayW, finishId });

  const refresh = useCallback(async () => {
    try { setDesigns(await cloud.listDesigns()); }
    catch (e) { setMsg({ bad: true, text: e.message }); }
  }, []);

  useEffect(() => {
    if (!cloud.configured) return;
    cloud.currentUser().then((u) => { setUser(u); if (u) refresh(); });
  }, [refresh]);

  const doSignIn = async () => {
    setBusy("in"); setMsg(null);
    try { const u = await cloud.signIn(email.trim(), pw); setUser(u); setPw(""); await refresh(); }
    catch (e) { setMsg({ bad: true, text: e.message }); }
    finally { setBusy(""); }
  };

  const doSignOut = async () => {
    await cloud.signOut(); setUser(null); setDesigns([]); setDesignId(null);
  };

  const doSave = async (asNew) => {
    const name = designName.trim() || project.trim() || client.trim();
    if (!name) { setMsg({ bad: true, text: "Give the design a name first." }); return; }
    setBusy("save"); setMsg(null);
    try {
      const id = await cloud.saveDesign({
        id: asNew ? null : designId, name, client, project, payload: payload(),
      });
      setDesignId(id); setDesignName(name);
      await refresh();
      setMsg({ text: `Saved "${name}".` });
    } catch (e) { setMsg({ bad: true, text: e.message }); }
    finally { setBusy(""); }
  };

  const doLoad = async (id) => {
    setBusy("load"); setMsg(null);
    try {
      const row = await cloud.loadDesign(id);
      const d = row.data || {};
      if (d.cfg) setCfg(d.cfg);
      setBayCfg(d.bayCfg || {});
      setRunCfg(d.runCfg || {});
      setBayW(d.bayW || {});
      if (d.finishId) setFinishId(d.finishId);
      setClient(row.client || ""); setProject(row.project || "");
      setDesignId(row.id); setDesignName(row.name || "");
      setFitToken((n) => n + 1);
      setMsg({ text: `Loaded "${row.name}".` });
    } catch (e) { setMsg({ bad: true, text: e.message }); }
    finally { setBusy(""); }
  };

  const doDelete = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await cloud.deleteDesign(id);
      if (id === designId) setDesignId(null);
      await refresh();
      setMsg({ text: "Deleted." });
    } catch (e) { setMsg({ bad: true, text: e.message }); }
  };

  const cutPages = [];
  for (let i = 0; i < list.length; i += 84) cutPages.push(list.slice(i, i + 84));

  const runLabels = {
    straight: [["wA", "Width"]],
    L: [["wA", "Run A"], ["wB", "Run B"]],
    U: [["wA", "Back"], ["wB", "Left"], ["wC", "Right"]],
  };

  return (
    <div className="fe">
      <style>{CSS}</style>

      <header className="bar">
        <div className="mark">
          <span className="m1">FINE</span><span className="m2">EDGE</span>
          <span className="msub">wardrobe designer</span>
        </div>
        <div className="seg">
          <button className={view === "3d" ? "on" : ""} onClick={() => setView("3d")}>3D</button>
          <button className={view === "2d" ? "on" : ""} onClick={() => setView("2d")}>Drawing</button>
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <section>
            <h3>Layout</h3>
            <div className="chips">
              {[["straight", "Straight"], ["L", "L-shape"], ["U", "U-shape"]].map(([id, n]) => (
                <button key={id} className={cfg.shape === id ? "chip on" : "chip"} onClick={() => set("shape")(id)}>{n}</button>
              ))}
            </div>
          </section>

          <section>
            <h3>Dimensions <em>mm</em></h3>
            <Field label="Overall height" hint="incl. base" value={cfg.H} min={1800} max={3000} step={10} onChange={set("H")} />
            <Field label="Depth" value={cfg.D} min={300} max={750} step={10} onChange={set("D")} />
            <Field label="Base / plinth" hint="standard 100" value={cfg.baseH} min={0} max={250} step={5} onChange={set("baseH")} />
            {cfg.shape !== "straight" && (
              <Field label="Corner unit" hint={`front opening ${Math.round(model.C - cfg.D)}`}
                     value={Math.max(cfg.cornerW, cfg.D + MIN_CNR_OPEN)}
                     min={cfg.D + MIN_CNR_OPEN} max={cfg.D + 1000} step={10} onChange={set("cornerW")} />
            )}
            {runLabels[cfg.shape].map(([k, l]) => (
              <Field key={k} label={l} value={cfg[k]} min={900} max={6000} step={10} onChange={set(k)} />
            ))}
          </section>

          <section>
            <h3>Units per section</h3>
            {model.runs.map((r) => (
              <div key={r.id} className="unitrow">
                <Stepper label={r.label.replace(/ —.*/, "")} value={r.n} min={1} max={r.maxN}
                         onChange={(v) => setCount(r.id, v)} />
                <div className="unitmeta">
                  <span>{r.bays.map((b) => Math.round(b.w)).join(" · ") || "—"}</span>
                  <button onClick={() => resetRun(r.id)}>Auto</button>
                </div>
              </div>
            ))}
            {model.runs.some((r) => r.adjusted) && (
              <p className="warn">Locked widths didn't fit — scaled to suit the run.</p>
            )}
          </section>

          <section className="editor">
            <h3>{active?.corner ? active.label : `Bay ${activeBay}`} <em>{Math.round(active?.w || 0)} wide</em></h3>

            <div className="baypick">
              {model.corners.length > 0 && (
                <div className="pickrow">
                  <span>C</span>
                  {model.corners.map((c) => (
                    <button key={c.key} className={c.key === activeBay ? "pb cnr on" : "pb cnr"} onClick={() => pick(c.key)}>
                      {c.key === "CNRR" ? "R" : c.key === "CNRL" ? "L" : "◣"}
                    </button>
                  ))}
                </div>
              )}
              {model.runs.map((r) => (
                <div key={r.id} className="pickrow">
                  <span>{r.id}</span>
                  {r.bays.map((b) => (
                    <button key={b.key} className={b.key === activeBay ? "pb on" : "pb"} onClick={() => pick(b.key)}>
                      {b.key.slice(1)}
                    </button>
                  ))}
                </div>
              ))}
            </div>

            <div className="widthrow">
              <span>Width</span>
              <input className="num" type="number" step={10} disabled={active?.corner}
                     value={Math.round(active?.w || 0)}
                     onChange={(e) => setWidth(Number(e.target.value) || MIN_OPEN)} />
              <button className={active?.locked ? "chip sm on" : "chip sm"} disabled={active?.corner}
                      onClick={toggleLock}>{active?.locked ? "Fixed" : "Auto"}</button>
            </div>

            <Stepper label="Drawers" value={Math.min(bay.drawers, dMax)} min={0} max={dMax}
                     onChange={(v) => patch({ drawers: v, shelves: Math.min(bay.shelves, maxShelves(IH, v)) })} />
            <Stepper label="Shelves" value={Math.min(bay.shelves, sMax)} min={0} max={sMax}
                     onChange={(v) => patch({ shelves: v })} />

            <div className="hangrow">
              <span>Hanging</span>
              <div className="chips">
                {HANG.map((h) => (
                  <button key={h.id} className={bay.hang === h.id ? "chip sm on" : "chip sm"} onClick={() => patch({ hang: h.id })}>{h.label}</button>
                ))}
              </div>
            </div>

            <label className="toggle sm">
              <input type="checkbox" checked={!!bay.topShelf}
                     onChange={(e) => patch({ topShelf: e.target.checked, topShelfH: null })} />
              <span>Top shelf above rail</span>
            </label>
            {bay.topShelf && preview.topShelfY != null && (
              <div className="widthrow rail">
                <span>Shelf height</span>
                <input className="num" type="number" step={10} value={Math.round(preview.topShelfY)}
                       onChange={(e) => patch({ topShelfH: Math.max(preview.tMin, Math.min(preview.tMax, Number(e.target.value) || preview.tMin)) })} />
                <button className={preview.topShelfAuto ? "chip sm" : "chip sm on"}
                        onClick={() => patch({ topShelfH: preview.topShelfAuto ? Math.round(preview.topShelfY) : null })}>
                  {preview.topShelfAuto ? "Auto" : "Fixed"}
                </button>
              </div>
            )}

            {preview.rails.map((rl, i) => (
              <div className="widthrow rail" key={i}>
                <span>{preview.rails.length > 1 ? `Rail ${i + 1}` : "Rail height"}</span>
                <input className="num" type="number" step={10} value={Math.round(rl.y)}
                       onChange={(e) => setRail(i, Number(e.target.value) || preview.rMin)} />
                <button className={rl.auto ? "chip sm" : "chip sm on"} onClick={() => toggleRail(i, rl.y)}>
                  {rl.auto ? "Auto" : "Fixed"}
                </button>
              </div>
            ))}
            {preview.rails.length > 0 && (
              <input className="railslider" type="range" min={preview.rMin} max={preview.rMax} step={10}
                     value={Math.round(preview.rails[0].y)} onChange={(e) => setRail(0, Number(e.target.value))} />
            )}

            <div className="readout">
              <b>{Math.round(preview.compH)}</b> mm clear per compartment
              {preview.dq > 0 && <> · <b>{preview.dq * DRAWER_H}</b> mm drawer stack</>}
              {preview.rails.length > 0 && <> · drop <b>{preview.rails.map((r) => Math.round(r.h)).join(" / ")}</b> mm</>}
              {active?.corner && <> · front opening <b>{Math.round(model.C - cfg.D)}</b> mm each leg</>}
            </div>

            <div className="chips presets">
              {PRESETS.map((p) => <button key={p.id} className="chip sm" onClick={() => patch(p.cfg)}>{p.name}</button>)}
            </div>
            {!active?.corner && (
              <button className="wide" onClick={copyToRun}>Copy to all bays in run {activeRun}</button>
            )}
          </section>

          <section>
            <h3>Finish</h3>
            <div className="sw">
              {FINISHES.map((f) => (
                <button key={f.id} className={finishId === f.id ? "on" : ""} onClick={() => setFinishId(f.id)}>
                  <i style={{ background: f.base }} /><span>{f.name}</span>
                </button>
              ))}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={cfg.doors} onChange={(e) => set("doors")(e.target.checked)} />
              <span>Show fronts</span>
            </label>
          </section>

          <section>
            <h3>Output</h3>
            <div className="logorow">
              <img src={logo?.href} alt="" />
              <div>
                <b>{logo?.builtIn ? "Fine Edge logo" : logo ? "Custom logo" : "No logo"}</b>
                <div className="logoacts">
                  <label>Replace<input type="file" accept="image/jpeg"
                         onChange={(e) => onLogo(e.target.files?.[0])} /></label>
                  {!logo?.builtIn && <button onClick={() => { setLogo(FINE_EDGE_LOGO); setMsg(null); }}>Reset</button>}
                </div>
              </div>
            </div>
            <button className="wide primary" onClick={exportPdf}>Export PDF drawings</button>
            <p className="micro-note">
              {model.runs.length} elevation{model.runs.length > 1 ? "s" : ""} + {cutPages.length} cut list page{cutPages.length > 1 ? "s" : ""}, A4 landscape
            </p>
          </section>

          <section>
            <h3>Cloud save</h3>
            {!cloud.configured ? (
              <p className="micro-note">Not set up. Add your Supabase URL and anon key to <b>config.js</b>.</p>
            ) : !user ? (
              <>
                <input className="txt" type="email" placeholder="Email" value={email}
                       onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
                <input className="txt" type="password" placeholder="Password" value={pw}
                       onChange={(e) => setPw(e.target.value)} autoComplete="current-password"
                       onKeyDown={(e) => e.key === "Enter" && doSignIn()} />
                <button className="wide primary" onClick={doSignIn} disabled={busy === "in"}>
                  {busy === "in" ? "Signing in…" : "Sign in"}
                </button>
              </>
            ) : (
              <>
                <input className="txt" placeholder="Design name" value={designName}
                       onChange={(e) => setDesignName(e.target.value)} />
                <div className="saverow">
                  <button onClick={() => doSave(false)} disabled={busy === "save"}>
                    {designId ? "Update" : "Save"}
                  </button>
                  <button onClick={() => doSave(true)} disabled={busy === "save"}>Save as new</button>
                </div>
                {designs.length > 0 && (
                  <ul className="dlist">
                    {designs.map((d) => (
                      <li key={d.id} className={d.id === designId ? "on" : ""}>
                        <button className="dopen" onClick={() => doLoad(d.id)}>
                          <b>{d.name}</b>
                          <em>{d.client || d.project || "—"} · {String(d.updated_at).slice(0, 10)}</em>
                        </button>
                        <button className="ddel" onClick={() => doDelete(d.id, d.name)} title="Delete">×</button>
                      </li>
                    ))}
                  </ul>
                )}
                <button className="wide" onClick={doSignOut}>Sign out ({user.email})</button>
              </>
            )}
            {msg && <p className={msg.bad ? "micro-note bad" : "micro-note ok"}>{msg.text}</p>}
          </section>

          <section>
            <h3>Client</h3>
            <input className="txt" placeholder="Client name" value={client} onChange={(e) => setClient(e.target.value)} />
            <input className="txt" placeholder="Project / location" value={project} onChange={(e) => setProject(e.target.value)} />
          </section>
        </aside>

        <main className="stage">
          {view === "3d"
            ? <>
                <Viewport3D cfg={cfg} model={model} bayCfg={bayCfg} finish={finish} fitToken={fitToken} />
                <button className="fitbtn" onClick={() => setFitToken((n) => n + 1)}>Recentre</button>
              </>
            : <div className="paper">
                <Sheet2D cfg={cfg} model={model} bayCfg={bayCfg} activeRun={activeRun} activeBay={activeBay}
                         onPick={pick} client={client} project={project} logo={logo} />
              </div>}
          {view === "2d" && model.runs.length > 1 && (
            <div className="runtabs">
              {model.runs.map((r) => (
                <button key={r.id} className={activeRun === r.id ? "on" : ""} onClick={() => setActiveRun(r.id)}>{r.label}</button>
              ))}
            </div>
          )}
          <div className="hint">{view === "3d" ? "Drag to orbit · pinch or scroll to zoom" : "Tap a unit to edit it"}</div>
        </main>
      </div>

      <div className="exportsheets" ref={exportRef} aria-hidden="true">
        {model.runs.map((r) => (
          <Sheet2D key={r.id} cfg={cfg} model={model} bayCfg={bayCfg} activeRun={r.id}
                   activeBay={r.bays[0]?.key || r.c0} onPick={() => {}}
                   client={client} project={project} logo={logo} />
        ))}
        {cutPages.map((chunk, i) => (
          <CutSheet key={i} cfg={cfg} list={chunk} client={client} project={project}
                    logo={logo} page={i + 1} pages={cutPages.length} />
        ))}
      </div>

      <footer className="tally">
        <Stat k="Units" v={units.length} />
        <Stat k="Shelves" v={tally.sh} />
        <Stat k="Drawers" v={tally.dr} />
        <Stat k="Widths" v={(() => {
          const ws = model.runs.flatMap((r) => r.bays.map((b) => Math.round(b.w)));
          if (!ws.length) return "—";
          const lo = Math.min(...ws), hi = Math.max(...ws);
          return lo === hi ? `${lo}` : `${lo}–${hi}`;
        })()} unit="mm" />
        <Stat k="Board area" v={boardArea.toFixed(2)} unit="m²" />
        <Stat k="Sheets" v={sheets} />
        <button className="cutbtn" onClick={() => setShowCut((s) => !s)}>{showCut ? "Hide cut list" : "Cut list"}</button>
        <button className="cutbtn pdf" onClick={exportPdf}>PDF</button>
      </footer>

      {showCut && (
        <div className="cut">
          <table>
            <thead><tr><th>Part</th><th>W</th><th>H</th><th>Qty</th></tr></thead>
            <tbody>{list.map((r, i) => <tr key={i}><td>{r.part}</td><td>{r.w}</td><td>{r.h}</td><td>{r.qty}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, value, min, max, step, onChange }) {
  return (
    <div className="field">
      <div className="flabel">
        <span>{label}{hint && <em> {hint}</em>}</span>
        <input className="num" type="number" value={value} min={min} max={max} step={step}
               onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))} />
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Stepper({ label, value, min, max, onChange }) {
  return (
    <div className="step">
      <span>{label}</span>
      <div className="stepctl">
        <button onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min}>−</button>
        <b>{value}</b>
        <button onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max}>+</button>
      </div>
      <em>max {max}</em>
    </div>
  );
}

function Stat({ k, v, unit }) {
  return <div className="stat"><span>{k}</span><b>{v}{unit && <i>{unit}</i>}</b></div>;
}

const CSS = `

.logorow{display:flex;gap:11px;align-items:center;border:1px solid var(--line);border-radius:2px;
  padding:9px 10px;margin-bottom:10px}
.logorow img{width:62px;height:auto;border-radius:2px;flex:none;background:#fff}
.logorow>div{min-width:0}
.logorow b{display:block;font-size:11.5px;font-weight:500;color:#e7e9ec}
.logoacts{display:flex;gap:8px;margin-top:5px}
.logoacts label,.logoacts button{background:none;border:0;padding:0;font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--oak);cursor:pointer;border-bottom:1px solid transparent}
.logoacts label:hover,.logoacts button:hover{border-bottom-color:var(--oak)}
.logoacts input{display:none}

.filerow{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--line);
  border-radius:2px;padding:8px 10px;font-size:11.5px;color:#b9bfc9;cursor:pointer;margin-bottom:9px}
.filerow:hover{border-color:var(--oak)}
.filerow input{display:none}
.wide.primary{border-color:var(--oak);color:var(--oak);margin-top:0}
.wide.primary:disabled{opacity:.5;cursor:default}
.micro-note{margin:8px 0 0;font-size:10.5px;line-height:1.45;color:#59616f}
.micro-note b{color:#9aa2ae;font-weight:600}
.micro-note.ok{color:#8fae7e}
.micro-note.bad{color:#d08a5c}

.saverow{display:flex;gap:6px;margin-bottom:9px}
.saverow button{flex:1;background:none;border:1px solid var(--line);border-radius:2px;padding:7px 4px;
  font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#b9bfc9;cursor:pointer}
.saverow button:first-child{border-color:var(--oak);color:var(--oak)}
.saverow button:disabled{opacity:.5;cursor:default}

.dlist{list-style:none;margin:0 0 9px;padding:0;max-height:180px;overflow-y:auto;border-top:1px solid #262b33}
.dlist li{display:flex;align-items:stretch;border-bottom:1px solid #22262d}
.dlist li.on{background:rgba(200,160,105,.08)}
.dopen{flex:1;background:none;border:0;text-align:left;padding:7px 4px;cursor:pointer;min-width:0}
.dopen b{display:block;font-size:11.5px;font-weight:500;color:#e7e9ec;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dopen em{display:block;font-style:normal;font-size:9.5px;color:#59616f;margin-top:2px;
  font-family:ui-monospace,Menlo,monospace}
.ddel{background:none;border:0;width:26px;font-size:15px;color:#4e5665;cursor:pointer;flex:none}
.ddel:hover{color:var(--redline)}

.cutbtn.pdf{margin-left:8px;border-color:var(--oak);color:var(--oak)}
.exportsheets{position:absolute;left:-99999px;top:0;width:1100px;height:780px;opacity:0;pointer-events:none}
.exportsheets svg{width:1050px;height:742px;display:block}
.fe{--ink:#16181c;--line:#333944;--redline:#c8342b;--oak:#c8a069;--steel:#7c8492;
  position:absolute;inset:0;display:flex;flex-direction:column;background:var(--ink);color:#e7e9ec;
  font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}
.fe *{box-sizing:border-box}
.fe button,.fe input{font:inherit;color:inherit}

.bar{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);flex:none}
.mark{display:flex;align-items:baseline;gap:6px}
.m1,.m2{font-weight:800;letter-spacing:.16em;font-size:15px}
.m2{color:var(--oak)}
.msub{margin-left:8px;font-size:10px;letter-spacing:.22em;text-transform:uppercase;color:var(--steel)}
.seg{display:flex;border:1px solid var(--line);border-radius:2px;overflow:hidden}
.seg button{background:none;border:0;padding:6px 16px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--steel);cursor:pointer}
.seg button.on{background:var(--oak);color:#181109;font-weight:700}

.body{flex:1;display:flex;min-height:0}
.rail{width:300px;flex:none;border-right:1px solid var(--line);overflow-y:auto}
.rail section{padding:14px 16px;border-bottom:1px solid #22262d}
.rail h3{margin:0 0 10px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--steel);font-weight:600}
.rail h3 em{font-style:normal;text-transform:none;letter-spacing:.02em;color:#4e5665;margin-left:6px;font-family:ui-monospace,Menlo,monospace}
.editor{background:#1a1e24;border-left:2px solid var(--redline)}

.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{background:none;border:1px solid var(--line);border-radius:2px;padding:6px 12px;font-size:12px;color:#c3c8d0;cursor:pointer}
.chip.sm{padding:4px 9px;font-size:11px}
.chip.on{border-color:var(--oak);color:var(--oak);background:rgba(200,160,105,.09)}
.presets{margin-top:12px;padding-top:11px;border-top:1px solid #262b33}

.field{margin-bottom:12px}
.flabel{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#b9bfc9;margin-bottom:4px}
.flabel em{font-style:normal;color:#5b6270;font-size:10px}
.num{width:74px;background:#1b1f25;border:1px solid var(--line);border-radius:2px;padding:3px 6px;text-align:right;
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--oak)}
.field input[type=range]{width:100%;accent-color:var(--oak);height:16px}

.baypick{margin-bottom:14px}
.pickrow{display:flex;align-items:center;gap:5px;margin-bottom:5px;flex-wrap:wrap}
.pickrow>span{font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#59616f;width:12px;flex:none}
.pb{width:28px;height:26px;background:#15181d;border:1px solid var(--line);border-radius:2px;
  font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#9aa2ae;cursor:pointer}
.pb.cnr{border-color:#4a3f3a;color:var(--oak)}
.pb.on{border-color:var(--redline);color:#fff;background:rgba(200,52,43,.18)}

.step{display:flex;align-items:center;gap:10px;margin-bottom:9px}
.step>span{font-size:12px;color:#b9bfc9;width:64px}
.step>em{font-style:normal;font-size:10px;color:#4e5665;font-family:ui-monospace,Menlo,monospace}
.stepctl{display:flex;align-items:center;border:1px solid var(--line);border-radius:2px;overflow:hidden}
.stepctl button{width:32px;height:30px;background:#15181d;border:0;font-size:16px;color:#c3c8d0;cursor:pointer;line-height:1}
.stepctl button:disabled{color:#3a4048;cursor:default}
.stepctl button:not(:disabled):active{background:var(--oak);color:#181109}
.stepctl b{width:36px;text-align:center;font-family:ui-monospace,Menlo,monospace;font-size:14px;color:var(--oak)}

.unitrow{margin-bottom:12px}
.unitrow .step{margin-bottom:4px}
.unitmeta{display:flex;align-items:center;gap:8px;padding-left:74px}
.unitmeta span{flex:1;font-family:ui-monospace,Menlo,monospace;font-size:10px;color:#59616f;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.unitmeta button{background:none;border:1px solid var(--line);border-radius:2px;padding:2px 8px;font-size:9px;
  letter-spacing:.12em;text-transform:uppercase;color:#7c8492;cursor:pointer;flex:none}
.unitmeta button:hover{border-color:var(--oak);color:var(--oak)}
.warn{margin:8px 0 0;font-size:10.5px;color:#d08a5c;line-height:1.4}

.widthrow{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.widthrow>span{font-size:12px;color:#b9bfc9;width:64px;flex:none}
.widthrow .num{width:80px}
.widthrow .chip{flex:none}
.widthrow .chip:disabled,.widthrow .num:disabled{opacity:.4;cursor:default}

.toggle.sm{margin:14px 0 8px;font-size:11.5px}
.widthrow.rail{margin-bottom:6px}
.railslider{width:100%;accent-color:#5b8bc9;height:16px;margin:2px 0 4px}

.hangrow{display:flex;align-items:center;gap:10px;margin-top:12px}
.hangrow>span{font-size:12px;color:#b9bfc9;width:64px;flex:none}
.readout{margin-top:12px;font-size:11px;color:#7c8492}
.readout b{font-family:ui-monospace,Menlo,monospace;color:#c3c8d0;font-weight:500}
.wide{width:100%;margin-top:11px;background:none;border:1px solid var(--line);border-radius:2px;padding:7px;
  font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#9aa2ae;cursor:pointer}
.wide:hover{border-color:var(--oak);color:var(--oak)}

.sw{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.sw button{display:flex;align-items:center;gap:7px;background:none;border:1px solid var(--line);border-radius:2px;
  padding:6px;font-size:11px;color:#b9bfc9;cursor:pointer;text-align:left}
.sw button.on{border-color:var(--oak);color:#fff}
.sw i{width:16px;height:16px;border-radius:2px;flex:none;box-shadow:inset 0 0 0 1px rgba(0,0,0,.35)}
.toggle{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:#b9bfc9;cursor:pointer}
.toggle input{accent-color:var(--oak);width:15px;height:15px}

.txt{width:100%;background:#1b1f25;border:1px solid var(--line);border-radius:2px;padding:7px 9px;font-size:12px;margin-bottom:7px}
.txt::placeholder{color:#4e5665}

.stage{flex:1;min-width:0;position:relative;display:flex;flex-direction:column}
.fe-3d{flex:1;min-height:0}
.paper{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:14px 14px 6px;background:#0d0f12}
.fe-sheet{width:100%;height:100%;max-height:100%;box-shadow:0 8px 34px rgba(0,0,0,.6)}
.fe-sheet .dim line{stroke:var(--ink);stroke-width:.22}
.fe-sheet .dim text{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:2.9px;fill:var(--ink);text-anchor:middle}
.fe-sheet .redlabel{fill:var(--redline);font-size:4.2px;font-weight:700;letter-spacing:.14em}
.fe-sheet .tag{fill:var(--redline);font-family:ui-monospace,Menlo,monospace;font-size:2.7px}
.fe-sheet .note{fill:#3d4148;font-size:2.7px;font-style:italic}
.fe-sheet .brand{fill:var(--ink);font-size:6px;font-weight:800;letter-spacing:.16em}
.fe-sheet .micro{fill:#7a7f88;font-size:2.3px;letter-spacing:.16em}
.fe-sheet .val{fill:var(--ink);font-size:3.2px;font-family:ui-monospace,Menlo,monospace}
.fe-sheet .bay{cursor:pointer}

.runtabs{display:flex;gap:6px;justify-content:center;padding:0 14px 8px;background:#0d0f12}
.runtabs button{background:none;border:1px solid var(--line);border-radius:2px;padding:5px 12px;font-size:10px;
  letter-spacing:.12em;text-transform:uppercase;color:#7c8492;cursor:pointer}
.runtabs button.on{border-color:var(--redline);color:#e7e9ec}

.fitbtn{position:absolute;top:12px;right:12px;z-index:2;background:rgba(22,24,28,.82);border:1px solid var(--line);
  border-radius:2px;padding:6px 12px;font-size:9.5px;letter-spacing:.16em;text-transform:uppercase;
  color:#b9bfc9;cursor:pointer;backdrop-filter:blur(4px)}
.fitbtn:hover{border-color:var(--oak);color:var(--oak)}

.hint{position:absolute;bottom:8px;left:0;right:0;text-align:center;font-size:9px;letter-spacing:.14em;
  text-transform:uppercase;color:#454c58;pointer-events:none}

.tally{display:flex;align-items:center;gap:20px;padding:9px 16px;border-top:1px solid var(--line);flex:none;overflow-x:auto}
.stat{display:flex;flex-direction:column;gap:1px;white-space:nowrap}
.stat span{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#59616f}
.stat b{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;font-weight:500;color:var(--oak)}
.stat i{font-style:normal;font-size:9px;color:var(--steel);margin-left:3px}
.cutbtn{margin-left:auto;background:none;border:1px solid var(--line);border-radius:2px;padding:6px 14px;
  font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#b9bfc9;cursor:pointer;flex:none}
.cutbtn:hover{border-color:var(--oak);color:var(--oak)}

.cut{max-height:34vh;overflow:auto;border-top:1px solid var(--line);background:#101317}
.cut table{width:100%;border-collapse:collapse;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.cut th{position:sticky;top:0;background:#181c21;text-align:left;padding:7px 16px;font-size:9px;letter-spacing:.18em;
  text-transform:uppercase;color:#59616f;font-weight:600}
.cut td{padding:5px 16px;border-top:1px solid #1c2027;color:#c3c8d0}
.cut td:first-child{color:#e7e9ec;font-family:ui-sans-serif,sans-serif}
.cut td:last-child{color:var(--oak)}

@media (max-width:820px){
  .body{flex-direction:column-reverse}
  .rail{width:100%;border-right:0;border-top:1px solid var(--line);max-height:48%}
  .stage{min-height:250px}
}
`;
