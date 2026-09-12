/** Set the cyclic dial through its public keyboard behavior, not private state. */
export async function setSunAzimuth(page, angle) {
  const dial = page.getByRole("slider", { name: "Sun azimuth" });
  await dial.press("Home");
  const bearing = ((angle % 360) + 360) % 360;
  const delta = bearing > 180 ? bearing - 360 : bearing;
  for (let i = 0; i < Math.floor(Math.abs(delta) / 15); i++)
    await dial.press(delta < 0 ? "PageDown" : "PageUp");
  for (let i = 0; i < Math.abs(delta) % 15; i++)
    await dial.press(delta < 0 ? "ArrowLeft" : "ArrowRight");
}
