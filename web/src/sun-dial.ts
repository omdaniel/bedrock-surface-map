/** A cyclic compass bearing, in whole degrees clockwise from north. */
export function bindSunDial(
  dial: HTMLElement,
  output: HTMLOutputElement,
  initial: number,
  onChange: (azimuthDegrees: number) => void,
) {
  let value = initial;
  let pointer: number | null = null;
  const update = (degrees: number, notify = true) => {
    const next = ((Math.round(degrees) % 360) + 360) % 360;
    const changed = next !== value;
    value = next;
    dial.style.setProperty("--bearing", `${value}deg`);
    dial.setAttribute("aria-valuenow", String(value));
    dial.setAttribute(
      "aria-valuetext",
      `${value} degrees clockwise from north`,
    );
    output.value = `${value}\u00b0`;
    if (notify && changed) onChange(value);
  };
  const point = (event: PointerEvent) => {
    const box = dial.getBoundingClientRect();
    const east = event.clientX - (box.left + box.width / 2);
    const north = box.top + box.height / 2 - event.clientY;
    // The bearing is undefined at the center; retain it until outside the hub.
    if (Math.hypot(east, north) < 8) return;
    update((Math.atan2(east, north) * 180) / Math.PI);
  };
  dial.onpointerdown = (event) => {
    if (!event.isPrimary || event.button !== 0 || pointer !== null) return;
    event.preventDefault();
    dial.focus({ preventScroll: true });
    pointer = event.pointerId;
    dial.setPointerCapture(pointer);
    dial.classList.add("dragging");
    point(event);
  };
  dial.onpointermove = (event) => {
    if (event.pointerId === pointer) point(event);
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    dial.classList.remove("dragging");
    if (dial.hasPointerCapture(event.pointerId))
      dial.releasePointerCapture(event.pointerId);
  };
  dial.onpointerup = end;
  dial.onpointercancel = end;
  dial.onlostpointercapture = end;
  dial.onkeydown = (event) => {
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = value + 1;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = value - 1;
        break;
      case "PageUp":
        next = value + 15;
        break;
      case "PageDown":
        next = value - 15;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 359;
        break;
      default:
        return;
    }
    event.preventDefault();
    update(next);
  };
  update(initial, false);
}
