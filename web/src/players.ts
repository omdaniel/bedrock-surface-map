import {
  createElement,
  Users,
  Navigation,
  LocateFixed,
  Eye,
  EyeOff,
  X,
} from "lucide";
import {
  binding,
  parseView,
  PlayerState,
  project,
  readJsonBounded,
} from "./player-state";
import type {
  Camera,
  LivePlayer,
  PlayerBinding,
  PlayerPosition,
} from "./player-state";
import "./players.css";

interface Options {
  main: HTMLElement;
  nav: HTMLElement;
  camera: () => Camera;
  center: (x: number, z: number, zoom: boolean) => void;
  covered: (x: number, z: number) => boolean;
}
interface Entry {
  player: LivePlayer;
  marker: HTMLButtonElement;
  label: HTMLElement;
  arrow: SVGElement;
  row: HTMLElement;
  name: HTMLButtonElement;
  detail: HTMLElement;
  follow: HTMLButtonElement;
  from: PlayerPosition | null;
  started: number;
}
function iconButton(label: string, icon: typeof Users) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(createElement(icon));
  return button;
}
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
export class PlayerLayer {
  private readonly options: Options;
  private readonly state = new PlayerState();
  private readonly entries = new Map<string, Entry>();
  private readonly button = iconButton("Players", Users);
  private readonly count = document.createElement("span");
  private readonly panel = document.createElement("section");
  private readonly list = document.createElement("div");
  private readonly status = document.createElement("p");
  private readonly overlay = document.createElement("div");
  private readonly visibility = iconButton("Hide player markers", Eye);
  private configuration: PlayerBinding | null = null;
  private pollTimer = 0;
  private ageTimer = 0;
  private animation = 0;
  private request: AbortController | null = null;
  private stopped = false;
  private selected = "";
  private following = "";
  private markersVisible = true;
  private failures = 0;
  private message = "Tracking not configured";
  private snapshotKey = "";
  private readonly onVisibility = () => {
    clearTimeout(this.pollTimer);
    if (document.hidden) {
      this.request?.abort();
      cancelAnimationFrame(this.animation);
      this.animation = 0;
    } else {
      this.age();
      if (!this.request) void this.poll();
    }
  };
  constructor(options: Options) {
    this.options = options;
    this.button.id = "players-toggle";
    this.button.setAttribute("aria-expanded", "false");
    this.button.setAttribute("aria-controls", "players-panel");
    this.count.className = "players-count";
    this.count.textContent = "";
    this.button.append(this.count);
    options.nav.append(this.button);
    this.overlay.id = "player-markers";
    this.overlay.setAttribute("aria-label", "Player positions");
    this.panel.id = "players-panel";
    this.panel.setAttribute("aria-label", "Players");
    this.panel.hidden = true;
    const header = document.createElement("div");
    header.className = "players-heading";
    const title = document.createElement("strong");
    title.textContent = "Players";
    const close = iconButton("Close players", X);
    close.onclick = () => this.toggle(false);
    this.visibility.setAttribute("aria-pressed", "true");
    this.visibility.onclick = () => {
      this.markersVisible = !this.markersVisible;
      this.visibility.setAttribute("aria-pressed", String(this.markersVisible));
      const label = this.markersVisible
        ? "Hide player markers"
        : "Show player markers";
      this.visibility.title = label;
      this.visibility.setAttribute("aria-label", label);
      this.visibility.replaceChildren(
        createElement(this.markersVisible ? Eye : EyeOff),
      );
      this.project();
    };
    header.append(title, this.visibility, close);
    this.status.className = "players-status";
    this.status.setAttribute("role", "status");
    this.status.textContent = this.message;
    this.list.className = "players-list";
    this.panel.append(header, this.status, this.list);
    options.main.append(this.overlay, this.panel);
    this.button.onclick = () => this.toggle(this.panel.hidden);
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.toggle(false);
        this.button.focus();
      }
    });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.ageTimer = window.setInterval(() => {
      if (!document.hidden) this.age();
    }, 1000);
  }
  private toggle(show: boolean) {
    this.panel.hidden = !show;
    this.button.setAttribute("aria-expanded", String(show));
    if (show)
      for (const id of ["lighting", "diagnostics"]) {
        const panel = document.getElementById(id);
        if (panel) panel.hidden = true;
        document
          .getElementById(id === "lighting" ? "lighting-toggle" : "stats")
          ?.setAttribute(
            id === "lighting" ? "aria-expanded" : "aria-pressed",
            "false",
          );
      }
  }
  close() {
    this.toggle(false);
  }
  async configure(fingerprint: string) {
    try {
      const response = await fetch("/viewer-config.json", {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        if (response.status === 404) return;
        throw Error("Configuration unavailable");
      }
      this.configuration = binding(
        await readJsonBounded(response),
        fingerprint,
      );
      if (!this.configuration) {
        this.message = "No live feed for this snapshot";
        this.age();
        return;
      }
      this.message = "Connecting to tracker";
      void this.poll();
    } catch {
      this.message = "Tracking configuration unavailable";
      this.age();
    }
  }
  private async poll() {
    if (!this.configuration || this.stopped || document.hidden || this.request)
      return;
    const controller = new AbortController();
    this.request = controller;
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    const started = performance.now();
    try {
      const response = await fetch(this.configuration.url, {
        cache: "no-store",
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) throw Error("Player endpoint unavailable");
      const view = parseView(
        await readJsonBounded(response),
        this.configuration.world_id,
      );
      if (view.age_ms !== null) view.age_ms += performance.now() - started;
      this.state.accept(view, performance.now());
      this.failures = 0;
      this.message = "";
      const key = view.snapshot
        ? `${view.snapshot.instance_id}:${view.snapshot.sequence}`
        : "";
      if (key !== this.snapshotKey) {
        this.snapshotKey = key;
        this.reconcile();
      }
    } catch {
      if (!this.stopped && !document.hidden) {
        this.failures++;
        this.message = "Tracker unreachable";
      }
    } finally {
      clearTimeout(timeout);
      this.request = null;
      this.age();
      if (!this.stopped && !document.hidden)
        this.pollTimer = window.setTimeout(
          () => void this.poll(),
          Math.min(30000, 2000 * 2 ** Math.min(this.failures, 4)),
        );
    }
  }
  private entry(p: LivePlayer): Entry {
    const marker = iconButton(p.name, Navigation);
    marker.className = "player-marker";
    marker.dataset.playerId = p.id;
    const arrow = marker.querySelector("svg")!;
    const label = document.createElement("span");
    label.className = "player-label";
    label.textContent = p.name;
    marker.append(label);
    const hue = [...p.name].reduce(
      (n, c) => (n * 31 + c.charCodeAt(0)) % 360,
      0,
    );
    marker.style.setProperty("--player-color", `hsl(${hue} 68% 73%)`);
    const row = document.createElement("div");
    row.className = "player-row";
    row.dataset.playerId = p.id;
    const name = document.createElement("button");
    name.className = "player-name";
    const text = document.createElement("bdi");
    text.textContent = p.name;
    const detail = document.createElement("span");
    detail.className = "player-detail";
    name.append(text, detail);
    const follow = iconButton(`Follow ${p.name}`, LocateFixed);
    follow.className = "player-follow";
    row.append(name, follow);
    this.list.append(row);
    this.overlay.append(marker);
    const e = {
      player: p,
      marker,
      label,
      arrow,
      row,
      name,
      detail,
      follow,
      from: null,
      started: 0,
    };
    marker.onclick = () => {
      this.selected = p.id;
      this.toggle(true);
      this.reconcileSelection();
    };
    name.onclick = () => {
      this.selected = p.id;
      this.following = "";
      this.reconcileSelection();
      const position = e.player.position;
      if (position && e.player.dimension === "minecraft:overworld")
        this.options.center(position.x, position.z, true);
    };
    follow.onclick = () => {
      this.selected = p.id;
      this.following = this.following === p.id ? "" : p.id;
      this.reconcileSelection();
      const pos = e.player.position;
      if (pos && this.following) this.options.center(pos.x, pos.z, true);
    };
    return e;
  }
  private reconcile() {
    const now = performance.now();
    this.state.status(now);
    const players = this.state.view?.snapshot?.players ?? [];
    const ids = new Set(players.map((p) => p.id));
    for (const [id, e] of this.entries)
      if (!ids.has(id)) {
        e.marker.remove();
        e.row.remove();
        this.entries.delete(id);
      }
    if (!ids.has(this.selected)) this.selected = "";
    if (!ids.has(this.following)) this.following = "";
    for (const p of players) {
      let e = this.entries.get(p.id);
      if (!e) {
        e = this.entry(p);
        this.entries.set(p.id, e);
      }
      const old = this.position(e, now),
        before = e.player;
      const smooth =
        !reduced() &&
        !p.discontinuity &&
        old &&
        p.position &&
        before.dimension === p.dimension &&
        now - e.started <= 6000 &&
        Math.hypot(p.position.x - old.x, p.position.z - old.z) <= 32;
      e.from = smooth ? old : null;
      e.started = now;
      e.player = p;
      e.label.textContent = p.name;
      e.name.querySelector("bdi")!.textContent = p.name;
      e.marker.title = p.name;
      e.marker.setAttribute("aria-label", p.name);
      e.name.setAttribute("aria-label", `Center on ${p.name}`);
      e.follow.title = `Follow ${p.name}`;
      e.follow.setAttribute("aria-label", `Follow ${p.name}`);
      const dim =
        p.dimension?.replace("minecraft:", "").replaceAll("_", " ") ??
        "unknown dimension";
      const pos = p.position;
      e.detail.textContent = pos
        ? `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)} / ${dim}${p.dimension === "minecraft:overworld" && !this.options.covered(pos.x, pos.z) ? " / outside mapped terrain" : ""}`
        : "Position unavailable";
      e.follow.disabled = !pos || p.dimension !== "minecraft:overworld";
      e.name.disabled = !pos || p.dimension !== "minecraft:overworld";
      if (e.follow.disabled && this.following === p.id) this.following = "";
    }
    this.reconcileSelection();
    this.project();
    this.animate();
  }
  private position(e: Entry, now: number) {
    const to = e.player.position;
    if (!to || !e.from) return to;
    const t = Math.min(1, Math.max(0, (now - e.started) / 250));
    const turn = ((to.heading - e.from.heading + 540) % 360) - 180;
    return {
      x: e.from.x + (to.x - e.from.x) * t,
      y: to.y,
      z: e.from.z + (to.z - e.from.z) * t,
      heading: e.from.heading + turn * t,
    };
  }
  private animate() {
    if (this.animation || this.stopped || document.hidden) return;
    const step = () => {
      this.animation = 0;
      if (this.stopped || document.hidden) return;
      const now = performance.now();
      const e = this.entries.get(this.following);
      if (e?.player.position && this.state.status(now) === "live") {
        const p = this.position(e, now)!;
        this.options.center(p.x, p.z, false);
      }
      this.project();
      if (
        [...this.entries.values()].some((e) => e.from && now - e.started < 250)
      )
        this.animation = requestAnimationFrame(step);
    };
    this.animation = requestAnimationFrame(step);
  }
  private reconcileSelection() {
    for (const [id, e] of this.entries) {
      e.name.setAttribute("aria-pressed", String(id === this.selected));
      e.follow.setAttribute("aria-pressed", String(id === this.following));
      e.marker.classList.toggle("selected", id === this.selected);
    }
  }
  manualNavigation() {
    this.following = "";
    this.reconcileSelection();
  }
  project() {
    const camera = this.options.camera(),
      now = performance.now();
    const occupied: { x: number; y: number; w: number }[] = [];
    const entries = [...this.entries.values()].sort(
      (a, b) =>
        Number(b.player.id === this.selected) -
        Number(a.player.id === this.selected),
    );
    for (const e of entries) {
      const pos = this.position(e, now),
        point = pos ? project(pos, camera) : null;
      const visible =
        this.markersVisible &&
        point &&
        e.player.dimension === "minecraft:overworld" &&
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= camera.width &&
        point.y <= camera.height;
      e.marker.hidden = !visible;
      if (!point || !pos || !visible) continue;
      e.marker.style.transform = `translate(${point.x}px,${point.y}px)`;
      e.arrow.style.transform = `rotate(${pos.heading - 45}deg)`;
      const w = Math.min(180, e.player.name.length * 8 + 18);
      const box = {
        x: Math.max(0, Math.min(camera.width - w, point.x - w / 2)),
        y: point.y + 18,
        w,
      };
      e.label.style.left = `${box.x - point.x + 18}px`;
      const collision = occupied.some(
        (b) =>
          box.x < b.x + b.w && box.x + w > b.x && Math.abs(box.y - b.y) < 25,
      );
      e.label.hidden = collision && e.player.id !== this.selected;
      if (!e.label.hidden) occupied.push(box);
    }
  }
  private age() {
    if (this.stopped) return;
    const now = performance.now(),
      status = this.state.status(now),
      age = this.state.age(now);
    if (
      (status === "unavailable" ||
        status === "disabled" ||
        status === "starting") &&
      this.entries.size
    )
      this.reconcile();
    const count = this.state.view?.snapshot?.players.length;
    this.count.textContent = count === undefined ? "" : String(count);
    const message = !this.configuration
      ? this.message
      : status === "live"
        ? `${count ?? 0} online${this.message ? " / reconnecting" : ""}`
        : status === "stale"
          ? `Stale positions / ${Math.floor((age ?? 0) / 1000)}s old`
          : status === "disabled"
            ? "Tracking disabled for compatibility"
            : status === "unavailable"
              ? "Player positions unavailable"
              : this.message || "Waiting for server samples";
    if (this.status.textContent !== message) this.status.textContent = message;
    this.overlay.classList.toggle("stale", status === "stale");
    if (status !== "live") this.manualNavigation();
    if (document.hidden) return;
    this.project();
  }
  destroy() {
    this.stopped = true;
    this.request?.abort();
    clearTimeout(this.pollTimer);
    clearInterval(this.ageTimer);
    cancelAnimationFrame(this.animation);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }
}
