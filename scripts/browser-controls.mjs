/** Select a bearing with one actual pointer click, without intermediate redraws. */
export async function setSunAzimuth(page, angle) {
  const dial = page.getByRole("slider", { name: "Sun azimuth" });
  const box = await dial.boundingBox();
  const radians = (angle * Math.PI) / 180;
  const radius = Math.min(box.width, box.height) * 0.34;
  await dial.click({
    position: {
      x: box.width / 2 + Math.sin(radians) * radius,
      y: box.height / 2 - Math.cos(radians) * radius,
    },
  });
}
