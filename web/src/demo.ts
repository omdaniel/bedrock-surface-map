import { createElement, Play, Pause, RotateCcw, Github } from "lucide";
import { DemoClock } from "./demo-clock";
import { validateRoot, type LiveRoot } from "./terrain";
import { parseView, type PlayerView } from "./player-state";
import type { PlayerSource } from "./players";
import { boundedBytes } from "./http";
import "./demo.css";

interface Scenario {
  version: number;
  duration_ms: number;
  world_id: string;
  generation: string;
  stages: string[];
  site: number[];
  camera: number[];
  names: string[];
}
export class DemoPlayback implements PlayerSource {
  readonly clock = new DemoClock();
  private roots: LiveRoot[] = [];
  private scenario!: Scenario;
  private timer = 0;
  private sequence = 0;
  private started = Date.now();
  private controls = document.createElement("section");
  private onVisibility = () => {
    this.clock.update(performance.now());
    this.clock.hidden = document.hidden;
    this.refresh();
  };
  readonly demo = true;
  get world_id() {
    return this.scenario.world_id;
  }
  get camera() {
    return this.scenario.camera;
  }
  get paused() {
    return !this.clock.running;
  }
  async initialize(url: URL) {
    const read = async (path: URL) => {
      if (
        path.origin !== location.origin ||
        !path.pathname.startsWith(new URL(".", url).pathname)
      )
        throw Error("Demo asset escaped its directory");
      const response = await fetch(path, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error("Public demo data unavailable");
      return JSON.parse(
        new TextDecoder().decode(await boundedBytes(response, 1024 * 1024)),
      );
    };
    this.scenario = await read(url);
    const s = this.scenario;
    if (
      s.version !== 1 ||
      s.duration_ms !== 60000 ||
      s.stages?.length !== 4 ||
      s.names?.length !== 2 ||
      s.site?.length !== 3 ||
      s.camera?.length !== 3 ||
      ![...s.site, ...s.camera].every(Number.isFinite)
    )
      throw Error("Invalid demo scenario");
    for (const stage of s.stages) {
      const root = await read(new URL(stage, url));
      validateRoot(root);
      if (root.world_id !== s.world_id || root.generation !== s.generation)
        throw Error("Demo dataset mismatch");
      this.roots.push(root);
    }
    this.clock.update(performance.now());
    this.clock.hidden = document.hidden;
    return this.root();
  }
  async root(): Promise<LiveRoot> {
    this.clock.update(performance.now());
    return { ...this.roots[this.clock.stage], revision: this.clock.revision };
  }
  async sample(): Promise<PlayerView> {
    this.clock.update(performance.now());
    const seconds = Math.floor(this.clock.phase / 2000) * 2;
    const [x, y, z] = this.scenario.site;
    const players = this.scenario.names.map((name, i) => {
      const angle = (seconds / 60) * Math.PI * 2 + i * Math.PI;
      const radius = 12 + i * 7;
      return {
        id: `demo-${i}`,
        name,
        dimension: "minecraft:overworld",
        discontinuity: false,
        position: {
          x: x + Math.cos(angle) * radius,
          y,
          z: z + Math.sin(angle) * radius,
          heading: (((180 + (angle * 180) / Math.PI) % 360) + 360) % 360,
        },
      };
    });
    return parseView(
      {
        schema_version: 1,
        world_id: this.world_id,
        status: "live",
        reason: null,
        age_ms: 0,
        snapshot: {
          schema_version: 1,
          world_id: this.world_id,
          instance_id: "demo-playback",
          started_at_ms: this.started,
          sequence: ++this.sequence,
          sampled_at_ms: Date.now(),
          pack_version: "demo-1",
          players,
        },
      },
      this.world_id,
    );
  }
  mount() {
    document.body.classList.add("demo-mode");
    this.controls.className = "demo-controls";
    this.controls.setAttribute("aria-label", "Demo playback");
    this.controls.innerHTML =
      '<div><strong>Demo</strong><span>Simulated activity</span></div><button id="demo-play"></button><button id="demo-restart" title="Restart demo" aria-label="Restart demo"></button><output id="demo-time">0:00 / 1:00</output><a href="https://github.com/omdaniel/bedrock-surface-map" aria-label="View source on GitHub" title="View source on GitHub"></a>';
    document.querySelector("main")!.append(this.controls);
    this.controls.querySelector("a")!.append(createElement(Github));
    this.controls
      .querySelector("#demo-restart")!
      .append(createElement(RotateCcw));
    this.controls
      .querySelector("#demo-restart")!
      .addEventListener("click", () => {
        this.clock.restart(performance.now());
        this.refresh();
      });
    this.controls.querySelector("#demo-play")!.addEventListener("click", () => {
      this.clock.update(performance.now());
      this.clock.running = !this.clock.running;
      this.refresh();
    });
    this.clock.update(performance.now());
    this.clock.running = !matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    this.timer = window.setInterval(() => {
      if (!document.hidden) this.refresh();
    }, 500);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.refresh();
  }
  private refresh() {
    this.clock.update(performance.now());
    const button = this.controls.querySelector<HTMLButtonElement>("#demo-play");
    if (!button) return;
    const label = this.paused ? "Play demo" : "Pause demo";
    if (button.title !== label) {
      button.title = label;
      button.setAttribute("aria-label", label);
      button.replaceChildren(createElement(this.paused ? Play : Pause));
    }
    this.controls.querySelector("output")!.textContent =
      `0:${String(Math.floor(this.clock.phase / 1000)).padStart(2, "0")} / 1:00`;
  }
  destroy() {
    document.body.classList.remove("demo-mode");
    clearInterval(this.timer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.controls.remove();
  }
}
