export class DemoClock {
  elapsed = 0;
  running = false;
  hidden = false;
  private previous = 0;
  private revisionFloor = 0;
  update(now: number) {
    if (this.running && !this.hidden)
      this.elapsed += Math.max(0, now - this.previous);
    this.previous = now;
  }
  get phase() {
    return this.elapsed % 60000;
  }
  get stage() {
    return Math.floor(this.phase / 15000);
  }
  get revision() {
    return this.revisionFloor + Math.floor(this.elapsed / 15000) + 1;
  }
  restart(now: number) {
    this.update(now);
    this.revisionFloor = this.revision;
    this.elapsed = 0;
  }
}
